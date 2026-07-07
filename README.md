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

## The tool

One tool, `ts_header(path, depth?, docs?, max_tokens?)`. Navigation depth is expressed by the path, so the interaction model is the familiar `ls` / `cat` pattern rather than a set of tools to choose between.

- `path` — file or directory, relative to the workspace. A directory of directories returns a project overview; a directory of files returns a per-file export list (with barrel-file detection and `[test]` tagging); a file returns the full header. `"."` gives the project overview.
- `depth` — `exports` (default) | `all` (adds non-exported declarations and private members) | `deep` (also descends into function bodies: inner functions, closures, locally declared classes).
- `docs` — `none` | `brief` (default: first JSDoc sentence, shown after the signature) | `full` (complete JSDoc including `@param` and `@throws`). `@deprecated` is always shown regardless of mode.
- `max_tokens` — approximate output budget, default 4000. Truncated output says so and how to request more.

## Install

Requires Node 20+.

> [!NOTE]
> Script steps assume destination is `~/tools`. Edit for your setup.

```bash
git clone https://github.com/<your-username>/ts-header-mcp.git ~/tools/ts-header
cd ~/tools/ts-header
npm install
npm test                     # quiet unit suite (extractor, formatter, router)
npm run smoke-test           # verbose: prints full example headers for eyeballing
npm run build                # -> dist/server.js
```

Cloning outside your working repositories (e.g. `~/tools`) keeps the server out of your projects' version control.

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

1. INSTALL LOCATION — outside any git repo I work in:
   git clone the SOURCE into ~/tools/ts-header. Never copy it into my current
   workspace; nothing from this setup may be committed to any of my repositories.

2. BUILD AND TEST:
   cd ~/tools/ts-header
   npm install
   npm test                      # unit suite — must end with "fail 0"
   npm run build                 # produces dist/server.js
   If a test fails, stop and show me the full output. Do not modify the source
   to make tests pass without telling me what you changed and why.

3. REGISTER THE SERVER:
   Find my MCP config: ~/.gemini/config/mcp_config.json on current Antigravity
   versions (older installs used ~/.gemini/antigravity/mcp_config.json — use
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

4. ACTIVATE AND VERIFY:
   Refresh MCP servers (Settings > Customizations > Installed MCP Servers >
   Refresh, or restart the IDE). Confirm "ts-header" appears with one tool,
   ts_header. If the server fails to start, run
   node ~/tools/ts-header/dist/server.js <WORKSPACE> manually, capture stderr,
   and show it to me before changing anything.

5. SMOKE-TEST THE TOOL by calling it three times and showing me each output:
   ts_header(".")                             -> project overview
   ts_header("<some src directory>")          -> per-file export list
   ts_header("<one .ts file from that list>") -> signatures with // L45 numbers

6. FROM NOW ON, in this workspace: when you need to understand TypeScript code,
   call ts_header on the directory or file FIRST, and only open source files at
   the specific line numbers it reports. Do not read whole .ts files for
   orientation. Add this rule to your project rules/memory if you support that.

Report back with: install path, which config file you edited, the config diff,
test results, and the three smoke-test outputs.
```

</details>

Whichever client you use, an instruction like step 6 above (in project rules, `.cursorrules`, or the equivalent) makes a real difference: without it, agents tend to fall back to reading whole files.

## Files, caching, and sandboxes

By default the server performs no disk writes; all caching is in-memory, and it runs in a read-only sandbox. Compiler options are overridden with `noEmit` and `incremental: false` when programs are created, so a workspace tsconfig with `incremental: true` cannot cause a `.tsbuildinfo` file to appear in your repository. There is a regression test for that case.

A persistent cache is available as an opt-in via `TS_HEADER_CACHE=1`. Its location resolves in order: `TS_HEADER_CACHE_DIR`, then `$XDG_CACHE_HOME/ts-header`, then `os.tmpdir()/ts-header`. Each candidate is probe-written at startup; if none is writable the server logs one line and continues memory-only. If you deliberately point the cache inside a workspace, a `.gitignore` containing `*` is written into the cache directory.

Other environment variables:

- `TS_HEADER_DOCS=none|brief|full` — server-wide default for the `docs` option, useful for testing whether doc summaries earn their tokens for your agents
- `TS_HEADER_DENSE_MIN` — grouping threshold for dense declaration blocks, default 6 source lines
- `TS_HEADER_MAX_PROJECTS` — LanguageService LRU size for monorepos, default 4

## Architecture

`server.ts` (MCP layer, the only module that imports the SDK) → `router.ts` (path → project overview | directory listing | file header, plus the content-hash cache) → `formatter.ts` (all layout rules) ← `FileHeaderModel` (plain JSON contract in `model.ts`) ← `extractor.ts` (raw TypeScript compiler API) ← `project.ts` (nearest-tsconfig discovery, one long-lived `ts.LanguageService` per config, project-reference sources folded in, LRU eviction).

The extractor sits behind the `FileHeaderModel` contract, so it can be replaced (for example by a tree-sitter implementation) without changes to the formatter, cache, or MCP layers. `ts-header-design.md` contains the design rationale and the decision log.

## Status and tests

- `npm test` runs the unit suite (`test/unit/`, Node's built-in test runner via tsx, 40 tests): formatter tests are pure-function tests over hand-built models (annotations, docs modes, dense-block grouping, error banners, truncation, TOC layout); extractor tests build one program over the shared fixture and assert on the model structure (depth semantics, inferred return types, overloads, JSDoc extraction, diagnostic attachment, barrel detection); router tests build a throwaway workspace in the OS temp dir and cover all three navigation levels, guard rails, and the zero-writes invariant (including with an `incremental: true` tsconfig).
- `npm run smoke-test` is intentionally verbose: it prints complete rendered headers for the fixture at two depth/docs combinations, for human review of the output format, followed by a summary set of assertions.
- `server.ts` targets `@modelcontextprotocol/sdk` ^1.x. It was written in an environment without registry access, so the SDK wiring is the one part not exercised by the test suite; everything beneath it is executed and type-checked under `--strict`.

Known limitations, planned as follow-ups: cache invalidation is per-request mtime checking rather than a file watcher (correct, but more stat calls than necessary on large projects); project references are handled by folding referenced sources into one program, which is accurate but can make programs large in big monorepos (a solution-builder approach would fix this); and the design doc describes an evaluation comparing an agent's wrong-file reads with and without the tool, which has not been run yet.
