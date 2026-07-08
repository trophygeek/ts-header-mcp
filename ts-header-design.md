# ts-header — Design Document

**Status:** Draft v1 · **Date:** 2026-07-06
**One-liner:** An MCP server that produces C-header-style "signature files" from TypeScript source, with original line offsets and optional doc summaries, designed for consumption by less-capable AI coding agents.

---

## 1. Problem & Goals

AI coding agents burn context and take wrong turns because the primitives available to them — file listing, grep, whole-file reads — expose either too little (names) or too much (bodies). Interactive symbol-query tools (Serena, lsmcp, symbols-mcp) solve this for capable agents but demand multi-step tool orchestration that weaker LLMs handle poorly. Repo-map tools (Aider) produce a single ranked, lossy artifact rather than a complete per-file reference.

ts-header fills the gap: a **deterministic, complete, per-file header** — the `.d.ts` idea, but retaining source line numbers as jump targets, retaining non-exported and inner structure on request, and formatted for one-shot reading by an LLM.

**Goals.** Correct signatures for modern TypeScript (including inferred types via the type checker); line offsets so the agent can jump straight to details in the source; hierarchical navigation (project → directory → file) through a single tool; graceful behavior on broken code; token-frugal output.

**Non-goals.** Editing or refactoring (read-only tool); ranking/importance heuristics (headers are complete, not curated); languages other than TS/TSX (JS/JSX parses for free via the compiler and is in scope, but no tree-sitter multi-language ambitions); symbol search or find-references (other tools do this; may be revisited).

## 2. Prior Art (and why we differ)

Serena and lsmcp expose LSP capabilities as fine-grained MCP tools — powerful, but each answer requires the agent to choose the right tool with the right arguments, repeatedly. symbols-mcp is closest in spirit (minimal toolset, outline + inspect) but still splits navigation across tools and doesn't produce a header-shaped artifact. Aider's repo map is token-budgeted and PageRank-ranked — excellent for automatic context injection, wrong for "give me the complete API of this file." `tsc --emitDeclarationOnly` produces the canonical header but discards line numbers, non-exported declarations, and doc-comment placement control.

ts-header's differentiators: one adaptive tool, complete per-path output, source line offsets, weak-LLM-first formatting.

## 3. Architecture Overview

A long-lived Node process speaking MCP over stdio.

```
MCP layer (one tool: ts_header)
        │
Router: path → project TOC | directory TOC | file header
        │
Formatter: FileHeaderModel → header text (all rendering rules live here)
        │
Cache: content-hash keyed FileHeaderModel per file; invalidated by watcher/mtime
        │
Extractor (interface): ts.SourceFile + ts.TypeChecker → FileHeaderModel
        │
Project manager: tsconfig discovery → map of tsconfig path → ts.LanguageService
```

**Extractor interface.** The extraction layer is isolated behind `extract(file, checker): FileHeaderModel` so the implementation (raw compiler API, decision §9) can be swapped for ts-morph or tree-sitter without touching the formatter, cache, or MCP layers. `FileHeaderModel` is a plain JSON-serializable tree of declarations: kind, name, signature text, line range, doc summary, full doc, error markers, children (for classes, namespaces, and — at deep depth — inner functions).

**Project manager.** For each requested file, discover the nearest `tsconfig.json` walking upward; maintain one `ts.LanguageService` per discovered tsconfig. Follow `references` in solution-style configs so monorepo packages type-check against their siblings' source, not stale build output. LanguageServices are created lazily and evicted LRU (default: keep 4) to bound memory in large monorepos.

**Cache.** Key: SHA-256 of file content + compiler options hash + extractor version. Value: `FileHeaderModel`. Formatting is cheap and always done fresh from the model (so `docs`/`depth` options don't multiply cache entries). Directory and project TOCs are derived views over cached file models. Invalidation via `fs.watch` with mtime fallback; a stale answer is impossible because the content hash is checked on read.

## 4. Tool Surface

A single tool. Weak LLMs are bad at tool selection, so navigation depth is expressed by the path, mirroring the `ls`/`cat` mental model every model already has.

```
ts_header(
  path: string,              // file, directory, or project root (relative to workspace)
  depth?: "exports" | "all" | "deep",   // default "exports"
  docs?: "none" | "brief" | "full",     // default from server config (ships as "brief")
  max_tokens?: number        // default 4000; truncation marker + drill-down hint when exceeded
)
```

`depth: "exports"` — exported declarations only. `"all"` — adds file-level non-exported declarations. `"deep"` — additionally descends into function bodies: inner functions, closures returned as values, locally declared classes, rendered indented under their parent. Deep exists because inner structure is exactly what an agent cannot discover without reading the whole file.

`docs` is a server-configurable default so operators can measure whether brief docs earn their tokens for their agents and flip the default accordingly.

Every response ends with a self-documenting hint line, e.g. `// drill down: ts_header("src/services/userService.ts")` or, at file level, `// details: read the source at the L-numbers above, or docs:"full" for contracts`. Weak models measurably benefit from the next step being spelled out.

**Tool description (draft, tuned for weak LLMs):**
> Get a compact "header file" view of TypeScript code. Give a directory to see what each file exports; give a file to see every signature with its line number (Lnn) so you can jump straight to the code you need. Use this BEFORE reading source files.

## 5. Output Format — File Level

Rendered as TypeScript-shaped text (heavily represented in training data — no format-decoding tax), with line offsets as trailing comments (prefix numbers pollute pattern-matching and leak into edits).

```typescript
// ==== src/services/userService.ts — 312 lines, 8 exports ====

export class UserService {                                      // L24-198
  constructor(db: Database, cache?: CacheLayer)                 // L31
  getUser(id: UserId): Promise<User | null>                     // L45
      // Fetches a user by ID, checking cache first.
  updateUser(id: UserId, patch: Partial<User>): Promise<User>   // L67
}

// -- types: L201-240 --
export type UserId = Brand<string, 'UserId'>
export interface User { id: UserId; name: string; email: string; roles: Role[] }
export type Role = 'admin' | 'member' | 'guest'

export function createUserService(cfg: Config): UserService     // L245
    // Factory. Wires cache from cfg.cache if present.

// drill down: read src/services/userService.ts at the L-numbers above
```

Rules, in order of application:

1. **Signatures.** Rendered from the type checker: parameter types and return types are the *checked* types, so inferred returns appear explicitly. Modifiers preserved (`export`, `async` dropped in favor of the `Promise<>` return type it implies, `abstract`, `readonly`, accessibility keywords). Overloads: each overload signature on its own line sharing one implementation L-range. Generics rendered as written, with constraints. Very long signatures (> ~120 chars) wrap with hanging indent rather than truncate — a wrong-by-omission signature is worse than a two-line one.
2. **Line annotations.** Multi-line declarations get a range (`// L24-198`); single-line members get a point (`// L45`). The number is the line of the declaration's name in the original source, 1-based, so `read file offset L45` lands exactly.
3. **Dense-block grouping.** When a run of consecutive body-less declarations (type aliases, interfaces, enums, consts) exceeds **N = 6 source lines** in header form, collapse per-line annotations into one block header (`// -- types: L201-240 --`) and render members bare. Runs of ≤ N keep individual annotations. N is server-configurable.
4. **Docs.** `brief`: first sentence of the JSDoc/hdoc, rendered *after* the signature, indented, as a `//` comment — signatures stay scannable, docs are visually subordinate. Skipped entirely when the sentence adds nothing over the name (exact heuristic TBD; v1 may include all). `full`: the complete JSDoc block rendered *before* the declaration in conventional position, including `@param`/`@throws`/`@deprecated`. `none`: omitted, except `@deprecated` which always surfaces as a trailing `⚠ deprecated` marker regardless of mode — an agent must never call a deprecated API for want of tokens.
5. **Classes.** Members in source order. Private members included only at `depth:"all"` and above, marked `private`. Getters/setters coalesced (`accessor name: T` style annotation) when both exist.
6. **Barrel files.** A file that is ≥ 80% re-exports renders as a re-export summary (`barrel: ./userService, ./authService`) rather than expanding every forwarded symbol; a `follow:` hint points to the origin files.

## 6. Output Format — Directory & Project Levels

Derived from the same cached models; export **names only** (signatures live one drill-down away), keeping a whole-project TOC in the low hundreds of tokens.

```typescript
// path = "src" — project TOC (directory of directories)
// ==== src/ — 4 dirs, 31 files, 12,140 lines ====
services/    6 files   UserService, AuthService, BillingService, +9 more
models/      9 files   User, Invoice, Subscription, +14 more
utils/      12 files   retry, chunk, assertNever, +21 more
index.ts     barrel: re-exports services, models
// drill down: ts_header("src/services")
```

```typescript
// path = "src/services" — file TOC
// ==== src/services/ — 6 files ====
userService.ts    312L   UserService, createUserService, UserId, User, Role
authService.ts    421L   AuthService, TokenPair, verifyToken, refreshToken
index.ts           14L   barrel: ./userService, ./authService
// drill down: ts_header("src/services/userService.ts")
```

Name lists cap at ~8 per line with `+n more`. `node_modules`, declaration output dirs, and gitignored paths are excluded. Test files are listed but tagged `test` so agents can skip them.

## 7. Broken Code Behavior

Best-effort with **per-symbol error markers**. Agents need headers most when the build is red; the TS parser is aggressively error-recovering, so an AST is virtually always available, and type inference degrades locally rather than globally.

```typescript
processOrder(o: Ordr): unknown      // L84 ⚠ TS2304: Cannot find name 'Ordr' — type unreliable
getUser(id: UserId): Promise<User>  // L45
```

Unparseable regions get a gap marker: `// ⚠ L120-140: skipped, syntax error TS1005`. If a file exceeds 10 errors, a one-line banner with the count is added at the top of that file's header — at that density the agent should know before reading sixty signatures. Markers carry the TS error code so a capable agent can act on it; a weak agent just learns "distrust this line," which is the essential signal.

## 8. Token Budgeting & Truncation

`max_tokens` (default 4000, estimated at 4 chars/token to avoid a tokenizer dependency). When a file header would exceed the budget: emit complete top-level structure first, then truncate member detail from the largest classes, replacing elided runs with `// … 14 more members, L88-190 — ts_header(path, {max_tokens: 12000}) for all`. Never emit a partial signature. Directory TOCs that exceed budget paginate by subdirectory with an explicit continuation hint.

## 9. Implementation Decisions

**Stack: raw TypeScript compiler API** (`ts.createLanguageService`), not ts-morph. Rationale: (a) modern-syntax support is a hard requirement, and ts-morph pins the compiler and historically lags TS releases; (b) the genuinely hard parts — project-reference wiring and long-lived incremental serving — are where ts-morph's ergonomics evaporate anyway; (c) no wrapper-object memory management in a daemon. Cost accepted: ~2–3× extractor LOC. Hedge: the Extractor interface (§3) permits a ts-morph v0 implementation if development bogs down.

**Language/runtime:** TypeScript on Node ≥ 20, `@modelcontextprotocol/sdk`, stdio transport. Zero other runtime dependencies beyond `typescript` itself.

**Positions:** `sourceFile.getLineAndCharacterOfPosition(decl.name.getStart())` — line of the *name*, not of leading trivia/decorators, so L-numbers land on the identifier a human or agent would look for. Decorated declarations additionally note the decorator range when it differs.

**JSDoc:** via `ts.getJSDocCommentsAndTags`; "first sentence" = text up to the first `.` followed by whitespace/EOL, capped at 100 chars.

**tsconfig discovery:** walk up from the file; cache dir→config resolution; honor `extends` and `references`; files matching no tsconfig get an inferred default project (matching tsserver behavior).

## 10. Decision Log

| # | Decision | Choice | Alternatives rejected |
|---|---|---|---|
| 1 | Delivery | MCP tool returns text on demand | Sidecar files on disk (stale-file risk, write pollution) |
| 2 | Type knowledge | Compiler API, inferred types | Syntax-only parse (misses inferred returns) |
| 3 | Coverage | Exports default, `depth` flag up to inner functions | Everything-always (token waste); exports-only (misses inner structure) |
| 4 | Doc default | `brief` after-signature, `none`/`full` selectable, server default configurable | Always-full JSDoc (buries structure) |
| 5 | Dense blocks | Group when block > 6 lines | Always group (loses jump targets); never (noise) |
| 6 | Granularity | Hierarchical via one adaptive tool | Three tools per level (tool-selection burden); files-only (relies on filename guessing) |
| 7 | tsconfig | Auto-discover + project references | Single fixed config (breaks monorepos) |
| 8 | Broken code | Best-effort + per-symbol ⚠ markers | Fail loudly (useless mid-refactor); banner-only (untargeted distrust) |
| 9 | Stack | Raw compiler API behind Extractor interface | ts-morph (version lag vs modern-TS requirement, daemon memory) |

## 11. Open Questions (deferred, not blocking)

Whether `docs:"auto"` (include the sentence only when it adds information beyond the name) is worth the heuristic complexity. Whether a `symbol` parameter (`ts_header(path, {symbol: "UserService"})`) earns its place for surgical lookups, or whether that duplicates what LSP-backed tools do better. Whether to emit an optional machine-readable JSON variant of `FileHeaderModel` for orchestrators. Vue/Svelte SFC script blocks. Eviction tuning for very large monorepos (>50 packages).

## 12. Milestones

**M1 — extractor + formatter, single file, exports depth, no cache.** Prove the format on real files including broken ones. **M2 — LanguageService project manager, cache, watcher, directory/project TOCs.** **M3 — MCP wiring, tool description tuning, token budgeting.** **navigation eval (design-doc milestone M4) — eval:** run a weak model (e.g., a small local model or Haiku-class) on navigation tasks in a mid-size repo with and without ts-header; measure files-read and wrong-file-reads.

## 13. Alternate approaches considered

## Comparison at a Glance

| | Syntax-only API | Full checker | `.d.ts` emit | ts-morph | tree-sitter |
|---|---|---|---|---|---|
| Latency (per file) | ms | ms after warm-up; slow cold start | seconds | ms | sub-ms |
| Inferred types | ❌ | ✅ | ✅ | optional | ❌ |
| Works on broken code | ✅ | mostly | ❌ | ✅ | ✅✅ |
| Config-free | ✅ | ❌ | ❌ | mostly | ✅ |
| Non-exported symbols | ✅ | ✅ | ❌ | ✅ | ✅ |
| Multi-language future | ❌ | ❌ | ❌ | ❌ | ✅ |


Standalone MCP vs. Extension-Hosted

| | Standalone Node MCP server | VS Code extension (A) | Extension-wrapped MCP (B) |
|---|---|---|---|
| Claude Code (terminal) | ✅ | ❌ | ❌ (but server still runs standalone) |
| Claude Desktop / Cursor / Windsurf / Zed | ✅ | ❌ | VS Code only |
| Copilot agent mode | ✅ (VS Code supports MCP) | ✅ | ✅ |
| Headless / CI / scripted agents | ✅ | ❌ | ❌ |
| Sees unsaved editor buffers | ❌ (disk only) | ✅ | ❌ |
| File watching | roll your own or mtime checks | free (`FileSystemWatcher`) | roll your own |
| Distribution | manual config / npm | Marketplace | Marketplace |
| Test surface | plain Node, trivial | extension host harness | mostly plain Node |
| Lifecycle complexity | you own it (simple) | activation events, extension host | VS Code manages spawn |
