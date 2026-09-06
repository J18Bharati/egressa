import type { SourceLocation } from '../types.js';

/**
 * Converts byte offsets into 1-based line/column positions.
 *
 * Every manifest parser works in offsets because that is what jsonc-parser and
 * the YAML CST give us, but SARIF locations are line/column. Doing the
 * conversion once per file, against a prebuilt table, keeps that translation
 * from turning into a scan of the file per finding.
 */
export class LineIndex {
  /** Offset at which each line starts. */
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** 1-based line and column for a 0-based offset. */
  positionAt(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((this.lineStarts[mid] as number) <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - (this.lineStarts[low] as number) + 1 };
  }

  /** Build a SourceLocation from an offset/length pair. */
  locationAt(file: string, offset: number, length: number): SourceLocation {
    const start = this.positionAt(offset);
    const end = this.positionAt(offset + length);
    return {
      file,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
    };
  }

  /** The full text of the line containing `offset`, trimmed and length-capped. */
  snippetAt(offset: number, maxLength = 160): string {
    const { line } = this.positionAt(offset);
    const start = this.lineStarts[line - 1] as number;
    const end = this.lineStarts[line] ?? this.text.length;
    const raw = this.text
      .slice(start, end)
      .replace(/\r?\n$/, '')
      .trim();
    return raw.length > maxLength ? `${raw.slice(0, maxLength - 1)}…` : raw;
  }
}
