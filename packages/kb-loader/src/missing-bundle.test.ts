import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
