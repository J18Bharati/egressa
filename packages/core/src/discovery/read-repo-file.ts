import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative } from 'node:path';

export interface RepoFileOptions {
  /**
   * The caller named this file. It is then read as given, wherever it points,
   * and its absence is an error rather than the normal case.
   */
  explicit: boolean;
  maxBytes: number;
  /** Builds the error each surface reports as a usage error. */
  fail: (message: string) => Error;
}

/**
 * Reads a settings file the scanned repository supplies, such as `.egressa.yml`
 * or `.egressa/facts.json`, as untrusted input. Returns null when the file is
 * absent, which is the normal case.
 *
 * A file that exists and cannot be honoured is always an error, never "no
 * file": treating an unreadable config as absent brought back every finding a
 * team had suppressed, with nothing to say why. Messages name the path and the
 * cause and never quote the file, because MCP returns them to an agent.
 */
export function readRepoFile(root: string, path: string, options: RepoFileOptions): string | null {
  const { explicit, maxBytes, fail } = options;
  let link: ReturnType<typeof lstatSync> | undefined;
  try {
    link = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    // A root that is not a directory has nothing in it; scan() reports the
    // root itself as a fatal error, which is the message that helps.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR' || explicit) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
      throw fail(`${path}: cannot be read (${code})`);
    }
  }
  if (!link) {
    // Asking for a file by name and going on without it would be the silent
    // widening the rest of this function exists to prevent.
    if (explicit) throw fail(`${path}: no such file`);
    return null;
  }
  let target: ReturnType<typeof statSync>;
  try {
    target = statSync(path);
  } catch {
    throw fail(`${path}: is a symlink that does not resolve`);
  }
  if (target.isDirectory()) throw fail(`${path}: is a directory, not a file`);
  // A FIFO or a device would block the synchronous read below, and on the MCP
  // server that stalls every later tool call too.
  if (!target.isFile()) throw fail(`${path}: is not a regular file`);

  // The repository's own file must be the repository's own file. A link
  // pointing elsewhere would have this read, and quote in an error, a file the
  // caller never asked about -- and MCP returns that text to an agent.
  if (!explicit) {
    const inside = relative(realpathSync(root), realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw fail(`${path}: resolves outside the repository; not read`);
    }
  }

  // Read through the descriptor that was checked, so the file cannot be
  // swapped for a FIFO between the check and the read; non-blocking, so
  // opening one does not wait for a writer. The size cap keeps a scanned
  // repository from handing the MCP server gigabytes to parse.
  let bytes: Buffer | undefined;
  let problem: string | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) problem = `${path}: is not a regular file`;
    else if (opened.size > maxBytes) {
      problem = `${path}: is larger than ${maxBytes / 1_048_576} MB; not read`;
    } else bytes = readFileSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw fail(`${path}: cannot be read (${code})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (problem !== undefined || bytes === undefined) throw fail(problem ?? `${path}: not read`);
  return decode(bytes, path, fail);
}

/**
 * UTF-8, or an error. A UTF-16 file -- what Windows PowerShell 5.1's `>`
 * writes -- parsed as one long string and was treated as no config at all.
 */
function decode(bytes: Buffer, path: string, fail: (message: string) => Error): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw fail(`${path}: is UTF-16; save it as UTF-8`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail(`${path}: is not valid UTF-8`);
  }
}
