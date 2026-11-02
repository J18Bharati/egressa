import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// A binary copied without the kb/ beside it, or a bundler that drops it, finds
// no bundled knowledge base. That is a knowledge base load failure, exit 4,
// and it used to be a plain Error: `scan` reported it as an internal error
// (exit 3) and `vendors` let it escape as a crash (exit 1, read as findings).
describe('no bundled knowledge base', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('is a KnowledgeBaseError when no kbPath is given', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: ((path: unknown, ...rest: unknown[]) => {
          if (String(path).endsWith('kb.version')) throw new Error('ENOENT (simulated)');
          return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
        }) as typeof fs.readFileSync,
      };
    });
    const { loadKnowledgeBase, KnowledgeBaseError } = await import('./index.js');
    expect(() => loadKnowledgeBase()).toThrow(KnowledgeBaseError);
  });

  it('refuses a supplied kbPath rather than validate it against its own schemas', async () => {
    // The schemas that vouch for the data must be the ones this tool shipped
    // with. With no bundled copy the loader used to fall back to the supplied
    // directory's schema/, so a knowledge base carrying `{}` there vouched for
    // itself and loaded unchecked.
    const dir = mkdtempSync(join(tmpdir(), 'egressa-kb-'));
    cpSync('kb', dir, { recursive: true });
    writeFileSync(join(dir, 'schema', 'vendor-1.0.0.json'), '{}');
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return {
        ...fs,
        readFileSync: ((path: unknown, ...rest: unknown[]) => {
          const p = String(path);
          if (p.endsWith('kb.version') && !p.startsWith(dir)) throw new Error('ENOENT (simulated)');
          return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
        }) as typeof fs.readFileSync,
      };
    });
    const { loadKnowledgeBase, KnowledgeBaseError } = await import('./index.js');
    try {
      expect(() => loadKnowledgeBase({ kbPath: dir })).toThrow(KnowledgeBaseError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Where the loader looks is decided by the directory its own file sits in, so
// these copy the loader into a scratch layout and load it from there.
describe('where the bundled knowledge base is looked for', () => {
  // Computed, so a new module in the loader cannot leave this copy unable to boot.
  const SOURCES = readdirSync('packages/kb-loader/src').filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const MISSING = /missing from its installation/;

  function layout(): string {
    const dir = mkdtempSync(join(tmpdir(), 'egressa-kb-layout-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function placeLoader(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const f of SOURCES) cpSync(resolve('packages/kb-loader/src', f), join(dir, f));
  }

  async function loaderAt(dir: string): Promise<typeof import('./index.js')> {
    vi.resetModules();
    return import(join(dir, 'index.ts'));
  }

  it('does not take the schemas from a kb/ three levels above an installed package', async () => {
    // node_modules/@egressa/kb/dist/../../../kb is node_modules/kb: any npm
    // package of that name. From egressa/dist it is the scanned project's kb/.
    const root = layout();
    placeLoader(join(root, 'node_modules/@egressa/kb/dist'));
    cpSync('kb', join(root, 'node_modules/kb'), { recursive: true });
    writeFileSync(join(root, 'node_modules/kb/schema/vendor-1.0.0.json'), '{}');
    const { loadKnowledgeBase, KnowledgeBaseError } = await loaderAt(
      join(root, 'node_modules/@egressa/kb/dist'),
    );
    expect(() => loadKnowledgeBase()).toThrow(KnowledgeBaseError);
    expect(() => loadKnowledgeBase()).toThrow(MISSING);
  });

  it('does not take them from a scanned project dressed up as the workspace', async () => {
    // From node_modules/egressa/dist, three levels up is the project that
    // installed it -- the one being scanned. It can carry every marker a
    // workspace has, including the name; it cannot choose where the loader is.
    const root = layout();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'egressa-workspace' }));
    placeLoader(join(root, 'packages/kb-loader/src'));
    cpSync('kb', join(root, 'kb'), { recursive: true });
    writeFileSync(join(root, 'kb/schema/vendor-1.0.0.json'), '{}');
    placeLoader(join(root, 'node_modules/egressa/dist'));
    const { loadKnowledgeBase } = await loaderAt(join(root, 'node_modules/egressa/dist'));
    expect(() => loadKnowledgeBase()).toThrow(MISSING);
  });

  it('prefers the workspace kb/ over a stale build copy when run from source', async () => {
    const root = layout();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'egressa-workspace' }));
    cpSync('kb', join(root, 'kb'), { recursive: true });
    cpSync('kb', join(root, 'packages/kb-loader/kb'), { recursive: true });
    writeFileSync(join(root, 'packages/kb-loader/kb/kb.version'), 'stale-build-copy\n');
    placeLoader(join(root, 'packages/kb-loader/src'));
    const { loadKnowledgeBase } = await loaderAt(join(root, 'packages/kb-loader/src'));
    expect(loadKnowledgeBase().version).not.toBe('stale-build-copy');
  });

  it('uses the kb/ shipped beside a built file', async () => {
    const root = layout();
    cpSync('kb', join(root, 'node_modules/@egressa/kb/kb'), { recursive: true });
    placeLoader(join(root, 'node_modules/@egressa/kb/dist'));
    const { loadKnowledgeBase } = await loaderAt(join(root, 'node_modules/@egressa/kb/dist'));
    expect(loadKnowledgeBase().vendors.length).toBeGreaterThan(0);
  });
});
