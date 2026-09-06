/**
 * Exit codes never conflate "found things" with "crashed". A CI job needs to
 * tell the difference between a scan that ran and reported findings, and a scan
 * that could not run at all.
 */
export const EXIT = {
  /** Scan completed; nothing at or above --fail-on. */
  CLEAN: 0,
  /** Findings at or above --fail-on. */
  FINDINGS: 1,
  /** Usage or configuration error. */
  USAGE: 2,
  /** Internal error, or parse failures above tolerance. */
  INTERNAL: 3,
  /** Knowledge base could not be loaded. */
  KB: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
