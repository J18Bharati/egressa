import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Larger than any lockfile or source file worth parsing; a guard, not a budget. */
const MAX_READ_BYTES = 32 * 1_048_576;

/**
 * Reads `rel` under `root` only if its real path stays inside the root and is
 * a regular file of a sane size.
 *
 * The scanned repository is untrusted input, and a symlink is part of it: a
 * committed `pnpm-lock.yaml -> ~/.aws/credentials` used to be read, and the
 * YAML parser's error quoted its first line into every output surface. Every
 * reader in core goes through here. A link that resolves inside the root is
 * still the repository's own file.
 *
 * The open is non-blocking and the type is checked on the open descriptor, as
 * the config loader does: a FIFO committed as `.gitignore` used to hang the
 * scan, and the MCP server with it. Opening the resolved path rather than
 * `rel` again narrows the window in which a concurrent local writer could
 * swap a link in; it does not close it -- a parent directory replaced after
 * `realpathSync` would still be followed -- and nothing short of a
 * descriptor-relative walk would. That needs write access on the scanning
 * machine during the scan, which is outside this tool's threat model.
 *
 * Hard links are indistinguishable from ordinary files and are read.
 */
export function readInsideRoot(root: string, rel: string): string {
  const real = realpathSync(join(root, rel));
  const inside = relative(realpathSync(root), real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('resolves outside the scan root; not read');
  }
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('is not a regular file; not read');
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`is larger than ${MAX_READ_BYTES / 1_048_576} MB; not read`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A read failure as it may appear in output: the system error code alone, or
 * this module's own message. A Node error message carries the absolute path,
 * which would put the reviewer's home directory into JSON and SARIF.
 */
export function readErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ?? (error as Error).message;
}
