import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Reads `rel` under `root` only if its real path stays inside the root.
 *
 * The scanned repository is untrusted input, and a symlink is part of it: a
 * committed `pnpm-lock.yaml -> ~/.aws/credentials` used to be read, and the
 * YAML parser's error quoted its first line into every output surface. Every
 * reader in core goes through here. A link that resolves inside the root is
 * still the repository's own file and is read as usual.
 *
 * The file opened is the resolved path that was checked, not `rel` again, so
 * a link swapped between the check and the read cannot redirect it.
 */
export function readInsideRoot(root: string, rel: string): string {
  const real = realpathSync(join(root, rel));
  const inside = relative(realpathSync(root), real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('resolves outside the scan root; not read');
  }
  return readFileSync(real, 'utf8');
}
