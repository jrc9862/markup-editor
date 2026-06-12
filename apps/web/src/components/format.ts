/**
 * Formatting operations the toolbar can invoke. Each editor mode supplies its
 * own implementation: source mode rewrites markdown text in CodeMirror,
 * rendered mode drives TipTap commands. Registered with the parent via
 * `onReady` so the toolbar works identically in both modes.
 */
export interface FormatTarget {
  /** Set heading level for the current line/block; 0 clears to paragraph. */
  heading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): void;
  bold(): void;
  italic(): void;
  /** Markdown has no underline syntax; emitted as inline HTML <u>. */
  underline(): void;
  inlineCode(): void;
  codeBlock(): void;
  quote(): void;
  bulletList(): void;
  insertTable(rows: number, cols: number): void;
  horizontalRule(): void;
}

/** Measures where a markdown offset sits vertically, for floating cards. */
export interface AnnotationMeasurer {
  /** Pixel top of the given markdown offset, relative to the page wrapper. */
  topOfOffset(mdOffset: number): number | null;
}

export interface EditorHandle {
  format: FormatTarget;
  measurer: AnnotationMeasurer;
}
