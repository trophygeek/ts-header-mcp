/**
 * Router (design doc §4): one adaptive entry point.
 *   directory of dirs  -> project TOC
 *   directory of files -> file TOC
 *   file               -> full header
 * Plus the model cache: memory-first, keyed by content hash + depth +
 * extractor version; optional persistent layer under config.cacheDir.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extract } from "./extractor.js";
import {
  formatFileHeader,
  formatFileToc,
  formatProjectToc,
  formatRecursiveFileList,
  type DirFileSummary,
  type DirSummary,
  type MatchingFileSummary,
} from "./formatter.js";
import type { Depth, DocsMode, FileHeaderModel } from "./model.js";
import { ProjectManager } from "./project.js";
import type { ServerConfig } from "./config.js";
import { GitIgnore } from "./ignore.js";

const EXTRACTOR_VERSION = "4"; // bump when FileHeaderModel/extraction changes
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const DTS_FILE = /\.d\.(ts|mts|cts)$/;
const TEST_FILE = /(\.(test|spec)\.(ts|tsx|mts|cts)$)|(^|\/)__tests__\//;

const GLOB_CHARS = /[*?[]/;
const BATCH_FILE_CAP = 20;

export interface TsHeaderRequest {
  path: string | string[];
  depth?: Depth;
  docs?: DocsMode;
  max_tokens?: number;
  /** Regex (case-insensitive) or substring matched against SYMBOL NAMES at every level. */
  filter?: string;
  /** When true, include import statements in the header output. */
  includeImports?: boolean;
}

type NameMatcher = (name: string) => boolean;

function makeMatcher(filter?: string): NameMatcher | undefined {
  if (!filter) return undefined;
  try {
    const re = new RegExp(filter, "i");
    return (n) => re.test(n);
  } catch {
    const f = filter.toLowerCase();
    return (n) => n.toLowerCase().includes(f);
  }
}

/** Keep entries whose name matches, or that contain matching descendants
 *  (parents of matches are kept as context with only their matching children). */
function filterEntries(entries: DeclEntryLike[], m: NameMatcher): DeclEntryLike[] {
  const out: DeclEntryLike[] = [];
  for (const e of entries) {
    if (m(e.name)) {
      out.push(e);
      continue;
    }
    if (e.children) {
      const kids = filterEntries(e.children, m);
      if (kids.length) out.push({ ...e, children: kids });
    }
  }
  return out;
}
interface DeclEntryLike {
  name: string;
  children?: DeclEntryLike[];
  [k: string]: unknown;
}

/**
 * Convert a minimal glob pattern to a RegExp. Supports:
 *   `**` → match any path segments (including none)
 *   `*`  → match within a single segment (no `/`)
 *   `?`  → single char (no `/`)
 * All other regex-special chars are escaped.
 */
function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      re += ".*"; i++; // consume both *
      if (pattern[i + 1] === "/") i++; // skip optional trailing /
    } else if (pattern[i] === "*") { re += "[^/]*";
    } else if (pattern[i] === "?") { re += "[^/]";
    } else { re += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&"); }
  }
  return new RegExp("^" + re + "$");
}

export class Router {
  private memCache = new Map<string, { hash: string; model: FileHeaderModel }>();
  private gitignore: GitIgnore | undefined;

  constructor(
    private config: ServerConfig,
    private projects = new ProjectManager(config.maxLanguageServices)
  ) {
    this.gitignore = config.useGitignore ? GitIgnore.load(config.workspaceRoot) : undefined;
  }

  private ignored(abs: string, isDir: boolean): boolean {
    if (!this.gitignore) return false;
    return this.gitignore.ignores(this.rel(abs), isDir);
  }

  handle(req: TsHeaderRequest): string {
    const docs: DocsMode = req.docs ?? this.config.docsDefault;
    const maxTokens = req.max_tokens ?? 4000;
    const includeImports = req.includeImports ?? false;
    const matcher = makeMatcher(req.filter);

    // Batch mode: array or single glob string
    if (Array.isArray(req.path) || GLOB_CHARS.test(req.path)) {
      const patterns = Array.isArray(req.path) ? req.path : [req.path];
      return this.handleBatch(patterns, req.depth, docs, maxTokens, includeImports, matcher, req.filter);
    }

    // Single-path mode (unchanged logic)
    const abs = this.resolveInWorkspace(req.path);
    const filterNote = matcher ? `// [filter: "${req.filter}" — matching symbols only]\n` : "";

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return this.notFound(req.path);
    }

    if (stat.isDirectory()) {
      return this.directory(abs, maxTokens, matcher, req.filter);
    }
    // Default "exports" for every path type; the empty-header hint points to depth:"all".
    const depth: Depth = req.depth ?? "exports";
    if (!TS_FILE.test(abs)) {
      return `// ${req.path} is not a TypeScript file. ts_header handles .ts/.tsx; use your normal file-read tool for this one.`;
    }
    let model = this.fileModel(abs, depth);
    if (!model) return this.notFound(req.path);
    if (matcher) {
      const entries = filterEntries(model.entries as unknown as DeclEntryLike[], matcher) as unknown as FileHeaderModel["entries"];
      if (entries.length === 0) {
        return `// no symbols matching "${req.filter}" in ${this.rel(abs)} — retry without filter, or ts_header(".", {filter}) to search the project.\n// hint: try a shorter/partial filter, or grep for body text`;
      }
      model = { ...model, entries };
    }
    return filterNote + formatFileHeader(model, {
      depth,
      docs,
      includeImports,
      maxTokens,
      denseGroupMinLines: this.config.denseGroupMinLines,
      workspaceRoot: this.config.workspaceRoot,
    });
  }

  // -------------------------------------------------------------------------
  // Batch / single-file helpers
  // -------------------------------------------------------------------------

  /**
   * Render a single TS file header. Shared by handle() and handleBatch() so
   * filter/not-found behavior cannot drift between the two.
   */
  private fileHeader(
    abs: string,
    depth: Depth,
    docs: DocsMode,
    maxTokens: number,
    includeImports: boolean,
    matcher?: NameMatcher,
    filterStr?: string,
  ): string {
    const filterNote = matcher ? `// [filter: "${filterStr}" — matching symbols only]\n` : "";
    if (!TS_FILE.test(abs)) {
      return `// ${this.rel(abs)} is not a TypeScript file. ts_header handles .ts/.tsx; use your normal file-read tool for this one.`;
    }
    let model = this.fileModel(abs, depth);
    if (!model) return this.notFound(this.rel(abs));
    if (matcher) {
      const entries = filterEntries(model.entries as unknown as DeclEntryLike[], matcher) as unknown as FileHeaderModel["entries"];
      if (entries.length === 0) {
        return `// no symbols matching "${filterStr}" in ${this.rel(abs)}`;
      }
      model = { ...model, entries };
    }
    return filterNote + formatFileHeader(model, {
      depth,
      docs,
      includeImports,
      maxTokens,
      denseGroupMinLines: this.config.denseGroupMinLines,
      workspaceRoot: this.config.workspaceRoot,
    });
  }

  private handleBatch(
    patterns: string[],
    depthOpt: Depth | undefined,
    docs: DocsMode,
    maxTokens: number,
    includeImports: boolean,
    matcher?: NameMatcher,
    filterStr?: string,
  ): string {
    const files: string[] = [];
    const notes: string[] = [];
    for (const p of patterns) {
      if (GLOB_CHARS.test(p)) {
        const matched = this.globWalk(p);
        if (matched.length === 0) notes.push(`// no files matching ${p}`);
        else files.push(...matched);
      } else {
        let abs: string;
        try { abs = this.resolveInWorkspace(p); } catch { notes.push(this.notFound(p)); continue; }
        let stat: fs.Stats;
        try { stat = fs.statSync(abs); } catch { notes.push(this.notFound(p)); continue; }
        if (stat.isDirectory()) {
          notes.push(`// ${p} is a directory — pass it as a plain string path instead`);
        } else if (!TS_FILE.test(abs)) {
          notes.push(`// ${p} is not a TypeScript file. ts_header handles .ts/.tsx; use your normal file-read tool for this one.`);
        } else {
          files.push(abs);
        }
      }
    }
    // Deduplicate, keeping first position
    const seen = new Set<string>();
    const deduped = files.filter((f) => { if (seen.has(f)) return false; seen.add(f); return true; });
    if (deduped.length > BATCH_FILE_CAP) {
      return `// batch too large (${deduped.length} files) — narrow the glob or split the call`;
    }
    const depth: Depth = depthOpt ?? "exports";
    const perFile = deduped.length > 0 ? Math.max(500, Math.floor(maxTokens / deduped.length)) : maxTokens;
    const CHARS_PER_TOKEN = 4;
    const budgetChars = maxTokens * CHARS_PER_TOKEN;
    const parts: string[] = [...notes];
    let used = parts.reduce((n, s) => n + s.length + 1, 0);
    for (let i = 0; i < deduped.length; i++) {
      const header = this.fileHeader(deduped[i], depth, docs, perFile, includeImports, matcher, filterStr);
      if (used + header.length + 2 > budgetChars) {
        const remaining = deduped.slice(i).map((f) => this.rel(f));
        parts.push(`// budget exhausted — omitted: ${remaining.join(", ")}`);
        break;
      }
      parts.push(header);
      used += header.length + 2;
    }
    return parts.join("\n\n");
  }

  private globWalk(pattern: string): string[] {
    const re = globToRegex(pattern);
    const root = this.config.workspaceRoot;
    const results: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && !this.ignored(p, true)) walk(p);
        } else if (TS_FILE.test(e.name) && !DTS_FILE.test(e.name) && !this.ignored(p, false)) {
          const rel = path.relative(root, p).split(path.sep).join("/");
          if (re.test(rel)) results.push(p);
        }
      }
    };
    walk(root);
    return results.sort();
  }

  // -------------------------------------------------------------------------

  private fileModel(abs: string, depth: Depth): FileHeaderModel | undefined {
    const content = fs.readFileSync(abs, "utf8");
    const hash =
      crypto.createHash("sha256").update(content).digest("hex").slice(0, 24) +
      `:${depth}:${EXTRACTOR_VERSION}`;

    const mem = this.memCache.get(abs + ":" + depth);
    if (mem && mem.hash === hash) return mem.model;

    const persisted = this.readPersistent(hash);
    if (persisted) {
      this.memCache.set(abs + ":" + depth, { hash, model: persisted });
      return persisted;
    }

    const ctx = this.projects.getFileContext(abs);
    if (!ctx) return undefined;
    const model = extract({
      sourceFile: ctx.sourceFile,
      checker: ctx.checker,
      diagnostics: ctx.diagnostics,
      relPath: this.rel(abs),
      depth,
    });
    this.memCache.set(abs + ":" + depth, { hash, model });
    this.writePersistent(hash, model);
    return model;
  }

  private findMatchingFiles(
    absDir: string,
    matcher: NameMatcher
  ): (MatchingFileSummary & { absPath: string })[] {
    const results: (MatchingFileSummary & { absPath: string })[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (
            !SKIP_DIRS.has(e.name) &&
            !e.name.startsWith(".") &&
            !this.ignored(p, true)
          ) {
            walk(p);
          }
        } else if (TS_FILE.test(e.name) && !DTS_FILE.test(e.name) && !this.ignored(p, false)) {
          const summary = this.summarizeFile(p, matcher);
          if (summary && summary.exportNames.length > 0) {
            results.push({
              relPath: this.rel(p),
              totalLines: summary.totalLines,
              exportNames: summary.exportNames,
              isTest: summary.isTest,
              absPath: p,
            });
          }
        }
      }
    };
    walk(absDir);
    return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private directory(
    absDir: string,
    maxTokens: number,
    matcher?: NameMatcher,
    filterStr?: string
  ): string {
    if (!matcher) {
      return this.directoryGrouped(absDir, maxTokens);
    }

    const matchingFiles = this.findMatchingFiles(absDir, matcher);

    if (matchingFiles.length === 0) {
      const rel = this.rel(absDir) || ".";
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      const subdirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
      const suffix = subdirs.length > 0 ? "under" : "in";
      return `// no symbols matching the filter ${suffix} ${rel}/\n// hint: try a shorter/partial filter, or grep for body text`;
    }

    if (matchingFiles.length === 1) {
      const single = matchingFiles[0];
      const model = this.fileModel(single.absPath, "exports");
      if (model) {
        const opts = {
          depth: "exports" as Depth,
          docs: this.config.docsDefault,
          maxTokens,
          denseGroupMinLines: this.config.denseGroupMinLines,
          workspaceRoot: this.config.workspaceRoot,
        };
        const header = formatFileHeader(model, opts);
        return `// [filter: "${filterStr}" — matched 1 file; showing full header]\n${header}`;
      }
    }

    // Multiple files case
    const relDir = this.rel(absDir) || ".";
    const recursiveList = formatRecursiveFileList(relDir, matchingFiles);
    const tokens = Math.ceil(recursiveList.length / 4);

    if (tokens <= maxTokens) {
      return `// [filter: "${filterStr}" — matching symbols only]\n` + recursiveList;
    }

    // Fallback to directory-grouped rendering
    const grouped = this.directoryGrouped(absDir, maxTokens, matcher);
    return `// [filter: "${filterStr}" — matching symbols only]\n${grouped}\n// hint: too many matching files to list; narrow with a more specific filter`;
  }

  private directoryGrouped(absDir: string, maxTokens: number, matcher?: NameMatcher): string {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const tsFiles = entries
      .filter((e) => e.isFile() && TS_FILE.test(e.name) && !DTS_FILE.test(e.name))
      .map((e) => e.name)
      .filter((f) => !this.ignored(path.join(absDir, f), false))
      .sort();
    const subdirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((d) => !this.ignored(path.join(absDir, d), true))
      .filter((d) => this.containsTs(path.join(absDir, d)))
      .sort();

    let fileSummaries = tsFiles.map((f) => this.summarizeFile(path.join(absDir, f), matcher));
    if (matcher) {
      fileSummaries = fileSummaries.filter((f) => f.exportNames.length > 0);
    }

    if (subdirs.length > 0) {
      let dirSummaries: DirSummary[] = subdirs.map((d) => this.summarizeDir(path.join(absDir, d), matcher));
      if (matcher) dirSummaries = dirSummaries.filter((d) => d.topExports.length > 0);
      if (matcher && dirSummaries.length === 0 && fileSummaries.length === 0) {
        return `// no symbols matching the filter under ${this.rel(absDir) || "."}/`;
      }
      return formatProjectToc(this.rel(absDir) || ".", dirSummaries, fileSummaries);
    }
    if (fileSummaries.length === 0) {
      return matcher
        ? `// no symbols matching the filter in ${this.rel(absDir)}/`
        : `// ${this.rel(absDir)}/ contains no TypeScript files.`;
    }
    return formatFileToc(this.rel(absDir) || ".", fileSummaries);
  }

  private summarizeFile(abs: string, matcher?: NameMatcher): DirFileSummary {
    const model = this.fileModel(abs, "exports");
    const rel = this.rel(abs);
    if (!model) {
      return { fileName: path.basename(abs), totalLines: 0, exportNames: [], barrel: false, reexports: [], isTest: TEST_FILE.test(rel) };
    }
    let names = model.entries.filter((e) => e.exported).map((e) => e.name);
    if (matcher) names = names.filter(matcher);
    return {
      fileName: path.basename(abs),
      totalLines: model.totalLines,
      exportNames: names,
      barrel: matcher ? false : model.barrel,
      reexports: model.reexports,
      isTest: TEST_FILE.test(rel),
      fileDoc: model.fileDoc,
    };
  }

  private summarizeDir(absDir: string, matcher?: NameMatcher): DirSummary {
    let fileCount = 0;
    let totalLines = 0;
    // Insertion-ordered counts: dedup collapses same-named exports from
    // DIFFERENT files (distinct symbols), so preserve the count as (×n).
    const counts = new Map<string, number>();
    const walk = (dir: string, depthLeft: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (
            !SKIP_DIRS.has(e.name) &&
            !e.name.startsWith(".") &&
            !this.ignored(p, true) &&
            depthLeft > 0
          )
            walk(p, depthLeft - 1);
        } else if (TS_FILE.test(e.name) && !DTS_FILE.test(e.name) && !this.ignored(p, false)) {
          fileCount++;
          const model = this.fileModel(p, "exports");
          if (model) {
            totalLines += model.totalLines;
            const inThisFile = new Set<string>();
            for (const x of model.entries) {
              if (!x.exported || inThisFile.has(x.name)) continue; // overloads: once per file
              if (matcher && !matcher(x.name)) continue;
              inThisFile.add(x.name);
              counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
            }
          }
        }
      }
    };
    walk(absDir, 6);
    const topExports = [...counts.entries()]
      .slice(0, 40)
      .map(([name, n]) => (n > 1 ? `${name} (\u00d7${n})` : name));
    return { dirName: path.basename(absDir), fileCount, totalLines, topExports };
  }

  private containsTs(absDir: string, depthLeft = 4): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = path.join(absDir, e.name);
      if (e.isFile() && TS_FILE.test(e.name) && !this.ignored(p, false)) return true;
      if (
        e.isDirectory() &&
        depthLeft > 0 &&
        !SKIP_DIRS.has(e.name) &&
        !e.name.startsWith(".") &&
        !this.ignored(p, true) &&
        this.containsTs(p, depthLeft - 1)
      ) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------

  private resolveInWorkspace(p: string): string {
    const abs = path.resolve(this.config.workspaceRoot, p);
    if (abs === path.parse(abs).root || abs === os.homedir() || os.homedir().startsWith(abs + path.sep)) {
      throw new Error(`path "${p}" resolved to "${abs}" which is the filesystem root, home directory, or an ancestor — refusing to scan.`);
    }
    const rel = path.relative(this.config.workspaceRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return abs;
  }

  private rel(abs: string): string {
    return path.relative(this.config.workspaceRoot, abs).split(path.sep).join("/");
  }

  private notFound(p: string): string {
    return `// not found: ${p}\n// tip: call ts_header(".") to see the project layout, then drill down.`;
  }

  // ---- optional persistent cache (design doc + temp-file policy) ----------

  private readPersistent(hash: string): FileHeaderModel | undefined {
    if (!this.config.cacheDir) return undefined;
    try {
      const p = path.join(this.config.cacheDir, hash.replace(/[^a-z0-9]/gi, "_") + ".json");
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return undefined;
    }
  }

  private writePersistent(hash: string, model: FileHeaderModel): void {
    if (!this.config.cacheDir) return;
    try {
      const p = path.join(this.config.cacheDir, hash.replace(/[^a-z0-9]/gi, "_") + ".json");
      fs.writeFileSync(p, JSON.stringify(model));
    } catch {
      /* cache is best-effort; never fail a request over it */
    }
  }
}
