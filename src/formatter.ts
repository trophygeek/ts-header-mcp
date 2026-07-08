/**
 * Formatter: FileHeaderModel -> header text (design doc §5) and
 * directory models -> TOC text (design doc §6).
 * All rendering rules live here; the extractor knows nothing about layout.
 */

import type {
  DeclEntry,
  FileHeaderModel,
  HeaderOptions,
} from "./model.js";
import { DEFAULT_OPTIONS } from "./model.js";

const ANNOT_COL = 64; // column where trailing "// Lnn" comments aim to start
const CHARS_PER_TOKEN = 4;
const FILE_ERROR_BANNER_THRESHOLD = 10;

export function formatFileHeader(
    model: FileHeaderModel,
    partial?: Partial<HeaderOptions>
): string {
  const opts: HeaderOptions = { ...DEFAULT_OPTIONS, ...partial };
  const out: string[] = [];

  out.push(
      `// ==== ${model.path} — ${model.totalLines} lines, ${model.exportCount} export${model.exportCount === 1 ? "" : "s"} ====`
  );

  if (model.fileDoc) {
    out.push(`// ${model.fileDoc}`);
  }
  const totalErrors = countErrors(model);
  if (totalErrors > FILE_ERROR_BANNER_THRESHOLD) {
    out.push(`// ⚠ ${totalErrors} type/syntax errors in this file — signatures may be unreliable`);
  }
  out.push("");

  if (model.barrel) {
    out.push(`// barrel file: re-exports ${capList(model.reexports)}`);
    out.push(`// follow: ts_header on those paths for the real declarations`);
    return finish(out, model, opts);
  }

  renderEntries(model.entries, out, opts, 0);

  for (const r of model.skippedRanges) {
    out.push(`// ⚠ L${r.from}-${r.to}: skipped, ${r.message}`);
  }
  return finish(out, model, opts);
}

function finish(out: string[], model: FileHeaderModel, opts: HeaderOptions): string {
  out.push("");
  out.push(`// details: read ${model.path} at the L-numbers above` +
           (opts.docs !== "full" ? `, or docs:"full" for @param/@throws contracts` : ""));
  return truncateToBudget(out, opts).join("\n");
}

// ---------------------------------------------------------------------------
// Entry rendering with dense-block grouping
// ---------------------------------------------------------------------------

function renderEntries(
    entries: DeclEntry[],
    out: string[],
    opts: HeaderOptions,
    indentLevel: number
): void {
  const indent = "  ".repeat(indentLevel);
  let i = 0;
  while (i < entries.length) {
    // Collect a run of consecutive dense (body-less) entries.
    if (entries[i].dense && !entries[i].error) {
      let j = i;
      while (j < entries.length && entries[j].dense && !entries[j].error) j++;
      const run = entries.slice(i, j);
      const sourceSpan = run[run.length - 1].endLine - run[0].line + 1;
      if (sourceSpan > opts.denseGroupMinLines && run.length >= 2) {
        const from = run[0].line;
        const to = run[run.length - 1].endLine;
        out.push(`${indent}// -- ${denseLabel(run)}: L${from}-${to} --`);
        for (const e of run) {
          renderDoc(e, out, opts, indent, "before");
          out.push(indent + e.text + deprecatedMark(e));
          renderDoc(e, out, opts, indent, "after");
        }
        out.push("");
        i = j;
        continue;
      }
    }
    // Overload chains: consecutive function entries sharing a name render as
    // a tight block, with the usual trailing blank line only after the last.
    const isOverloadContinuation =
        entries[i].kind === "function" &&
        entries[i + 1]?.kind === "function" &&
        entries[i + 1].name === entries[i].name;
    renderEntry(entries[i], out, opts, indentLevel, isOverloadContinuation);
    i++;
  }
}

function renderEntry(
    e: DeclEntry,
    out: string[],
    opts: HeaderOptions,
    indentLevel: number,
    suppressTrailingBlank = false
): void {
  const indent = "  ".repeat(indentLevel);
  renderDoc(e, out, opts, indent, "before");

  const hasChildren = e.children && e.children.length > 0;
  const isContainer = e.kind === "class" || e.kind === "namespace";
  const openBrace = isContainer ? " {" : "";
  const firstLine = indent + e.text.split("\n")[0] + openBrace;
  const rest = e.text.split("\n").slice(1).map((l) => indent + l);

  out.push(padAnnotate(firstLine, annotation(e)));
  out.push(...rest);
  renderDoc(e, out, opts, indent, "after");

  if (hasChildren) {
    renderEntries(e.children!, out, opts, indentLevel + 1);
  }
  if (isContainer) out.push(indent + "}");
  if (indentLevel === 0 && !suppressTrailingBlank) out.push("");
}

function annotation(e: DeclEntry): string {
  let a = e.line === e.endLine ? `// L${e.line}` : `// L${e.line}-${e.endLine}`;
  if (e.doc?.deprecated) {
    a += ` ⚠ deprecated`;
  }
  if (e.error) {
    const at = e.error.line !== e.line ? `at L${e.error.line} ` : "";
    a += ` ⚠ ${at}TS${e.error.code}: ${e.error.message} — type unreliable`;
  }
  return a;
}

function deprecatedMark(e: DeclEntry): string {
  return e.doc?.deprecated ? "   // ⚠ deprecated" : "";
}

function padAnnotate(line: string, annot: string): string {
  const pad = Math.max(1, ANNOT_COL - line.length);
  return line + " ".repeat(pad) + annot + (annot.includes("⚠") ? "" : "");
}

function renderDoc(
    e: DeclEntry,
    out: string[],
    opts: HeaderOptions,
    indent: string,
    position: "before" | "after"
): void {
  if (!e.doc) return;
  // @deprecated always surfaces via deprecatedMark regardless of docs mode.
  if (opts.docs === "none") return;
  if (opts.docs === "full" && position === "before" && e.doc.full) {
    for (const l of e.doc.full.split("\n")) out.push(indent + l.trim().replace(/^/, l.trim().startsWith("*") ? " " : ""));
    return;
  }
  if (opts.docs === "brief" && e.doc.brief) {
    const briefPosition = e.text.includes("\n") ? "before" : "after";
    if (position !== briefPosition) return;
    if (briefPosition === "before") out.push(indent + "// " + e.doc.brief);
    else out.push(indent + "    // " + e.doc.brief);
  }
}

function denseLabel(run: DeclEntry[]): string {
  const kinds = new Set(run.map((e) => e.kind));
  const typeish = new Set(["type", "interface", "enum"]);
  if ([...kinds].every((k) => typeish.has(k))) return "types";
  if (kinds.size === 1) return run[0].kind + "s";
  return "declarations";
}

// ---------------------------------------------------------------------------
// Token budget (design doc §8)
// ---------------------------------------------------------------------------

function truncateToBudget(lines: string[], opts: HeaderOptions): string[] {
  const budget = opts.maxTokens * CHARS_PER_TOKEN;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].length + 1;
    if (total > budget) {
      const kept = lines.slice(0, Math.max(1, i));
      kept.push(
          `// … truncated at ~${opts.maxTokens} tokens — call again with a larger max_tokens for the rest`
      );
      return kept;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Directory / project TOCs (design doc §6)
// ---------------------------------------------------------------------------

export interface DirFileSummary {
  fileName: string;
  totalLines: number;
  exportNames: string[];
  barrel: boolean;
  reexports: string[];
  isTest: boolean;
  /** First sentence of a file-leading JSDoc, when present. */
  fileDoc?: string;
}

const TOC_DOC_MAX = 72;

function tocDoc(f: DirFileSummary): string {
  if (!f.fileDoc) return "";
  const d = f.fileDoc.length > TOC_DOC_MAX ? f.fileDoc.slice(0, TOC_DOC_MAX - 1) + "…" : f.fileDoc;
  return `  — ${d}`;
}

export interface DirSummary {
  dirName: string;
  fileCount: number;
  totalLines: number;
  topExports: string[];
}

const FILE_ROW_NAME_CAP = 24; // directory (file TOC) rows: near-complete
const DIR_ROW_NAME_CAP = 10;  // project TOC rows: orientation only

export function formatFileToc(dirPath: string, files: DirFileSummary[]): string {
  const out: string[] = [];
  out.push(`// ==== ${dirPath}/ — ${files.length} file${files.length === 1 ? "" : "s"} ====`);
  const nameW = Math.max(...files.map((f) => f.fileName.length), 4) + 2;
  for (const f of files) {
    let desc: string;
    if (f.barrel) desc = `barrel: ${capList(f.reexports)}`;
    else desc = capNames(f.exportNames, FILE_ROW_NAME_CAP);
    const tag = f.isTest ? " [test]" : "";
    out.push(
        `${(f.fileName + tag).padEnd(nameW)} ${String(f.totalLines + "L").padStart(6)}   ${desc}${tocDoc(f)}`
    );
  }
  const example = files.find((f) => !f.barrel && !f.isTest) ?? files[0];
  if (example) {
    out.push("");
    out.push(`// drill down: ts_header("${dirPath}/${example.fileName}")`);
  }
  return out.join("\n");
}

export function formatProjectToc(
    rootPath: string,
    dirs: DirSummary[],
    rootFiles: DirFileSummary[]
): string {
  const out: string[] = [];
  const totalFiles = dirs.reduce((n, d) => n + d.fileCount, 0) + rootFiles.length;
  const totalLines =
      dirs.reduce((n, d) => n + d.totalLines, 0) +
      rootFiles.reduce((n, f) => n + f.totalLines, 0);
  out.push(
      `// ==== ${rootPath}/ — ${dirs.length} dirs, ${totalFiles} files, ${totalLines.toLocaleString("en-US")} lines ====`
  );
  const nameW = Math.max(...dirs.map((d) => d.dirName.length + 1), ...rootFiles.map((f) => f.fileName.length + (f.isTest ? 7 : 0)), 4) + 2;
  for (const d of dirs) {
    out.push(
        `${(d.dirName + "/").padEnd(nameW)} ${String(d.fileCount).padStart(3)} files   ${capNames(d.topExports, DIR_ROW_NAME_CAP)}`
    );
  }
  for (const f of rootFiles) {
    const desc = f.barrel ? `barrel: re-exports ${capList(f.reexports)}` : capNames(f.exportNames, FILE_ROW_NAME_CAP);
    const tag = f.isTest ? " [test]" : "";
    out.push(`${(f.fileName + tag).padEnd(nameW)} ${String(f.totalLines + "L").padStart(9)} ${desc}${tocDoc(f)}`);
  }
  if (dirs.length > 0) {
    out.push("");
    out.push(`// drill down: ts_header("${rootPath}/${dirs[0].dirName}")`);
  }
  return out.join("\n");
}

const REEXPORT_CAP = 8;

/** Cap a plain list (no dedup/junk rules — used for barrel re-export specifiers). */
function capList(items: string[], cap = REEXPORT_CAP): string {
  if (items.length <= cap) return items.join(", ");
  return items.slice(0, cap).join(", ") + `, +${items.length - cap} more`;
}

function capNames(names: string[], cap: number): string {
  // Dedupe (identical names recur across overloads/re-exports) and drop
  // single-character junk names that carry no orientation value.
  const seen = new Set<string>();
  const clean = names.filter((n) => {
    if (n.length < 2 || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  if (clean.length === 0) return "(no exports)";
  if (clean.length <= cap) return clean.join(", ");
  return clean.slice(0, cap).join(", ") + `, +${clean.length - cap} more`;
}

function countErrors(model: FileHeaderModel): number {
  let n = model.fileErrors.length;
  const walk = (entries: DeclEntry[]) => {
    for (const e of entries) {
      if (e.error) n++;
      if (e.children) walk(e.children);
    }
  };
  walk(model.entries);
  return n;
}
