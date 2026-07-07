/**
 * FileHeaderModel — the contract between the Extractor and the Formatter.
 * Plain JSON-serializable data. No ts.* types may appear here; this is what
 * makes the extractor implementation swappable (design doc §3).
 */

export type DeclKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "let"
  | "namespace"
  | "method"
  | "property"
  | "accessor"
  | "constructor"
  | "reexport";

export interface DocInfo {
  /** First sentence of the JSDoc, cleaned, <= 100 chars. */
  brief?: string;
  /** Full JSDoc text including tags, as written. */
  full?: string;
  deprecated: boolean;
}

export interface ErrorMark {
  line: number;
  code: number; // TS error code, e.g. 2304
  message: string; // first line, truncated
}

export interface DeclEntry {
  kind: DeclKind;
  name: string;
  /** Rendered signature/declaration text WITHOUT the trailing line comment. May contain newlines for long signatures. */
  text: string;
  /** 1-based line of the declaration's *name* in the source. */
  line: number;
  /** 1-based last line of the declaration. Equal to `line` for single-line decls. */
  endLine: number;
  exported: boolean;
  isDefault?: boolean;
  /** True for body-less declarations eligible for dense-block grouping (design doc §5.3). */
  dense: boolean;
  doc?: DocInfo;
  error?: ErrorMark;
  /** Class/interface/namespace members, or inner functions at depth:"deep". */
  children?: DeclEntry[];
}

export interface FileHeaderModel {
  /** Workspace-relative path. */
  path: string;
  totalLines: number;
  exportCount: number;
  /** True when the file is >= 80% re-exports (design doc §5.6). */
  barrel: boolean;
  /** Module specifiers re-exported from, when barrel. */
  reexports: string[];
  entries: DeclEntry[];
  /** Diagnostics that could not be attached to a specific declaration. */
  fileErrors: ErrorMark[];
  /** Ranges the parser could not recover (rare). */
  skippedRanges: { from: number; to: number; message: string }[];
}

export type Depth = "exports" | "all" | "deep";
export type DocsMode = "none" | "brief" | "full";

export interface HeaderOptions {
  depth: Depth;
  docs: DocsMode;
  /** Approximate output budget in tokens (est. 4 chars/token). */
  maxTokens: number;
  /** Dense-block grouping threshold in rendered lines (design doc §5.3, default 6). */
  denseGroupMinLines: number;
}

export const DEFAULT_OPTIONS: HeaderOptions = {
  depth: "exports",
  docs: "brief",
  maxTokens: 4000,
  denseGroupMinLines: 6,
};
