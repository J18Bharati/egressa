import type { parseSync as ParseSync } from 'oxc-parser';
import type { Confidence, Signal, SourceLocation } from '../types.js';
import { LineIndex } from '../util/line-index.js';
import { type HostResolution, MAX_DEPTH, hostFromUrlPrefix } from './resolve-host.js';
import { type CalleeShape, SINKS, type SinkDefinition, findSink, findSinks } from './sinks.js';

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
  /** Resolved host, or null when the destination could not be determined. */
  host: string | null;
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
  | { kind: 'client'; host: string | null; reason?: string };

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
  const hits: CallsiteHit[] = [];

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

  // Pass 2: find sinks and resolve their destination.
  walk(program, (node) => {
    const isNew = node.type === 'NewExpression';
    if (node.type !== 'CallExpression' && !isNew) return;

    const callee = node.callee as Node | undefined;
    if (!callee) return;
    const shape = calleeShape(callee);
    const args = (node.arguments as Node[] | undefined) ?? [];

    // A call on a client binding: `const api = axios.create({baseURL: X})` then
    // `api.get('/v1/thing')` attributes to X.
    if (callee.type === 'MemberExpression' && shape.object) {
      const binding = readable(bindings, shape.object, unstable, node.start);
      if (binding?.kind === 'client') {
        hits.push(
          toHit(
            binding.host
              ? { kind: 'resolved', host: binding.host }
              : { kind: 'unresolved', reason: binding.reason ?? 'client base URL not resolvable' },
            node,
            index,
            filePath,
            // Resolved through a binding rather than read directly at the call.
            'medium',
          ),
        );
        return;
      }
    }

    const context = { unstable, callStart: node.start };

    // Several sinks can match one call. Try each until one yields a
    // destination, so a name shared by two vendors cannot shadow the other.
    for (const sink of findSinks(shape, isNew, sinks)) {
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
          const resolution = resolveArgument(argument, configKeys, bindings, 0, context);
          if (resolution.kind !== 'resolved') continue;
          hits.push(toHit(resolution, node, index, filePath, 'high'));
          return;
        }
        continue;
      }

      const argument = args[sink.argIndex];
      if (!argument) continue;
      const resolution = resolveArgument(argument, configKeys, bindings, 0, context);
      if (resolution.kind === 'not-a-url') continue;
      hits.push(toHit(resolution, node, index, filePath, 'high'));
      return;
    }
  });

  return { hits };
}

function toHit(
  resolution: HostResolution,
  node: Node,
  index: LineIndex,
  filePath: string,
  confidence: Confidence,
): CallsiteHit {
  const location = index.locationAt(filePath, node.start, node.end - node.start);
  const snippet = index.snippetAt(node.start);
  if (resolution.kind === 'resolved') {
    return { host: resolution.host, location, snippet, confidence, matchedOn: resolution.host };
  }
  const reason = resolution.kind === 'unresolved' ? resolution.reason : 'not a URL';
  return {
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

    case 'TemplateLiteral': {
      const quasis = (node.quasis as Node[] | undefined) ?? [];
      const first = quasis[0];
      const cooked = (first?.value as { cooked?: string; raw?: string } | undefined) ?? {};
      const prefix = cooked.cooked ?? cooked.raw ?? '';
      // `${base}/v1/charges` -- the destination is built at runtime. Reporting
      // it as unresolved asks a human to look; guessing would invent a vendor.
      if (prefix === '' && quasis.length > 1) {
        return { kind: 'unresolved', reason: 'URL is built from an interpolated value' };
      }
      return hostFromUrlPrefix(prefix, quasis.length > 1);
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
      return hostFromUrlPrefix(binding.value, false);
    }

    case 'MemberExpression': {
      const env = envVarName(node);
      return env
        ? { kind: 'unresolved', reason: `host supplied by environment variable ${env}` }
        : { kind: 'unresolved', reason: 'host is computed at runtime' };
    }

    case 'BinaryExpression': {
      // Only the left operand can contribute the authority in `a + b`.
      if (node.operator !== '+') return { kind: 'not-a-url' };
      const left = node.left as Node | undefined;
      return left
        ? resolveArgument(left, configKeys, bindings, depth + 1, context)
        : { kind: 'not-a-url' };
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
  if (!argument) return { kind: 'client', host: null, reason: 'client created with no base URL' };

  const resolution = resolveArgument(argument, sink.configKeys, bindings, 0, context);
  if (resolution.kind === 'resolved') return { kind: 'client', host: resolution.host };
  return {
    kind: 'client',
    host: null,
    reason: resolution.kind === 'unresolved' ? resolution.reason : 'base URL not a URL',
  };
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

  walk(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const id = node.id as Node | undefined;
      if (!id || id.type !== 'Identifier') return;
      const name = String(id.name);
      if (seen.has(name)) unstable.set(name, `${name} is declared more than once in this file`);
      seen.add(name);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const left = node.left as Node | undefined;
      if (left?.type !== 'Identifier') return;
      const name = String(left.name);
      unstable.set(name, `${name} is reassigned after it is declared`);
    }
  });

  return unstable;
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
    kind: 'callsite',
    vendorId,
    matchedOn: hit.host ?? hit.matchedOn,
    confidence: hit.confidence,
    location: hit.location,
    snippet: hit.snippet,
    ...(hit.unresolvedReason ? { unresolvedReason: hit.unresolvedReason } : {}),
  };
}
