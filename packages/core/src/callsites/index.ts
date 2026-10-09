import type { parseSync as ParseSync } from 'oxc-parser';
import { confidenceForKind } from '../merge/confidence.js';
import type { Confidence, Signal, SourceLocation } from '../types.js';
import { LineIndex } from '../util/line-index.js';
import { type HostResolution, MAX_DEPTH, hostFromUrlPrefix } from './resolve-host.js';
import {
  type CalleeShape,
  SINKS,
  type SinkDefinition,
  type SinkKind,
  findSink,
  findSinks,
  sinkKind,
} from './sinks.js';

/**
 * The native parser, loaded at module evaluation and allowed to be absent.
 *
 * `oxc-parser` is a native addon: it ships a platform-specific `.node` binary
 * through optional dependencies, and on a platform with no matching prebuild it
 * fails. A *static* `import` of it cannot be guarded, because ESM resolves and
 * links every static import before any code in the module runs -- the failure
 * arrives as a SyntaxError at link time, which no try/catch in this program can
 * see. A top-level `await import()` can be guarded, and costs nothing at run
 * time because the result is bound once here.
 *
 * Callers stay synchronous: top-level await makes this module async to *load*,
 * which every ESM importer already handles, so `analyzeFile` and `scan` keep
 * their signatures.
 */
let parseSync: typeof ParseSync | null = null;
try {
  ({ parseSync } = await import('oxc-parser'));
} catch {
  // No prebuilt binding for this platform. Call-site analysis is unavailable;
  // `scan()` reports engine.degraded so the gap is visible rather than silent.
  parseSync = null;
}

/** Whether call-site analysis can run at all in this process. */
export function parserAvailable(): boolean {
  return parseSync !== null;
}

export * from './resolve-host.js';
export * from './sinks.js';

/** A minimal structural view of the ESTree nodes we care about. */
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface CallsiteHit {
  /**
   * What this hit proves: `callsite` that data left here, `reference` only
   * that a vendor is named here. See `SinkKind`.
   */
  kind: SinkKind;
  /** Resolved host, or null when the destination could not be determined. */
  host: string | null;
  /** Region identifier read from a config literal, verbatim. */
  region?: string;
  /** Vendor this hit is attributed to, when the sink itself named one. */
  vendorId?: string;
  /** Populated when host is null: why it could not be resolved. */
  unresolvedReason?: string;
  location: SourceLocation;
  snippet: string;
  confidence: Confidence;
  matchedOn: string;
}

export interface AnalyzeFileResult {
  hits: CallsiteHit[];
  error?: string;
}

/** What a module-scope binding resolved to. */
type BindingValue =
  | { kind: 'string'; value: string }
  | { kind: 'env'; name: string }
  | { kind: 'client'; host: string | null; reason?: string; allowAbsolute: AllowAbsolute }
  /**
   * `const u = new URL('https://...')`: a constructed reference object whose
   * destination is known. `start` is the offset of the `new` expression, so a
   * call that later consumes the binding can suppress the reference hit the
   * construction itself emitted.
   */
  | { kind: 'reference'; host: string; start: number; via: string };

/** A binding plus where it was declared, so a call above it cannot read it. */
type Binding = BindingValue & { declaredAt: number };

/**
 * What a call site is allowed to assume about the names around it.
 *
 * Binding collection is keyed on the bare name, with no scope chain -- building
 * one would mean implementing lexical scoping over the whole ESTree grammar for
 * the sake of a constant fold. The cheaper and safer move is to refuse: a name
 * that is declared twice, or assigned after its declaration, is recorded as
 * unstable and never resolves. That trades recall for the property the module
 * exists to protect, which is that a resolved host is right.
 */
interface ResolveContext {
  /** Names that must not resolve, mapped to why. */
  unstable: Map<string, string>;
  /** Offset of the call being resolved; a binding declared later is not in scope. */
  callStart: number;
  /**
   * Start offsets of `new URL(...)` / `new Request(...)` nodes this resolution
   * read through.
   *
   * `fetch(new Request(URL))` is one transfer written as two expressions. The
   * outer sink is the one that proves it, so the inner construction must not
   * also be reported: the reviewer's complaint was volume, and emitting a
   * reference beside the call site it feeds is pure duplication. Recorded
   * here and suppressed by the caller.
   *
   * Suppression cannot rely on walk order. Directly nested, the parent is
   * visited before its child; through a binding -- `const u = new URL(X)`
   * then `fetch(u.toString())` -- the construction is several statements
   * *earlier* and has already been emitted. So the caller records the offsets
   * and filters the emitted list once the walk is done.
   */
  referencesRead?: number[];
}

/**
 * Finds outbound call sites in one file and resolves their destination host
 * where that is possible without guessing.
 *
 * Analysis is intraprocedural and single-file by design. Following imports
 * would require resolving the module graph, which in turn wants `node_modules`
 * on disk -- and the scanner's offline, works-on-a-fresh-clone property is
 * worth more than the extra recall. Cross-module constants are a documented
 * limitation with a failing-by-design test, not an oversight.
 */
export function analyzeFile(
  text: string,
  filePath: string,
  extraSinks: SinkDefinition[] = [],
): AnalyzeFileResult {
  if (parseSync === null) {
    return { hits: [], error: 'native parser unavailable on this platform' };
  }
  let program: Node;
  try {
    const parsed = parseSync(filePath, text);
    if (parsed.errors.length > 0 && !parsed.program) {
      return { hits: [], error: parsed.errors[0]?.message ?? 'parse error' };
    }
    program = parsed.program as unknown as Node;
  } catch (error) {
    return { hits: [], error: (error as Error).message };
  }

  const index = new LineIndex(text);
  const bindings = new Map<string, Binding>();
  const unstable = collectUnstableNames(program);
  const sinks = extraSinks.length > 0 ? [...SINKS, ...extraSinks] : SINKS;
  // Hits paired with the offset of the node that produced them, so a reference
  // a later call site turns out to consume can be dropped after the walk.
  const emitted: { start: number; hit: CallsiteHit }[] = [];
  const emit = (node: Node, hit: CallsiteHit): void => {
    emitted.push({ start: node.start, hit });
  };
  // Reference constructions already accounted for by an enclosing or later
  // call sink.
  const consumedReferences = new Set<number>();

  // Pass 1: collect module-scope constant and client bindings, so a call site
  // later in the file can resolve an identifier declared earlier.
  //
  // Only module scope is collected. A declaration inside a function or block is
  // not visible to a call at the top level, and treating it as visible is how a
  // shadowed name produces a confident wrong host.
  for (const node of moduleScopeDeclarators(program)) {
    const id = node.id as Node | undefined;
    const init = node.init as Node | undefined;
    if (!id || id.type !== 'Identifier' || !init) continue;
    const name = String(id.name);
    if (unstable.has(name)) continue;
    const context: ResolveContext = { unstable, callStart: node.start };

    const client = clientBindingFor(init, bindings, context);
    if (client) {
      bindings.set(name, { ...client, declaredAt: node.start });
      continue;
    }
    const reference = referenceBindingFor(init, bindings, context);
    if (reference) {
      bindings.set(name, { ...reference, declaredAt: node.start });
      continue;
    }
    // `const B = A` aliases an earlier binding, which is how a two-step
    // constant chain resolves.
    if (init.type === 'Identifier') {
      const aliased = bindings.get(String(init.name));
      if (aliased) bindings.set(name, { ...aliased, declaredAt: node.start });
      continue;
    }

    const literal = literalBindingFor(init);
    if (literal) bindings.set(name, { ...literal, declaredAt: node.start });
  }

  // Writes to `<client>.defaults.<key>` anywhere in the file, which change
  // what an axios request joins.
  const defaultsWrites = collectDefaultsWrites(program);

  // Pass 2: find sinks and resolve their destination.
  walk(program, (node) => {
    const isNew = node.type === 'NewExpression';
    if (node.type !== 'CallExpression' && !isNew) return;
    // `fetch(new Request(X))`: the outer sink already reported this node.
    if (consumedReferences.has(node.start)) return;

    const callee = node.callee as Node | undefined;
    if (!callee) return;
    const shape = calleeShape(callee);
    const args = (node.arguments as Node[] | undefined) ?? [];

    const context: ResolveContext = { unstable, callStart: node.start, referencesRead: [] };

    // A request through axios, where a base URL and the request URL can both
    // name a destination: `const api = axios.create({ baseURL: X })` then
    // `api.get(Y)`, or `axios({ baseURL: X, url: Y })`. Which one wins is
    // axios's rule, not ours -- see `resolveAxiosRequest`.
    const binding =
      callee.type === 'MemberExpression' && shape.object
        ? readable(bindings, shape.object, unstable, node.start)
        : null;
    const onClient = binding?.kind === 'client';
    const direct = isNew ? null : directAxiosMethod(shape);
    // `api.getUri()` builds a string and `api.create()` makes another client;
    // neither sends anything.
    if (onClient && AXIOS_NON_REQUEST_METHODS.has(shape.property ?? '')) return;
    if (onClient || direct) {
      const request = axiosRequest(onClient ? (shape.property ?? '') : (direct ?? ''), args);
      const clientName = onClient ? (shape.object ?? '') : null;
      const clientDefaults = clientName === null ? undefined : defaultsWrites.get(clientName);
      const inherited: AxiosBase | null = !onClient
        ? null
        : {
            resolution: overridesBase(clientDefaults)
              ? {
                  kind: 'unresolved',
                  reason: `base URL is reassigned through ${clientName}.defaults`,
                }
              : binding.host
                ? { kind: 'resolved', host: binding.host }
                : {
                    kind: 'unresolved',
                    reason: binding.reason ?? 'client base URL not resolvable',
                  },
            atCall: false,
          };
      const base = requestBase(request.config, inherited, bindings, context);
      // A write to `axios.defaults` or `api.defaults` anywhere in the file can
      // change `allowAbsoluteUrls` for this request; where it happens relative
      // to the client's creation is not followed.
      const written = [clientDefaults, defaultsWrites.get('axios')].find(overridesAllowAbsolute);
      const allowAbsolute = allowAbsoluteFrom(
        request.config,
        written
          ? {
              reason: `allowAbsoluteUrls is written through ${written === clientDefaults ? clientName : 'axios'}.defaults, so the request URL may or may not replace the base URL`,
            }
          : onClient
            ? binding.allowAbsolute
            : true,
      );
      const { resolution, fromBase } = resolveAxiosRequest(
        request.url,
        base,
        allowAbsolute,
        bindings,
        context,
      );
      if (resolution.kind !== 'not-a-url') {
        // A host joined from a client's base URL was read through a binding,
        // not at the call, and says so.
        const confidence = fromBase && base && !base.atCall ? 'medium' : 'high';
        emit(node, toHit(resolution, node, index, filePath, confidence, 'callsite'));
        if (resolution.kind === 'resolved') {
          for (const start of context.referencesRead ?? []) consumedReferences.add(start);
        }
        return;
      }
      // An absolute URL that does not parse sends nothing. A direct call falls
      // through only to the knowledge base sinks, which read option names
      // axios does not have; the axios rows themselves are not consulted
      // again, since they read `url` and `baseURL` without axios's rule.
      if (onClient) return;
    }

    // Several sinks can match one call. Try each until one yields a
    // destination, so a name shared by two vendors cannot shadow the other.
    for (const sink of findSinks(shape, isNew, sinks)) {
      if (direct && isAxiosSink(sink)) continue;
      const configKeys = sink.configKeys ?? [];

      if (sink.anyArg) {
        // Knowledge base constructors carry the destination at a position that
        // varies by SDK, so every argument is tried and only a *resolved* host
        // counts. `posthog.init(KEY, { api_host })` would otherwise stop at the
        // key and report "host supplied by environment variable POSTHOG_KEY" --
        // naming a credential as though it were a destination. Where no argument
        // resolves, nothing is emitted: the SDK is already reported through its
        // dependency signal, so silence here loses no vendor.
        for (const argument of args) {
          if (!argument) continue;
          // A catch-all sink is selected by its option, so it reads only
          // config objects; a bare URL argument to an arbitrary function is
          // not a call site.
          if (sink.matchAny && argument.type !== 'ObjectExpression') continue;
          if (context.referencesRead) context.referencesRead.length = 0;
          const resolution = resolveArgument(argument, configKeys, bindings, 0, context);
          if (resolution.kind !== 'resolved') continue;
          const hitKind = sinkKind(sink);
          const hit = toHit(resolution, node, index, filePath, 'high', hitKind);
          const withRegion = regionFromArguments(args, sink.regionKeys ?? [], bindings, context);
          if (withRegion) hit.region = withRegion;
          if (sink.vendorId) hit.vendorId = sink.vendorId;
          emit(node, hit);
          // `createClient(new URL(X))` is the same one transfer as
          // `fetch(new URL(X))`, and is deduplicated the same way.
          if (hitKind === 'callsite') {
            for (const start of context.referencesRead ?? []) consumedReferences.add(start);
          }
          return;
        }

        // No host resolved. A sink named by its own export still identifies a
        // vendor, so a region alone is enough -- `new S3Client({ region })`
        // names a jurisdiction and no host at all. A catch-all sink matches
        // any call and must never do this.
        const regionOnly = sink.vendorId
          ? regionFromArguments(args, sink.regionKeys ?? [], bindings, context)
          : null;
        if (regionOnly && sink.vendorId) {
          const location = index.locationAt(filePath, node.start, node.end - node.start);
          emit(node, {
            kind: sinkKind(sink),
            host: null,
            region: regionOnly,
            vendorId: sink.vendorId,
            location,
            snippet: index.snippetAt(node.start),
            confidence: 'high',
            matchedOn: regionOnly,
          });
          return;
        }
        continue;
      }

      const argument = args[sink.argIndex];
      if (!argument) continue;
      const kind = sinkKind(sink);
      if (context.referencesRead) context.referencesRead.length = 0;
      const resolution = resolveArgument(argument, configKeys, bindings, 0, context);
      if (resolution.kind === 'not-a-url') continue;
      // A reference sink emits only on a RESOLVED host, and is otherwise
      // silent. `transfer/unresolved-egress` says "something left here and we
      // cannot say where"; for `new URL(request.url)` or
      // `new URL(connectionString)` neither half is true, and those two shapes
      // were the bulk of the noise an external reviewer reported. This is the
      // same rule a knowledge base sink already follows, for the same reason.
      if (kind === 'reference' && resolution.kind !== 'resolved') continue;
      emit(node, toHit(resolution, node, index, filePath, 'high', kind));
      if (kind === 'callsite') {
        for (const start of context.referencesRead ?? []) consumedReferences.add(start);
      }
      return;
    }
  });

  // Drop every reference a call site turned out to consume. Doing this after
  // the walk rather than during it is what makes the indirect shapes work:
  // `const u = new URL(X)` is emitted long before the `fetch(u.toString())`
  // that proves the transfer, so it cannot be skipped on the way past.
  const hits = emitted
    .filter(({ start, hit }) => !(hit.kind === 'reference' && consumedReferences.has(start)))
    .map(({ hit }) => hit);

  return { hits };
}

/**
 * A region identifier from a config object, or null.
 *
 * Only a string literal, or a module-scope constant that survived the
 * stability check. `region: process.env.AWS_REGION` and `` `eu-${zone}` ``
 * yield nothing: a region that is assembled at deploy time is not a fact about
 * this repository, and reporting a guess about where data lands is worse than
 * reporting nothing. The caller then leaves the exposure unnarrowed.
 */
function regionFromArguments(
  args: Node[],
  regionKeys: string[],
  bindings: Map<string, Binding>,
  context: ResolveContext,
): string | null {
  if (regionKeys.length === 0) return null;
  for (const argument of args) {
    if (!argument || argument.type !== 'ObjectExpression') continue;
    for (const property of (argument.properties as Node[] | undefined) ?? []) {
      const key = property.key as Node | undefined;
      const value = property.value as Node | undefined;
      const name = key ? String(key.name ?? (key as { value?: string }).value ?? '') : '';
      if (!value || !regionKeys.includes(name)) continue;

      if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
      if (value.type === 'Identifier') {
        const bindingName = String(value.name);
        if (context.unstable.has(bindingName)) return null;
        const binding = bindings.get(bindingName);
        if (!binding || binding.kind !== 'string') return null;
        if (binding.declaredAt > context.callStart) return null;
        return binding.value;
      }
      return null;
    }
  }
  return null;
}

function toHit(
  resolution: HostResolution,
  node: Node,
  index: LineIndex,
  filePath: string,
  confidence: Confidence,
  kind: SinkKind,
): CallsiteHit {
  const location = index.locationAt(filePath, node.start, node.end - node.start);
  const snippet = index.snippetAt(node.start);
  if (resolution.kind === 'resolved') {
    return {
      kind,
      host: resolution.host,
      location,
      snippet,
      // A reference is capped below a call site: certainty about the string is
      // not certainty that a transfer happened.
      confidence: confidenceForKind(kind, confidence),
      matchedOn: resolution.host,
    };
  }
  const reason = resolution.kind === 'unresolved' ? resolution.reason : 'not a URL';
  return {
    kind,
    host: null,
    unresolvedReason: reason,
    location,
    snippet,
    // An unresolved destination is a prompt to look, never an attribution.
    confidence: 'low',
    matchedOn: reason,
  };
}

function resolveArgument(
  node: Node,
  configKeys: string[],
  bindings: Map<string, Binding>,
  depth: number,
  context: ResolveContext,
): HostResolution {
  if (depth > MAX_DEPTH) {
    return { kind: 'unresolved', reason: 'constant chain too deep to resolve' };
  }

  switch (node.type) {
    // TypeScript and grouping wrappers carry no meaning for host resolution.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSInstantiationExpression':
    case 'ParenthesizedExpression': {
      const inner = node.expression as Node | undefined;
      return inner
        ? resolveArgument(inner, configKeys, bindings, depth + 1, context)
        : { kind: 'not-a-url' };
    }

    case 'Literal': {
      const value = node.value;
      return typeof value === 'string' ? hostFromUrlPrefix(value, false) : { kind: 'not-a-url' };
    }

    // Both fold their leading static text -- literals, template chunks and
    // stable module-scope strings -- and read the authority from the folded
    // text once. Reading it from one piece alone is how `B + '.evil.example'`
    // used to resolve to whatever vendor `B` named: the piece looked complete
    // only because what followed it was never looked at.
    case 'TemplateLiteral': {
      const lead = leadingStatic(node, bindings, context);
      if (lead.text === '' && lead.head) {
        // `${base}/v1/charges` -- the destination is built at runtime. Name
        // the variable when it can be named; never resolve through a client
        // or reference binding with something appended to it.
        const mark = context.referencesRead?.length ?? 0;
        const head = resolveArgument(lead.head, configKeys, bindings, depth + 1, context);
        // The head's result is discarded, so nothing it read was consumed.
        if (context.referencesRead) context.referencesRead.length = mark;
        return head.kind === 'unresolved'
          ? head
          : { kind: 'unresolved', reason: 'URL is built from an interpolated value' };
      }
      return hostFromUrlPrefix(lead.text, !lead.complete);
    }

    case 'Identifier': {
      const name = String(node.name);
      if (context.unstable.has(name)) {
        return { kind: 'unresolved', reason: context.unstable.get(name) ?? 'not resolvable' };
      }
      const binding = bindings.get(name);
      if (binding && binding.declaredAt > context.callStart) {
        return { kind: 'unresolved', reason: `${name} is used before it is declared` };
      }
      if (!binding) {
        return {
          kind: 'unresolved',
          reason: `value of ${name} is not known statically`,
        };
      }
      if (binding.kind === 'env') {
        return {
          kind: 'unresolved',
          reason: `host supplied by environment variable ${binding.name}`,
        };
      }
      if (binding.kind === 'client') {
        return binding.host
          ? { kind: 'resolved', host: binding.host }
          : { kind: 'unresolved', reason: binding.reason ?? 'client base URL not resolvable' };
      }
      // `const req = new Request(X); fetch(req)`. The construction is the
      // destination; the call is what proves it left.
      if (binding.kind === 'reference') {
        context.referencesRead?.push(binding.start);
        return { kind: 'resolved', host: binding.host };
      }
      return hostFromUrlPrefix(binding.value, false);
    }

    // `fetch(new Request(url))` and `fetch(new URL(url))`. The constructed
    // object *is* the outer call's destination, so the outer sink resolves
    // through it -- and the inner construction is then recorded as consumed,
    // so one transfer is reported once.
    case 'NewExpression': {
      const viaReference = referenceObjectHost(node, configKeys, bindings, depth, context);
      return viaReference ?? { kind: 'not-a-url' };
    }

    // `fetch(new URL(X).toString())` and `fetch(u.toJSON())`. A method that
    // renders the reference back to its string is the same destination the
    // constructor was handed, so the outer sink resolves through it and
    // consumes the construction.
    case 'CallExpression': {
      const viaReference = referenceMethodHost(node, configKeys, bindings, depth, context);
      return viaReference ?? { kind: 'not-a-url' };
    }

    case 'MemberExpression': {
      // `fetch(new URL(X).href)` and `fetch(u.href)`. Only `href`: nothing
      // else on a URL is the whole destination, and reading `searchParams` or
      // `pathname` as one would be a guess.
      const viaReference = referencePropertyHost(node, configKeys, bindings, depth, context);
      if (viaReference) return viaReference;
      const env = envVarName(node);
      return env
        ? { kind: 'unresolved', reason: `host supplied by environment variable ${env}` }
        : { kind: 'unresolved', reason: 'host is computed at runtime' };
    }

    case 'BinaryExpression': {
      if (node.operator !== '+') return { kind: 'not-a-url' };
      const lead = leadingStatic(node, bindings, context);
      if (lead.text === '' && lead.head) {
        // `getBase() + path` stays as silent as `getBase()` alone; an
        // unresolved head keeps its reason; a head that resolves only through
        // a client or reference binding is not followed past what is appended.
        const mark = context.referencesRead?.length ?? 0;
        const head = resolveArgument(lead.head, configKeys, bindings, depth + 1, context);
        // A head is never followed past what is appended, so whatever it read
        // stays a reference rather than being consumed.
        if (context.referencesRead) context.referencesRead.length = mark;
        return head.kind === 'resolved'
          ? { kind: 'unresolved', reason: 'URL is built from an interpolated value' }
          : head;
      }
      return hostFromUrlPrefix(lead.text, !lead.complete);
    }

    case 'ObjectExpression': {
      for (const property of (node.properties as Node[] | undefined) ?? []) {
        const key = property.key as Node | undefined;
        const value = property.value as Node | undefined;
        const name = key ? String(key.name ?? (key as { value?: string }).value ?? '') : '';
        if (value && configKeys.includes(name)) {
          return resolveArgument(value, configKeys, bindings, depth + 1, context);
        }
      }
      return { kind: 'not-a-url' };
    }

    default:
      return { kind: 'not-a-url' };
  }
}

/** Concatenation chains longer than this are not folded; AST depth, not a constant chain. */
const MAX_FOLD_DEPTH = 64;

interface LeadingStatic {
  /** The static text the expression is known to begin with. */
  text: string;
  /** True when `text` is the whole value, with nothing dynamic after it. */
  complete: boolean;
  /** The first part that could not be folded, when `complete` is false. */
  head: Node | null;
}

/**
 * The static text an expression begins with, folded across string literals,
 * template chunks, `+`, and module-scope string constants that `readable()`
 * accepts -- so a constant declared twice, reassigned, or used before its
 * declaration stops the fold exactly as it stops resolution.
 *
 * Only the text is folded; whether it holds a complete authority is decided
 * once, by `hostFromUrlPrefix`, with `hasMore` set from `complete`.
 */
function leadingStatic(
  node: Node,
  bindings: Map<string, Binding>,
  context: ResolveContext,
  depth = 0,
): LeadingStatic {
  const dynamic: LeadingStatic = { text: '', complete: false, head: node };
  if (depth > MAX_FOLD_DEPTH) return dynamic;

  switch (node.type) {
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression': {
      const inner = node.expression as Node | undefined;
      return inner ? leadingStatic(inner, bindings, context, depth + 1) : dynamic;
    }

    case 'Literal':
      return typeof node.value === 'string'
        ? { text: node.value, complete: true, head: null }
        : dynamic;

    case 'Identifier': {
      const binding = readable(bindings, String(node.name), context.unstable, context.callStart);
      return binding?.kind === 'string'
        ? { text: binding.value, complete: true, head: null }
        : dynamic;
    }

    case 'TemplateLiteral': {
      const quasis = (node.quasis as Node[] | undefined) ?? [];
      const expressions = (node.expressions as Node[] | undefined) ?? [];
      let text = '';
      for (let i = 0; i < quasis.length; i++) {
        const cooked = (quasis[i]?.value as { cooked?: string; raw?: string } | undefined) ?? {};
        text += cooked.cooked ?? cooked.raw ?? '';
        const expression = expressions[i];
        if (!expression) break;
        const part = leadingStatic(expression, bindings, context, depth + 1);
        text += part.text;
        if (!part.complete) return { text, complete: false, head: part.head };
      }
      return { text, complete: true, head: null };
    }

    case 'BinaryExpression': {
      const left = node.left as Node | undefined;
      const right = node.right as Node | undefined;
      if (node.operator !== '+' || !left || !right) return dynamic;
      const head = leadingStatic(left, bindings, context, depth + 1);
      if (!head.complete) return head;
      const tail = leadingStatic(right, bindings, context, depth + 1);
      return { text: head.text + tail.text, complete: tail.complete, head: tail.head };
    }

    default:
      return dynamic;
  }
}

/**
 * The one property of a constructed `URL`/`Request` that is the destination.
 *
 * `href` renders the whole thing. `pathname`, `searchParams` and `origin` are
 * parts of it, and reading any of them as the destination would be a guess of
 * exactly the kind `resolve-host.ts` refuses to make. `Request#url` is left
 * out too: `request.url` on an *inbound* request is the single commonest
 * shape in this whole area, and it is not worth resolving a bound one at the
 * cost of a rule that reads like it covers both.
 */
const REFERENCE_VALUE_PROPERTY = 'href';

/** Methods that render a constructed reference back to its own string. */
const REFERENCE_VALUE_METHODS = new Set(['toString', 'toJSON']);

/** Whether `new <callee>(...)` is one of the reference sinks. */
function isReferenceConstruction(callee: Node): boolean {
  return findSinks(calleeShape(callee), true, SINKS).some(
    (candidate) => sinkKind(candidate) === 'reference',
  );
}

/**
 * The destination behind a constructed reference, or null when this node is
 * not one.
 *
 * Two forms reach here: the construction written in place --
 * `fetch(new URL(X))` -- and a module-scope name bound to one. Either way the
 * offset of the `new` expression is recorded in `referencesRead`, so the
 * caller can drop the reference hit that construction emits and report the
 * transfer once.
 *
 * Returning an *unresolved* resolution for an in-place construction is
 * deliberate: `fetch(new URL(request.url))` is a call whose destination is
 * unknown, and the call sink says so. A bound name that did not resolve was
 * never recorded as a binding at all, so it falls through to the ordinary
 * "value of X is not known statically".
 */
function referenceObjectHost(
  node: Node,
  configKeys: string[],
  bindings: Map<string, Binding>,
  depth: number,
  context: ResolveContext,
): HostResolution | null {
  if (node.type === 'NewExpression') {
    const callee = node.callee as Node | undefined;
    if (!callee || !isReferenceConstruction(callee)) return null;
    const inner = ((node.arguments as Node[] | undefined) ?? [])[0];
    if (!inner) return null;
    const resolution = resolveArgument(inner, configKeys, bindings, depth + 1, context);
    if (resolution.kind === 'resolved') context.referencesRead?.push(node.start);
    return resolution;
  }
  if (node.type === 'Identifier') {
    const name = String(node.name);
    // The same refusal every other binding read makes: a name declared twice
    // or reassigned resolves to nothing, because there is no scope chain to
    // say which declaration this is.
    if (context.unstable.has(name)) return null;
    const binding = bindings.get(name);
    if (!binding || binding.kind !== 'reference') return null;
    if (binding.declaredAt > context.callStart) return null;
    context.referencesRead?.push(binding.start);
    return { kind: 'resolved', host: binding.host };
  }
  return null;
}

/** `<reference>.href`, and nothing else. */
function referencePropertyHost(
  node: Node,
  configKeys: string[],
  bindings: Map<string, Binding>,
  depth: number,
  context: ResolveContext,
): HostResolution | null {
  if (node.computed === true) return null;
  const property = node.property as Node | undefined;
  if (property?.type !== 'Identifier' || String(property.name) !== REFERENCE_VALUE_PROPERTY) {
    return null;
  }
  const object = node.object as Node | undefined;
  return object ? referenceObjectHost(object, configKeys, bindings, depth, context) : null;
}

/** `<reference>.toString()` and `<reference>.toJSON()`, called with no arguments. */
function referenceMethodHost(
  node: Node,
  configKeys: string[],
  bindings: Map<string, Binding>,
  depth: number,
  context: ResolveContext,
): HostResolution | null {
  if (((node.arguments as Node[] | undefined) ?? []).length > 0) return null;
  const callee = node.callee as Node | undefined;
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return null;
  const property = callee.property as Node | undefined;
  if (property?.type !== 'Identifier' || !REFERENCE_VALUE_METHODS.has(String(property.name))) {
    return null;
  }
  const object = callee.object as Node | undefined;
  return object ? referenceObjectHost(object, configKeys, bindings, depth, context) : null;
}

/**
 * `const u = new URL('https://...')` / `const req = new Request('https://...')`.
 *
 * Recorded so `fetch(u.toString())` and `fetch(req)` resolve through the
 * binding instead of emitting an unresolved destination *beside* the
 * reference -- one transfer written over two statements was being reported
 * twice, once with the right host and no call and once with a call and no
 * host.
 *
 * Only a resolved host is recorded, which is what keeps
 * `const u = new URL(request.url)` from becoming a binding at all.
 */
function referenceBindingFor(
  init: Node,
  bindings: Map<string, Binding>,
  context: ResolveContext,
): BindingValue | null {
  if (init.type !== 'NewExpression') return null;
  const resolution = referenceObjectHost(init, [], bindings, 0, context);
  if (resolution?.kind !== 'resolved') return null;
  const callee = init.callee as Node | undefined;
  const via = callee?.type === 'Identifier' ? String(callee.name) : '';
  return { kind: 'reference', host: resolution.host, start: init.start, via };
}

/** `const B = 'https://...'` or `const B = process.env.X`. */
function literalBindingFor(init: Node): BindingValue | null {
  if (init.type === 'Literal' && typeof init.value === 'string') {
    return { kind: 'string', value: init.value };
  }
  if (init.type === 'TemplateLiteral') {
    const quasis = (init.quasis as Node[] | undefined) ?? [];
    if (quasis.length === 1) {
      const cooked = (quasis[0]?.value as { cooked?: string; raw?: string } | undefined) ?? {};
      return { kind: 'string', value: cooked.cooked ?? cooked.raw ?? '' };
    }
    return null;
  }
  if (init.type === 'MemberExpression') {
    const env = envVarName(init);
    if (env) return { kind: 'env', name: env };
  }
  return null;
}

/** `const api = axios.create({ baseURL: ... })` and similar. */
function clientBindingFor(
  init: Node,
  bindings: Map<string, Binding>,
  context: ResolveContext,
): BindingValue | null {
  if (init.type !== 'CallExpression') return null;
  const callee = init.callee as Node | undefined;
  if (!callee) return null;
  const shape = calleeShape(callee);
  const sink = findSink(shape, false);
  if (!sink?.configKeys?.includes('baseURL')) return null;

  const args = (init.arguments as Node[] | undefined) ?? [];
  const argument = args[sink.argIndex];
  const config = argument ? unwrap(argument) : undefined;
  const allowAbsolute = allowAbsoluteFrom(config, true);
  // Read the key the way the object literal evaluates: the last one wins.
  const read = config?.type === 'ObjectExpression' ? configProperty(config, 'baseURL') : null;
  if (read?.value && read.opaque) {
    return { kind: 'client', host: null, reason: BASE_REPLACEABLE, allowAbsolute };
  }
  const baseNode = read ? read.value : config;
  if (!baseNode) {
    return { kind: 'client', host: null, reason: 'client created with no base URL', allowAbsolute };
  }

  const resolution = resolveArgument(baseNode, sink.configKeys, bindings, 0, context);
  if (resolution.kind === 'resolved') {
    return { kind: 'client', host: resolution.host, allowAbsolute };
  }
  return {
    kind: 'client',
    host: null,
    reason: resolution.kind === 'unresolved' ? resolution.reason : 'base URL not a URL',
    allowAbsolute,
  };
}

/**
 * `allowAbsoluteUrls` as axios will apply it: a literal boolean, inherited
 * when the key is absent, and unknown -- with the reason -- for anything else.
 * axios compares it with `== false`, so a non-boolean literal is not simply
 * truthy or falsy, and it is not worth reproducing loose equality to read one.
 */
type AllowAbsolute = boolean | { reason: string };

const UNREADABLE_CONFIG =
  'allowAbsoluteUrls may be set by a config the analyzer cannot read, so the request URL may or may not replace the base URL';

/** Methods on an axios client that send nothing. */
const AXIOS_NON_REQUEST_METHODS = new Set(['getUri', 'create']);

/** A base URL, and whether it was written at the call or reached through a binding. */
interface AxiosBase {
  resolution: HostResolution;
  atCall: boolean;
}

/** Request URL and config arguments of one axios call. */
interface AxiosRequest {
  url: Node | null;
  config: Node | undefined;
}

/**
 * Position of the config argument by method, from axios 1.12.2's
 * `lib/core/Axios.js`: `get(url, config)` and `post(url, data, config)`.
 * `request` is `request(configOrUrl, config)` and is handled apart.
 */
const AXIOS_CONFIG_INDEX: Record<string, number> = {
  get: 1,
  delete: 1,
  head: 1,
  options: 1,
  post: 2,
  put: 2,
  patch: 2,
  postForm: 2,
  putForm: 2,
  patchForm: 2,
};

/**
 * axios's `isAbsoluteURL`, verbatim. It tests the raw string -- no trimming --
 * so `' https://x'` and `'https:/x'` are relative and join under the base.
 */
const AXIOS_ABSOLUTE = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/**
 * Static text that some continuation could still turn into an `AXIOS_ABSOLUTE`
 * match: nothing, `/`, or a scheme still being written. `/${p}` is
 * `//evil.example/x` when `p` begins with a slash.
 */
const COULD_BECOME_ABSOLUTE = /^(?:[a-z][a-z\d+\-.]*(?::\/?)?|\/)?$/i;

/** `axios(...)` and `axios.<method>(...)` for the methods that send a request. */
function directAxiosMethod(shape: CalleeShape): string | null {
  if (shape.name === 'axios') return 'request';
  if (shape.object !== 'axios' || !shape.property) return null;
  if (shape.property === 'request' || shape.property in AXIOS_CONFIG_INDEX) return shape.property;
  return null;
}

/** The built-in sink rows for axios, which `resolveAxiosRequest` replaces. */
function isAxiosSink(sink: SinkDefinition): boolean {
  return sink.callee === 'axios' || (sink.object === 'axios' && sink.property !== 'create');
}

function axiosRequest(method: string, args: Node[]): AxiosRequest {
  const first = args[0] ? unwrap(args[0]) : undefined;
  if (method === 'request') {
    if (first?.type === 'ObjectExpression') {
      return { url: configProperty(first, 'url').value, config: first };
    }
    return { url: args[0] ?? null, config: args[1] };
  }
  const index = AXIOS_CONFIG_INDEX[method];
  // A method axios does not have, on a client: its first argument is read as
  // a URL, and no argument as config.
  return {
    url: first && first.type !== 'ObjectExpression' ? (args[0] ?? null) : null,
    config: index === undefined ? undefined : args[index],
  };
}

/** The request config's own `baseURL` when it has one, else the inherited base. */
function requestBase(
  config: Node | undefined,
  inherited: AxiosBase | null,
  bindings: Map<string, Binding>,
  context: ResolveContext,
): AxiosBase | null {
  const object = config ? unwrap(config) : undefined;
  if (object?.type !== 'ObjectExpression') return inherited;
  const { value, opaque } = configProperty(object, 'baseURL');
  // A spread or computed key with no `baseURL` before it is not read: a
  // documented limitation, like a config passed by name.
  if (!value) return inherited;
  if (opaque) return { resolution: { kind: 'unresolved', reason: BASE_REPLACEABLE }, atCall: true };
  return { resolution: resolveArgument(value, [], bindings, 0, context), atCall: true };
}

/** A config's `allowAbsoluteUrls`, or `inherited` when it does not set one. */
function allowAbsoluteFrom(config: Node | undefined, inherited: AllowAbsolute): AllowAbsolute {
  if (!config) return inherited;
  const object = unwrap(config);
  // A config passed by name, or one with a spread or computed key after the
  // key, could set it to anything.
  if (object.type !== 'ObjectExpression') return { reason: UNREADABLE_CONFIG };
  const { value, opaque } = configProperty(object, 'allowAbsoluteUrls');
  if (opaque) return { reason: UNREADABLE_CONFIG };
  if (!value) return inherited;
  const literal = unwrap(value);
  return literal.type === 'Literal' && typeof literal.value === 'boolean'
    ? literal.value
    : { reason: UNKNOWN_ALLOW_ABSOLUTE };
}

/**
 * Where an axios request goes, by axios's own `buildFullPath`: the request URL
 * when it is absolute, the base URL when it is relative or when
 * `allowAbsoluteUrls` is false.
 *
 * `base` is null when no base URL is visible at all, and then the request URL
 * is read exactly as any other sink reads it. Otherwise a request URL that
 * could be either -- an unknown variable, or static text that does not yet
 * rule out a scheme -- is declined rather than given the base URL's host,
 * because an absolute one would replace it.
 */
function resolveAxiosRequest(
  url: Node | null,
  base: AxiosBase | null,
  allowAbsolute: AllowAbsolute,
  bindings: Map<string, Binding>,
  context: ResolveContext,
): { resolution: HostResolution; fromBase: boolean } {
  const notAUrl: HostResolution = { kind: 'not-a-url' };
  const fromBase = { resolution: base?.resolution ?? notAUrl, fromBase: true };
  const fromUrl = (resolution: HostResolution) => ({ resolution, fromBase: false });
  const decline = (reason: string) => fromUrl({ kind: 'unresolved', reason });

  if (!url) return fromBase;
  if (base === null) return fromUrl(resolveArgument(url, [], bindings, 0, context));
  if (allowAbsolute === false) return fromBase;

  const lead = leadingStatic(url, bindings, context);
  const absolute = AXIOS_ABSOLUTE.exec(lead.text);
  if (!absolute) {
    if (lead.complete || !COULD_BECOME_ABSOLUTE.test(lead.text)) return fromBase;
    // Nothing static says what this is. A constructed URL is the one value
    // known to render absolute; anything else names its reason or is declined.
    const mark = context.referencesRead?.length ?? 0;
    const resolution = resolveArgument(url, [], bindings, 0, context);
    const viaReference =
      resolution.kind === 'resolved' && (context.referencesRead?.length ?? 0) > mark;
    if (!viaReference) {
      if (context.referencesRead) context.referencesRead.length = mark;
      return lead.text === '' && resolution.kind === 'unresolved'
        ? fromUrl(resolution)
        : decline('request URL may be absolute, which would replace the base URL');
    }
    // Only a `URL` renders as its own address. A `Request` is not a string
    // axios can join, and `buildFullPath` throws on it: nothing is sent, and
    // the construction stays the reference it is.
    if (!isUrlObject(url, bindings, context)) {
      if (context.referencesRead) context.referencesRead.length = mark;
      return fromUrl(notAUrl);
    }
    if (allowAbsolute !== true) {
      if (context.referencesRead) context.referencesRead.length = mark;
      return decline(allowAbsolute.reason);
    }
    return fromUrl(resolution);
  }

  if (allowAbsolute !== true) return decline(allowAbsolute.reason);
  if (!absolute[1]) {
    return decline('request URL is protocol-relative; its scheme comes from the page at runtime');
  }
  return fromUrl(resolveArgument(url, [], bindings, 0, context));
}

/** `new URL(...)` or a stable name bound to one, or its `href`, `toString()` or `toJSON()`. */
function isUrlObject(node: Node, bindings: Map<string, Binding>, context: ResolveContext): boolean {
  const value = unwrap(node);
  if (value.type === 'MemberExpression') {
    const object = value.object as Node | undefined;
    return !!object && isUrlObject(object, bindings, context);
  }
  if (value.type === 'CallExpression') {
    const callee = value.callee as Node | undefined;
    const object =
      callee?.type === 'MemberExpression' ? (callee.object as Node | undefined) : undefined;
    return !!object && isUrlObject(object, bindings, context);
  }
  if (value.type === 'NewExpression') {
    const callee = value.callee as Node | undefined;
    return callee?.type === 'Identifier' && String(callee.name) === 'URL';
  }
  if (value.type === 'Identifier') {
    const binding = readable(bindings, String(value.name), context.unstable, context.callStart);
    return binding?.kind === 'reference' && binding.via === 'URL';
  }
  return false;
}

const UNKNOWN_ALLOW_ABSOLUTE =
  'allowAbsoluteUrls is not a literal, so the request URL may or may not replace the base URL';

/**
 * The value of the last property named `key` -- the one an object literal
 * evaluates to -- and whether a spread or computed key after it (or anywhere,
 * when there is none) could set the key instead. Those are never read.
 */
function configProperty(object: Node, key: string): { value: Node | null; opaque: boolean } {
  let value: Node | null = null;
  let opaque = false;
  for (const property of (object.properties as Node[] | undefined) ?? []) {
    if (property.type !== 'Property' || property.computed) {
      opaque = true;
      continue;
    }
    const name = property.key as Node | undefined;
    const label = name ? String(name.name ?? (name as { value?: string }).value ?? '') : '';
    if (label === key) {
      value = (property.value as Node | undefined) ?? null;
      opaque = false;
    }
  }
  return { value, opaque };
}

const BASE_REPLACEABLE = 'base URL may be replaced by a spread or computed key that follows it';

/**
 * Keys written through `<name>.defaults.<key> = ...` or `<name>.defaults = ...`
 * anywhere in the file, by object name. `*` stands for the whole defaults
 * object or a computed key.
 */
function collectDefaultsWrites(program: Node): Map<string, Set<string>> {
  const writes = new Map<string, Set<string>>();
  const record = (name: string, key: string) => {
    const keys = writes.get(name) ?? new Set<string>();
    keys.add(key);
    writes.set(name, keys);
  };
  walk(program, (node) => {
    if (node.type !== 'AssignmentExpression') return;
    const target = node.left as Node | undefined;
    if (target?.type !== 'MemberExpression') return;
    const object = target.object as Node | undefined;
    const property = target.property as Node | undefined;
    const key = target.computed ? '*' : String(property?.name ?? '');
    // `api.defaults = {...}`
    if (object?.type === 'Identifier' && key === 'defaults') {
      record(String(object.name), '*');
      return;
    }
    // `api.defaults.baseURL = ...`
    if (object?.type !== 'MemberExpression' || object.computed) return;
    const owner = object.object as Node | undefined;
    const middle = object.property as Node | undefined;
    if (owner?.type === 'Identifier' && String(middle?.name ?? '') === 'defaults') {
      record(String(owner.name), key);
    }
  });
  return writes;
}

function overridesBase(keys: Set<string> | undefined): boolean {
  return !!keys && (keys.has('*') || keys.has('baseURL'));
}

function overridesAllowAbsolute(keys: Set<string> | undefined): boolean {
  return !!keys && (keys.has('*') || keys.has('allowAbsoluteUrls'));
}

/** Strips the TypeScript and grouping wrappers that carry no meaning here. */
function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'ParenthesizedExpression'
  ) {
    const inner = current.expression as Node | undefined;
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** Recovers `X` from `process.env.X` or `import.meta.env.X`. */
function envVarName(node: Node): string | null {
  const object = node.object as Node | undefined;
  const property = node.property as Node | undefined;
  if (!object || !property) return null;
  const name = String(property.name ?? '');
  if (!name) return null;

  if (object.type === 'MemberExpression') {
    const inner = object.object as Node | undefined;
    const innerProp = object.property as Node | undefined;
    const innerName = String(innerProp?.name ?? '');
    if (innerName !== 'env') return null;
    if (inner?.type === 'Identifier' && String(inner.name) === 'process') return name;
    if (inner?.type === 'MetaProperty') return name;
  }
  return null;
}

function calleeShape(callee: Node): CalleeShape {
  if (callee.type === 'Identifier') return { name: String(callee.name) };
  if (callee.type === 'MemberExpression') {
    const object = callee.object as Node | undefined;
    const property = callee.property as Node | undefined;
    return {
      object: object?.type === 'Identifier' ? String(object.name) : undefined,
      property: property?.type === 'Identifier' ? String(property.name) : undefined,
    };
  }
  return {};
}

/** Depth-first walk over any ESTree-shaped object graph. */
/**
 * Names the analyzer refuses to resolve, mapped to the reason.
 *
 * Two conditions poison a name for the whole file: being declared more than
 * once anywhere (the binding map cannot say which declaration a call reads),
 * and being assigned after declaration (the declared value is stale). Both are
 * cheap to detect with one walk and both otherwise produce a wrong host rather
 * than a missing one.
 */
function collectUnstableNames(program: Node): Map<string, string> {
  const seen = new Set<string>();
  const unstable = new Map<string, string>();

  // Every form that binds a name counts as a declaration, not just `const`:
  // a parameter, a catch clause or a destructured field named like a
  // module-scope constant is a second binding of it, and the walk has no
  // scope chain to say which one a call reads. Counting only declarators let
  // `function f(B) { fetch(`${B}/v1`) }` resolve the module's `B`.
  const declare = (pattern: Node | undefined | null) => {
    for (const name of patternNames(pattern)) {
      if (seen.has(name)) unstable.set(name, `${name} is declared more than once in this file`);
      seen.add(name);
    }
  };
  const reassign = (pattern: Node | undefined | null) => {
    for (const name of patternNames(pattern)) {
      unstable.set(name, `${name} is reassigned after it is declared`);
    }
  };

  // `with` and direct `eval` can rebind any name in reach, so either one
  // makes every declared name in the file unresolvable.
  let dynamicScope: string | null = null;

  walk(program, (node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        declare(node.id as Node | undefined);
        return;
      case 'TSEnumDeclaration':
      case 'TSImportEqualsDeclaration':
      case 'TSEnumMember':
        // An enum member is in scope as a bare name inside its own enum.
        declare(node.id as Node | undefined);
        return;
      case 'TSModuleDeclaration': {
        // `namespace A.B {}` binds `A`.
        let id = node.id as Node | undefined;
        while (id?.type === 'TSQualifiedName') id = id.left as Node | undefined;
        declare(id);
        return;
      }
      case 'WithStatement':
        dynamicScope ??= 'a with statement';
        return;
      case 'CallExpression': {
        // `(eval)(s)` and `(eval as any)(s)` are still direct eval.
        const callee = unwrapExpression(node.callee as Node | undefined);
        if (callee?.type === 'Identifier' && callee.name === 'eval') dynamicScope ??= 'direct eval';
        return;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        declare(node.id as Node | undefined);
        for (const param of (node.params as Node[] | undefined) ?? []) declare(param);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        declare(node.id as Node | undefined);
        return;
      case 'CatchClause':
        declare(node.param as Node | undefined);
        return;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        declare(node.local as Node | undefined);
        return;
      case 'AssignmentExpression': {
        const left = node.left as Node | undefined;
        reassign(left);
        // `globalThis.B = ...` rebinds a script-scope `var B`.
        const name = globalPropertyName(left);
        if (name) unstable.set(name, `${name} is reassigned through the global object`);
        return;
      }
      case 'UpdateExpression':
        reassign(node.argument as Node | undefined);
        return;
      case 'ForInStatement':
      case 'ForOfStatement': {
        // `for (const B of xs)` is a declarator and is counted there.
        const left = node.left as Node | undefined;
        if (left && left.type !== 'VariableDeclaration') reassign(left);
        return;
      }
      default:
        return;
    }
  });

  if (dynamicScope) {
    for (const name of seen) {
      if (!unstable.has(name))
        unstable.set(name, `${name} may be rebound by ${dynamicScope} in this file`);
    }
  }
  return unstable;
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

/** `X` from `globalThis.X` or `window['X']`, the target of a global-object write. */
function globalPropertyName(target: Node | undefined): string | null {
  const node = unwrapExpression(target);
  if (node?.type !== 'MemberExpression') return null;
  const object = unwrapExpression(node.object as Node | undefined);
  if (object?.type !== 'Identifier' || !GLOBAL_OBJECTS.has(String(object.name))) return null;
  const property = node.property as Node | undefined;
  if (!property) return null;
  if (!node.computed && property.type === 'Identifier') return String(property.name);
  if (node.computed && property.type === 'Literal' && typeof property.value === 'string') {
    return property.value;
  }
  if (node.computed && property.type === 'TemplateLiteral') {
    const quasis = (property.quasis as Node[] | undefined) ?? [];
    if (quasis.length === 1) {
      const cooked = (quasis[0]?.value as { cooked?: string } | undefined)?.cooked;
      if (cooked !== undefined) return cooked;
    }
  }
  return null;
}

/** Type assertions and parentheses change nothing at runtime, so see through them. */
const TRANSPARENT_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
]);

function unwrapExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && TRANSPARENT_WRAPPERS.has(current.type)) {
    current = current.expression as Node | undefined;
  }
  return current;
}

/** The names a binding pattern introduces: `B`, `{ a, b: c }`, `[d, ...e]`, `f = 1`. */
function patternNames(target: Node | undefined | null): string[] {
  // `(B as any) += x` and `B! = x` assign to `B`.
  const pattern = unwrapExpression(target ?? undefined);
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [String(pattern.name)];
    case 'ObjectPattern':
      return ((pattern.properties as Node[] | undefined) ?? []).flatMap((property) =>
        patternNames(
          property.type === 'RestElement'
            ? (property.argument as Node | undefined)
            : (property.value as Node | undefined),
        ),
      );
    case 'ArrayPattern':
      return ((pattern.elements as (Node | null)[] | undefined) ?? []).flatMap((element) =>
        patternNames(element),
      );
    case 'AssignmentPattern':
      return patternNames(pattern.left as Node | undefined);
    case 'RestElement':
      return patternNames(pattern.argument as Node | undefined);
    case 'TSParameterProperty':
      return patternNames(pattern.parameter as Node | undefined);
    default:
      return [];
  }
}

/**
 * Variable declarators at module scope only, including those behind `export`.
 *
 * A declaration inside a function or block is not what a top-level call site
 * reads, so collecting it would attribute the wrong value to the wrong call.
 */
function moduleScopeDeclarators(program: Node): Node[] {
  const out: Node[] = [];
  for (const statement of (program.body as Node[] | undefined) ?? []) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? ((statement.declaration as Node | undefined) ?? null)
        : statement;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const declarator of (declaration.declarations as Node[] | undefined) ?? []) {
      if (declarator.type === 'VariableDeclarator') out.push(declarator);
    }
  }
  return out;
}

/** A binding only if the name is stable and was declared above the call. */
function readable(
  bindings: Map<string, Binding>,
  name: string,
  unstable: Map<string, string>,
  callStart: number,
): Binding | null {
  if (unstable.has(name)) return null;
  const binding = bindings.get(name);
  if (!binding || binding.declaredAt > callStart) return null;
  return binding;
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const candidate = node as Node;
  if (typeof candidate.type === 'string') visit(candidate);
  for (const key of Object.keys(candidate)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    walk(candidate[key], visit);
  }
}

/** Convert file hits into engine signals. Host matching happens in scan(). */
export function hitToSignal(hit: CallsiteHit, vendorId: string | null): Signal {
  return {
    kind: hit.kind,
    vendorId,
    matchedOn: hit.host ?? hit.matchedOn,
    confidence: hit.confidence,
    location: hit.location,
    snippet: hit.snippet,
    ...(hit.unresolvedReason ? { unresolvedReason: hit.unresolvedReason } : {}),
  };
}
