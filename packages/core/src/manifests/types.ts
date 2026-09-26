import type { Ecosystem, SourceLocation } from '../types.js';

/**
 * One dependency as found in a manifest or lockfile.
 *
 * `loc` points at the declaration site so a finding can be a line annotation
 * rather than a file-level one. Lockfile-only records (transitive dependencies)
 * point at the lockfile entry.
 */
export interface DependencyRecord {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** Repo-relative POSIX path of the manifest this came from. */
  manifestPath: string;
  loc: SourceLocation;
  snippet: string;
  /** True when the project declared it, not reached through another package. */
  direct: boolean;
  /** True when it appears only in devDependencies. */
  dev: boolean;
  /**
   * For transitive records, what led here: the path of dependents from an npm
   * lockfile, or the immediate parents a compiled `requirements.txt` names.
   */
  transitiveVia?: string[];
  /** Workspace package name, when the manifest belongs to a workspace member. */
  workspace?: string;
}

export interface ManifestParseResult {
  dependencies: DependencyRecord[];
  errors: { file: string; message: string; fatal: boolean }[];
}

export type LockfileKind =
  | 'npm-v1'
  | 'npm-v2'
  | 'npm-v3'
  | 'pnpm-v6'
  | 'pnpm-v9'
  | 'yarn-classic'
  | 'yarn-berry';
