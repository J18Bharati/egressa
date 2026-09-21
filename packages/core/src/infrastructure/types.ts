import type { SourceLocation } from '../types.js';

/**
 * A region a repository declares for infrastructure it controls.
 *
 * `provider` is a knowledge base vendor id. The region is the identifier
 * exactly as written; resolving it to a country is the knowledge base's job,
 * because the same string means different places for different providers and
 * the prefix never settles it.
 */
export interface InfraRecord {
  provider: string;
  region: string;
  loc: SourceLocation;
  snippet: string;
}

export interface InfraParseResult {
  regions: InfraRecord[];
  errors: { file: string; message: string; fatal: boolean }[];
}
