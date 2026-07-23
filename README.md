# ts-header-mcp

An MCP server that produces a header-file view of TypeScript source for AI coding agents: function, class, and type signatures annotated with their original line numbers, requestable per file, per directory, or for the whole project.

```typescript
// ==== src/services/userService.ts — 312 lines, 8 exports ====

export class UserService {                                      // L24-198
  constructor(db: Database, cache?: CacheLayer)                 // L31
  getUser(id: UserId): Promise<User | null>                     // L45
      // Fetches a user by ID, checking cache first.
  patch(id: UserId, p: Partial<User>): Promise<User>            // L69 ⚠ deprecated
}

// -- types: L201-240 --
export type UserId = Brand<string, "UserId">;
export interface User { id: UserId; name: string; email: string; roles: Role[]; }

export function createUserService(cfg: Config): UserService     // L245
```

The idea is the same as a C header: an agent reads the compact view first, then opens the source only at the line numbers it needs. Return types come from the TypeScript type checker, so inferred returns are shown explicitly. Files with type or syntax errors still produce a header; unreliable signatures are marked individually (`// L84 ⚠ TS2304: Cannot find name 'Ordr'`) rather than failing the whole file.

## How it relates to existing tools

Several existing approaches cover parts of this. Which one fits depends on the agent and the task; ts-header was built for a specific gap.

- **`tsc --emitDeclarationOnly`** produces `.d.ts` files, which are the closest analog to a header. Differences: declaration emit needs a compilable project, writes files into the tree, does not carry source line numbers, and only covers the public surface. If you want a build artifact for consumers of a library, `.d.ts` is the right tool; for navigation by an agent, especially in code that does not currently compile, it falls short.
- **LSP-backed MCP servers** (Serena, lsmcp, symbols-mcp) expose symbol queries as individual tools: get an outline, look up a symbol, find references. They are more precise and more capable than ts-header for surgical questions. The tradeoff is that answering "what is in this codebase" takes a sequence of tool calls with the right arguments, which stronger agents handle well and weaker ones often do not. ts-header collapses that workflow into one tool whose output is complete for the requested path.
- **Repo maps** (Aider's repo map, RepoMapper) generate a single ranked summary of the most important symbols, fitted to a token budget. That is a good format for automatic context injection. It is deliberately lossy, though: symbols that don't rank get omitted, and there is no way to ask for the full contents of one specific file.

What ts-header does that the above do not, in combination:

- Complete per-path output (nothing ranked away) with original line numbers as jump targets
- One tool for all levels: project overview, directory listing, file header
- Works on code that does not compile, with per-symbol error markers
- Includes non-exported and function-local declarations on request
- No files written by default, so nothing can leak into version control
- Focused results with fewer tool calls to improve LLM attention

(See comparison below.) 

## The tool

One tool, `ts_header(path, depth?, docs?, max_tokens?, filter?)`. Navigation depth is expressed by the path, so the interaction model is the familiar `ls` / `cat` pattern rather than a set of tools to choose between.

- `path`: file or directory, relative to the workspace. A directory of directories returns a project overview; a directory of files returns a per-file export list (with barrel-file detection and `[test]` tagging); a file returns the full header. `"."` gives the project overview. Also accepts an array of file paths or a glob pattern (`"src/**/*.ts"`) for batch multi-file headers in one call, capped at 20 files; the token budget is split across the batch, and per-item problems (missing file, directory, non-TS) are reported inline without failing the rest.
- `depth`: `exports` (default) | `all` (adds non-exported declarations and private members) | `deep` (also descends into function bodies: inner functions, closures, locally declared classes).
- `docs`:  `none` | `brief` (default: first JSDoc sentence; shown after single-line signatures, before multi-line declarations) | `full` (complete JSDoc including `@param` and `@throws`). `@deprecated` is always shown regardless of mode. A JSDoc block at the very top of a file is treated as the file's description rather than the first declaration's: it renders under the header banner and as a short annotation on the file's row in directory listings.
- `max_tokens`: approximate output budget, default 4000. Truncated output says so and how to request more.
- `filter`: show only symbols whose name matches a pattern (case-insensitive regex; plain text works too). Applies at every level, so `ts_header(".", {filter: "booking"})` acts as a lightweight typed symbol search across the project. Filters names only; full-text search inside function bodies remains grep's job.
- `includeImports`: when true, the header opens with a `// -- imports --` block listing the file's import statements, collapsed to one line each and elided to 120 characters. Off by default (imports rarely earn their tokens for orientation).

For framework-wrapper declarations like Convex's `export const f = mutation({ args: {...}, handler: ... })`, the header adds a `// args:` line under the signature showing the validator shape as written (or the handler's parameter list when there is no `args` property). The line is suppressed when it would only restate the property names already visible in the checked signature; when too long, whole properties are elided with `…n more` rather than cut mid-identifier.

### Visual Comparison: ts-header vs. Alternatives

| Capabilities | ts-header | LSP Servers | Repo Maps (Aider) | tsc --emitDeclaration |
| :--- | :---: | :---: | :---: | :---: |
| **Retains Line Numbers** | **Yes (Lnn)** | Yes (symbol) | No | No |
| **Token Budget Aware** | **Yes** | No | **Yes** | No |
| **Works on Uncompilable Code** | **Yes** | Yes | Yes | No |
| **One-Shot Project Navigation**| **Yes** | No (Multi-step) | **Yes** (Lossy) | No |
| **Includes Private/Local Symbols**| **Optional** | Yes | No | No |


## Comparison of `ts_header` tool and standard `grep` exploration

Ran the exact same query `Explain how waitlist queues work in this project` over a large, complex project. One session used `ts_header` and the other did not.
Thes test used same LLM (Google Flash 3.5) in Antigravity IDE.

### Summary Comparison

| Dimension | Session 1 (`NO ts_header tool`)                                                                                                                            | Session 2 (`with ts_header`)                                                                 |
| :--- |:-----------------------------------------------------------------------------------------------------------------------------------------------------------|:---------------------------------------------------------------------------------------------|
| **Initial Discovery Strategy** | Unfiltered `grep_search("waitlist")` (200 matches)                                                                                                         | Structured `ts_header` directory scan & filter                                               |
| **Module Coverage** | Found 4 key files; missed `bookingsCheckIn.ts` in `convex/convex/bookingsCheckIn.ts` & `bookingsNotifications.ts` `convex/convex/bookingsNotifications.ts` | Found all 5 waitlist-related files across `convex/` and `domain/`                            |
| **Tool Execution Efficiency** | Trial-and-error grepping + full-file viewing                                                                                                               | Hierarchical: Directory overview → Filtered signatures → Targeted line views                 |
| **Explanation Completeness** | Solid overview of placement, offering, claiming, and expiration                                                                                            | Complete end-to-end trace including admin no-show spot releases and background notifications |

---

### Detailed Comparison & Evaluation

#### 1. Information Discovery & Signal-to-Noise Ratio
* **Session 1 Strategy**:
    1. `grep_search("waitlist")` (200 matches across web app, admin app, tests, docs).
    2. `view_file` on `bookingsWaitlist.ts` (entire 373 lines at once).
    3. `grep_search("offerSpotToWaitlist")`.
    4. `view_file` on `bookingRules.ts`.
    5. `grep_search('bookingStatus: "waitlisted"')` (0 matches due to quotes formatting).
    6. `view_file` on `bookings.ts`.
    * *Drawback*: High noise level, unstructured exploration, and redundant view calls.

* **Session 2 Strategy**:
    1. `ts_header(".")`: Identified major modules (`apps/`, `convex/`, `domain/`, `tooling/`).
    2. `ts_header(".", { filter: "waitlist" })`: Instantly returned the exact matching files:
        - `convex/bookingsCheckIn.ts` (`releaseSpotToWaitlist`)
        - `convex/bookingsNotifications.ts` (`sendWaitlistOfferNotification`)
        - `convex/bookingsWaitlist.ts` (`offerSpotToWaitlist`)
        - `domain/src/bookingRules.ts]` (`selectNextWaitlisted`)
    3. `ts_header([files...])`: Fetched line-numbered signatures for all exported functions before viewing source lines.
    4. `view_file`: Targeted exact line numbers (e.g. lines `138–172` in `bookingsCheckIn.ts`
    * *Advantage*: High signal-to-noise ratio, zero wasted lines, clean mental model of function contracts upfront.

#### 2. Output Accuracy & Completeness
* **Session 1 Explanation**: Accurately described queue entry `convex/domain/src/bookingRules.ts#L25`, `offerSpotToWaitlist`, `acceptOffer`, `declineOffer`, and `expireOffer`. However, it missed how admin check-in releases (`releaseSpotToWaitlist` in `convex/convex/bookingsCheckIn.ts#L138) and reallocation hooks (`reallocation.ts` in `convex/convex/reallocation.ts#L38`) trigger the queue offering flow.
* **Session 2 Explanation**: Produced a more thorough explanation because `ts_header` captured all entry points into the waitlist system across the entire monorepo, explicitly highlighting:
    - Admin no-show spot releases (`releaseSpotToWaitlist` in `convex/convex/bookingsCheckIn.ts#L138`).
    - Automated waitlist offer notifications (`sendWaitlistOfferNotification` in `convex/convex/bookingsNotifications.ts#L6`).
    - Integration with spot reallocation optimization (`optimizeSchedule` in `convex/convex/reallocation.ts#L12)).

---

### Final Evaluation

**Session 2 (using `ts_header` tool) was significantly superior in execution quality:**
1. **Efficiency**: Session 2 used top-down index-driven discovery instead of trial-and-error text grepping.
2. **Comprehensive Synthesis**: Session 2 discovered and incorporated entry points (notifications, check-in releases) that Session 1 overlooked.

## Install

Requires Node 20+.

```bash
git clone https://github.com/<your-username>/ts-header-mcp.git ~/tools/ts-header
cd ~/tools/ts-header
npm install
npm test                     # quiet unit suite (extractor, formatter, router)
npm run smoke-test           # verbose: prints full example headers for eyeballing
npm run build                # -> dist/server.js and dist/cli.js
```

Cloning outside your working repositories (e.g. `~/tools`) keeps the server out of your projects' version control.

Note for TypeScript 6.0+: the compiler no longer auto-includes packages from `node_modules/@types`, so the project tsconfig sets `"types": ["node"]` explicitly. If you see `TS2591: Cannot find name 'process'` during `npm run build`, that line is missing.

## CLI Usage

For non-MCP integrations or command-line scripting, you can run the CLI directly from the terminal.

```bash
# Run using node
node dist/cli.js <workspaceRoot> <path> [options]

# Or via the ts-header-cli command if installed/linked
ts-header-cli <workspaceRoot> <path> [options]
```

### Options
* `--depth=exports|all|deep`: Level of declaration detail to extract.
* `--docs=none|brief|full`: JSDoc detail level.
* `--max-tokens=N`: Approximate token budget limit.
* `--filter=PATTERN`: RegEx pattern to filter symbols by name.

The output is written to `stdout`, and any errors to `stderr` (exits with code `0` on success, `1` on error).

## Client setup

The server speaks stdio. The second `args` entry is the workspace it serves; if omitted, it uses the process working directory.

### VS Code (Copilot agent mode)

Create `.vscode/mcp.json` in your workspace (this file is safe to commit) or run `MCP: Open User Configuration` from the Command Palette for a user-level config. Note the root key is `servers`, not `mcpServers`, and `${workspaceFolder}` is supported:

```json
{
  "servers": {
    "ts-header": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/you/tools/ts-header/dist/server.js", "${workspaceFolder}"]
    }
  }
}
```

MCP tools are only available in Copilot's Agent mode (mode dropdown in the Chat view). If the server misbehaves, `MCP: List Servers` → select it → Show Output shows its stderr.

### Cursor

Create `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects. Cursor uses the `mcpServers` root key; use absolute paths:

```json
{
  "mcpServers": {
    "ts-header": {
      "command": "node",
      "args": ["/home/you/tools/ts-header/dist/server.js", "/path/to/your/workspace"]
    }
  }
}
```

Enable the server under Cursor Settings → MCP if it does not appear automatically. For a global config serving multiple projects, add one entry per workspace (e.g. `ts-header-projA`, `ts-header-projB`).

### Google Antigravity (2.x)

The shared config is `~/.gemini/config/mcp_config.json` (pre-2.0 installs used `~/.gemini/antigravity/mcp_config.json`). You can open the right file from inside the IDE: agent panel `…` menu → MCP Servers → Manage MCP Servers → View raw config. Merge an entry into the existing `mcpServers` object (same shape as the Cursor example, absolute paths, no `~` in the JSON), then refresh under Settings → Customizations → Installed MCP Servers.

<details>
<summary>Prompt to have Antigravity's agent do the setup for you</summary>

Replace the two placeholders and paste into the agent panel:

```
Set up a local MCP server called ts-header for me. Follow these steps exactly and
verify each one before moving to the next. Do not skip the test step.

SOURCE: https://github.com/<your-username>/ts-header-mcp.git
WORKSPACE IT WILL SERVE: <PATH_TO_MY_TS_PROJECT>

1. PRE-FLIGHT CHECK:
   Run `node -v` to ensure my environment has Node.js version 20 or higher.
   If the version is lower, stop immediately and explain that Node 20+ is required.

2. INSTALL LOCATION: outside any git repo I work in:
   git clone the SOURCE into ~/tools/ts-header. Never copy it into my current
   workspace; nothing from this setup may be committed to any of my repositories.

3. BUILD AND TEST:
   cd ~/tools/ts-header
   npm install
   npm test                      # unit suite: must end with "fail 0"
   npm run build                 # produces dist/server.js
   If a test fails, stop and show me the full output. Do not modify the source
   to make tests pass without telling me what you changed and why.

4. REGISTER THE SERVER:
   Find my MCP config: ~/.gemini/config/mcp_config.json on current Antigravity
   versions (older installs used ~/.gemini/antigravity/mcp_config.json ...use
   whichever exists; if both exist, use the one the IDE opens via the agent
   panel "…" menu > MCP Servers > Manage MCP Servers > View raw config).
   MERGE the following entry into the existing "mcpServers" object. Do NOT
   overwrite or remove any server already in the file. Show me a diff of the
   config change before saving.

   "ts-header": {
     "command": "node",
     "args": ["<ABSOLUTE HOME PATH>/tools/ts-header/dist/server.js",
              "<WORKSPACE IT WILL SERVE>"]
   }

   Use real absolute paths (no ~ inside the JSON).

5. ACTIVATE AND VERIFY:
   Refresh MCP servers (Settings > Customizations > Installed MCP Servers >
   Refresh, or restart the IDE). Confirm "ts-header" appears with one tool,
   ts_header. If the server fails to start, run
   node ~/tools/ts-header/dist/server.js <WORKSPACE> manually, capture stderr,
   and show it to me before changing anything.

6. SMOKE-TEST THE TOOL by calling it three times and showing me each output:
   ts_header(".")                             -> project overview
   ts_header("<some src directory>")          -> per-file export list
   ts_header("<one .ts file from that list>") -> signatures with // L45 numbers

7. FROM NOW ON, in this workspace: when you need to understand TypeScript code,
   call ts_header on the directory or file FIRST, and only open source files at
   the specific line numbers it reports. Do not read whole .ts files for
   orientation. Add this rule to your project rules/memory if you support that.

Report back with: install path, which config file you edited, the config diff,
test results, and the three smoke-test outputs.
```

</details>

### Mirica

Mirica's custom MCP tools are sandboxed JavaScript files (fetch-only, no process spawning), so they cannot launch a stdio server. Instead, a small HTTP bridge (`http-server.mjs`, in this repo) wraps the same router and serves plain JSON on `127.0.0.1:7461`, and a Mirica tool file calls it via `fetch()`.

```bash
# 1. Build, then start the bridge (detached; survives closing the terminal)
npm run build
nohup node /path/to/ts-header/http-server.mjs >/tmp/ts-header-http.log 2>&1 &

# 2. Install the tool file
cp mirica-tool/ts_header.js \
  ~/Library/Application\ Support/ArtificialNecessity/MiricaLLMData/custom-mcp-tools/
#  (Windows: %LOCALAPPDATA%\ArtificialNecessity\MiricaLLMData\custom-mcp-tools\)
```

Then click **Reload Tools** in Mirica's Settings → MCP Tools. The tool appears as `ts_header__view` and takes an extra `workspace` argument (absolute path to the project to serve), since one bridge serves any number of workspaces.

The bridge does not persist across reboots. To restart it, rerun the `nohup` line above ...or just ask a Mirica agent to start it; the tool's error message on a failed connection includes the exact command. Check whether it is running with `curl -s http://127.0.0.1:7461/health`.

If you change the bridge or the tool: restart the bridge (kill the `node .../http-server.mjs` process and rerun it) after rebuilding, and re-copy `mirica-tool/ts_header.js` + Reload Tools after editing the tool file.

Whichever client you use, an instruction like step 6 above (in project rules, `.cursorrules`, or the equivalent) makes a real difference: without it, agents tend to fall back to reading whole files.

## Files, caching, and sandboxes

By default the server performs no disk writes; all caching is in-memory, and it runs in a read-only sandbox. Compiler options are overridden with `noEmit` and `incremental: false` when programs are created, so a workspace tsconfig with `incremental: true` cannot cause a `.tsbuildinfo` file to appear in your repository. There is a regression test for that case.

A persistent cache is available as an opt-in via `TS_HEADER_CACHE=1`. Its location resolves in order: `TS_HEADER_CACHE_DIR`, then `$XDG_CACHE_HOME/ts-header`, then `os.tmpdir()/ts-header`. Each candidate is probe-written at startup; if none is writable the server logs one line and continues memory-only. If you deliberately point the cache inside a workspace, a `.gitignore` containing `*` is written into the cache directory.

Directory listings respect the workspace-root `.gitignore` (a common subset: `*`, `?`, `**`, negation, directory patterns) on top of a built-in skip list (`node_modules`, `dist`, `.git`, ...). Nested `.gitignore` files are not read. Directly addressing an ignored file still works; the filter applies to listings only.

Other environment variables:

- `TS_HEADER_GITIGNORE=0`: disable .gitignore handling in listings
- `TS_HEADER_DOCS=none|brief|full`: server-wide default for the `docs` option, useful for testing whether doc summaries earn their tokens for your agents
- `TS_HEADER_DENSE_MIN`: grouping threshold for dense declaration blocks, default 6 source lines
- `TS_HEADER_MAX_PROJECTS`: LanguageService LRU size for monorepos, default 4

## Architecture

`server.ts` (MCP layer, the only module that imports the SDK) and `cli.ts` (CLI entry point) → `router.ts` (path → project overview | directory listing | file header, plus the content-hash cache) → `formatter.ts` (all layout rules) ← `FileHeaderModel` (plain JSON contract in `model.ts`) ← `extractor.ts` (raw TypeScript compiler API) ← `project.ts` (nearest-tsconfig discovery, one long-lived `ts.LanguageService` per config, project-reference sources folded in, LRU eviction).

The extractor sits behind the `FileHeaderModel` contract, so it can be replaced (for example by a tree-sitter implementation) without changes to the formatter, cache, or MCP layers. `ts-header-design.md` contains the design rationale and the decision log.

## Backlog and next steps

Roughly in priority order. The first two come from the original design doc (see `ts-header-design.md` §12); the rest accumulated during field testing on a real monorepo.

1. **Budget-driven tree depth.** The project overview currently shows one directory level. Better: expand subdirectories while the token budget allows, collapsing the largest subtrees first, so depth falls out of `max_tokens` rather than a fixed constant.
2. **Solution-builder project references.** Monorepo references are handled by folding referenced projects' source files into one program — correct, but programs get large in big workspaces. Using the compiler's solution-builder machinery would keep per-package programs separate.
3. **File-watcher invalidation.** Freshness is currently per-request mtime checking (correct, but more `stat` calls than necessary on large projects). An `fs.watch`-based invalidator would make repeated directory listings cheaper.
4. **Multi-workspace serving.** The server serves the single workspace given at startup; one config entry per project is the workaround. Resolving the workspace per-call (from the request path or client `cwd`) would let one registration serve everything.
5. **`docs:"auto"`.** Include the brief doc sentence only when it adds information beyond the symbol name (skip "Fetches a user" on `fetchUser`). Needs a heuristic that fails gracefully; blocked on the eval above to know whether it matters.
6. **Machine-readable output.** An optional JSON variant of `FileHeaderModel` for orchestrators that want to post-process rather than read. The model is already plain JSON internally; this is mostly a `format` parameter.
7. **Nested `.gitignore` files.** Only the workspace-root `.gitignore` is read today; per-directory ignore files are a straightforward extension of `src/ignore.ts`.
8. **Vue/Svelte SFC script blocks.** Extract from `<script lang="ts">` sections. Low priority unless a target codebase needs it.
9. **Overload polish.** Overload chains render tightly, but the implementation signature (not callable in TS) still appears alongside the declaration overloads; `.d.ts` convention would hide it while keeping its L-range on the chain.

Deliberately out of scope: editing/refactoring (read-only tool), full-text search inside function bodies (grep does this better), and importance ranking (headers are complete by design; ranked summaries are Aider-repo-map territory).

## Status and tests

- `npm test` runs the unit suite (`test/unit/`, Node's built-in test runner via tsx, 66 tests): formatter tests are pure-function tests over hand-built models (annotations, docs modes, dense-block grouping, error banners, truncation, TOC layout); extractor tests build one program over the shared fixture and assert on the model structure (depth semantics, inferred return types, overloads, JSDoc extraction, diagnostic attachment, barrel detection); router tests build a throwaway workspace in the OS temp dir and cover all three navigation levels, the `filter` parameter, `.gitignore` handling, guard rails, and the zero-writes invariant (including with an `incremental: true` tsconfig). A Convex-shaped fixture guards the framework-code regressions found in field testing: large `export const x = framework({...})` declarations keep their own line annotations, and rendered types are length-capped with `import("...")` qualifiers stripped.
- `npm run smoke-test` is intentionally verbose: it prints complete rendered headers for the fixture at two depth/docs combinations, for human review of the output format, followed by a summary set of assertions.
- `server.ts` targets `@modelcontextprotocol/sdk` ^1.x. It was written in an environment without registry access, so the SDK wiring is the one part not exercised by the test suite; everything beneath it is executed and type-checked under `--strict`.

Known limitations, planned as follow-ups: cache invalidation is per-request mtime checking rather than a file watcher (correct, but more stat calls than necessary on large projects); project references are handled by folding referenced sources into one program, which is accurate but can make programs large in big monorepos (a solution-builder approach would fix this); and the design doc describes an evaluation comparing an agent's wrong-file reads with and without the tool, which has not been run yet.
