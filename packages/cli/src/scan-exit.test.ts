import { runCommand } from 'citty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from './exit-codes.js';

// scan's catch used to report every throw as a knowledge base failure (exit 4),
// sending the reader to the wrong place. Only a KnowledgeBaseError is exit 4.
// kb-loader's validation.test.ts also covers exit 4 end to end, from a bad --kb.
describe('scan exit codes for a throw from the engine', () => {
  afterEach(() => {
    vi.doUnmock('@egressa/core');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  type Kb = typeof import('@egressa/kb');

  /**
   * `makeError` receives the knowledge base module from the same registry the
   * command loads, so `instanceof KnowledgeBaseError` sees one class, not two.
   */
  async function runWithEngineThrowing(
    makeError: (kb: Kb) => unknown,
  ): Promise<{ code: unknown; stderr: string }> {
    vi.resetModules();
    const kb: Kb = await import('@egressa/kb');
    vi.doMock('@egressa/core', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@egressa/core')>()),
      scan: () => {
        throw makeError(kb);
      },
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { scanCommand } = await import('./commands/scan.js');
    // Through citty, so the flag defaults apply exactly as on the command line.
    await expect(
      runCommand(scanCommand, { rawArgs: ['fixtures/repos/clean-eu-only', '--format', 'json'] }),
    ).rejects.toThrow(/^exit /);
    return { code: exit.mock.calls[0]?.[0], stderr: stderr.mock.calls.flat().join('') };
  }

  it('is an internal error, exit 3, when the error is not a knowledge base failure', async () => {
    const { code, stderr } = await runWithEngineThrowing(() => new Error('boom'));
    expect(code).toBe(EXIT.INTERNAL);
    expect(stderr).toContain('internal error: boom');
    expect(stderr).not.toContain('knowledge base');
  });

  it('is exit 4 when the error is a KnowledgeBaseError', async () => {
    const { code, stderr } = await runWithEngineThrowing(
      (kb) => new kb.KnowledgeBaseError('kb/vendors/x.json', ['bad']),
    );
    expect(code).toBe(EXIT.KB);
    expect(stderr).toContain('could not load the knowledge base');
  });
});
