/**
 * Writing to stdout when the next statement is `process.exit()`.
 *
 * `process.stdout` is asynchronous when it is a pipe, and `process.exit()` does
 * not flush what is still buffered. A command that writes its document and
 * exits on the following line therefore truncates at the pipe buffer -- 64 KB
 * on Linux -- while the same command redirected to a file, which is a
 * synchronous fd, is complete.
 *
 * That made `egressa scan . --format json | jq` emit invalid JSON on any
 * repository whose findings exceeded 64 KB, and emit it silently: the exit code
 * was still 0 and the truncation looked like malformed output from whatever was
 * reading. Every fixture repository is far below the threshold, so nothing in
 * the test suite could reach it until a scan of this repository did.
 *
 * Awaiting the write callback is the supported fix. It resolves once the chunk
 * has been handed off, whether stdout is a file, a TTY or a pipe.
 */
export function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Write to stdout, wait for it to flush, then exit.
 *
 * Use this rather than a bare `process.exit()` after a write. The return type
 * is `never` so a caller cannot accidentally continue past it.
 */
export async function writeOutAndExit(text: string, code: number): Promise<never> {
  await writeOut(text);
  process.exit(code);
}
