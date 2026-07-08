# Plan: Batch File Inspection, Import Signatures, Symbol Snippet Previews

Status: PLANNED (not started)
Audience: an implementing agent. Follow the checklist in order; each feature is
independent but they share doc/test updates, so finish all three before the
"Documentation" and "Release" sections.

## Architecture recap (where things go)

Request flow: `server.ts` (MCP) / `cli.ts` (CLI) / `http-server.mjs` (HTTP bridge)
→ `router.ts` (path routing + cache) → `extractor.ts` (compiler API → `FileHeaderModel`
in `model.ts`) → `formatter.ts` (model → text).

Rules that constrain this work:
- `model.ts` stays plain JSON — no `ts.*` types.
- `extractor.ts` is the only module that touches `ts.*` nodes.
- All layout decisions live in `formatter.ts`.
- The cache key in `router.fileModel()` is `contentHash : depth : EXTRACTOR_VERSION`.
  Any change to what the extractor emits REQUIRES bumping `EXTRACTOR_VERSION`
  (currently `"3"`, in `router.ts`).

---

## Feature 1: Batch file inspection

`path` may be an array of strings and/or contain glob patterns. One call returns
concatenated headers.

### Behavior spec

- `path: "src/a.ts"` — unchanged (string, no glob chars).
- `path: ["src/a.ts", "src/b.ts"]` — headers for both, concatenated, in the
  given order, separated by one blank line.
- Glob support (keep it minimal): `*` (within a segment), `**` (across segments),
  `?` (single char). A string containing any of `* ? [` is treated as a glob.
  Globs match FILES only (TS files, excluding `.d.ts`), never directories.
- Globs respect the same exclusions as directory walks: `SKIP_DIRS`, dot-dirs,
  `.gitignore`.
- Mixed arrays are fine: `["src/router.ts", "test/**/*.test.ts"]`.
- Deduplicate resolved files (array entry + glob may overlap); keep first position.
- Errors are per-item, not fatal: a missing path contributes a `// not found:`
  line to the output; other items still render.
- Budget: `max_tokens` is the budget for the WHOLE response. Divide it evenly
  across resolved files (`per_file = max(500, floor(max_tokens / count))`) and
  pass as each file's `maxTokens`. If the concatenation still exceeds the total
  budget, stop adding files and append a summary line listing files omitted.
- Cap: refuse more than 20 resolved files with a message telling the caller to
  narrow the glob (do not silently truncate a wild glob).
- A glob that matches nothing → `// no files matching <pattern>` line.
- Directory paths inside an array: reject with a per-item message
  (`// <p> is a directory — pass it as a plain string path instead`). This keeps
  batch = files-only and avoids TOC-inside-batch layout questions.

### Implementation (pseudo code)

`router.ts`:

```
TsHeaderRequest.path : string | string[]        # widen the type

handle(req):
    if req.path is array OR (req.path is string AND containsGlobChars(req.path)):
        return this.handleBatch(asArray(req.path), depth, docs, maxTokens, matcher, filter)
    ... existing single-path logic unchanged ...

handleBatch(patterns, ...):
    files = []
    notes = []   # per-item error/info lines
    for p in patterns:
        if containsGlobChars(p):
            matched = globWalk(workspaceRoot, p)     # respects SKIP_DIRS, gitignore, TS_FILE, !DTS_FILE
            if matched empty: notes.push("// no files matching " + p)
            else: files.append(matched)
        else:
            abs = resolveInWorkspace(p)              # reuse; catch throw -> notes.push(not found)
            if not exists: notes.push(notFound(p))
            elif isDirectory: notes.push("// " + p + " is a directory — ...")
            elif not TS_FILE: notes.push(existing non-TS message)
            else: files.push(abs)
    files = dedupe(files)
    if files.length > 20: return "// batch too large (N files) — narrow the glob or split the call"
    perFile = max(500, floor(maxTokens / files.length))
    parts = notes
    used = 0
    for abs in files:
        header = <existing single-file path: fileModel + filter + formatFileHeader with maxTokens=perFile>
        if used + estTokens(header) > maxTokens:
            parts.push("// budget exhausted — omitted: " + remainingRelPaths.join(", "))
            break
        parts.push(header); used += estTokens(header)
    return parts.join("\n\n")
```

Refactor hint: extract the existing single-file branch of `handle()` (the part
after the directory check) into a private `fileHeader(abs, depth, docs, maxTokens,
matcher, filter): string` and call it from both `handle` and `handleBatch`, so the
filter/not-found behavior cannot drift between the two.

`globWalk` (new, in `router.ts` or a small helper in `ignore.ts`'s style):

```
globWalk(root, pattern):
    regex = globToRegex(pattern)     # '**' -> '(.*)', '*' -> '[^/]*', '?' -> '[^/]', escape the rest
    walk from root (same skip rules as findMatchingFiles walk)
    collect files where TS_FILE and not DTS_FILE and regex.test(relPath)
    return sorted absolute paths
```

Do NOT add a glob npm dependency; the three-operator subset above is enough and
keeps the dependency footprint at zero.

Entry points — widen the schema in all three:
- `server.ts`: `path: z.union([z.string(), z.array(z.string())])`, update its
  `.describe()`. The roots-matching logic (`fs.existsSync(fullPath)`) should use
  the FIRST non-glob array element, else fall back to first root.
- `cli.ts`: accept comma-separated paths OR repeated positional args (pick one —
  comma-separated is simpler: `split(",")` when the path arg contains a comma).
- `http-server.mjs`: no change needed if it just forwards `body.path` (verify the
  "missing 'path'" guard accepts arrays: use `body.path == null` instead of falsy-check).
- `mirica-tool/ts_header.js`: no schema change strictly needed (Mirica params are
  JSON), but update the `path` description to mention arrays/globs.

### Tests (`test/unit/router.test.ts` pattern — temp workspace)

- array of 2 files → both headers present, in order, separated by blank line
- glob `src/**/*.ts` → matches nested files, skips `node_modules` and `.d.ts`
- array with one missing file → other file still rendered + not-found line
- duplicate resolution (file listed twice) → rendered once
- >20 files → refusal message, no headers
- directory in array → per-item rejection message
- `filter` applies inside batch items

---

## Feature 2: `includeImports` flag (default false)

### Behavior spec

- New boolean option `includeImports` on the tool/CLI/HTTP/router request.
- When true and the target is a FILE header, render an import block directly
  under the `// ==== path ====` banner (after `fileDoc`, before entries):

```
// -- imports --
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import * as bookings from "@roar/domain";
```

- Render imports as written but whitespace-collapsed to one line each (same
  collapse rule as `printedEntry`: `replace(/\s+/g, " ")`). If a collapsed import
  exceeds 120 chars, elide the named-import list: `import { a, b, … } from "x"`.
- No line-number annotations on imports (they are context, not jump targets).
- Directory/TOC views ignore the flag (imports are a per-file concern).
- Interaction with `filter`: imports are shown unfiltered (they are file context).

### Implementation (pseudo code)

This changes extractor output → model → formatter, so:
**bump `EXTRACTOR_VERSION` in `router.ts` to `"4"`.**

`model.ts`:
```
FileHeaderModel += imports: string[]      # always populated; formatter decides visibility
HeaderOptions   += includeImports: boolean   (DEFAULT_OPTIONS: false)
```
Always extracting (rather than conditionally) keeps the cache key free of an
`includeImports` dimension — visibility is a formatting decision.

`extractor.ts`, in the statement loop where imports are currently skipped (~L73):
```
if isImportDeclaration or isImportEqualsDeclaration:
    statementCount--
    imports.push(collapseWhitespace(stmt.getText(sf)))
    continue
```
Return `imports` in the model.

`formatter.ts`, `formatFileHeader` after the banner/fileDoc:
```
if opts.includeImports and model.imports is non-empty (guard: may be undefined on old cached models):
    emit "// -- imports --"
    for imp in model.imports: emit elideImport(imp, 120)
    emit blank line
```

`router.ts`: add `includeImports?: boolean` to `TsHeaderRequest`, thread into the
`formatFileHeader` options (both `handle` and the single-match filter path in
`directory()`, plus the batch path from Feature 1).

Entry points: add the boolean to `server.ts` zod schema, `cli.ts`
(`--include-imports`), `http-server.mjs` passthrough, and `mirica-tool/ts_header.js`
`MCP_TOOLS.view.parameters` + the `view()` fetch body.

### Tests

- extractor: fixture with 3 import styles (named, type-only, namespace) →
  `model.imports` has 3 collapsed entries
- formatter: `includeImports: false` (default) → no `-- imports --` block;
  `true` → block present, above first entry
- long import list → elided with `…`, line <= 120 chars
- persisted-cache model WITHOUT `imports` field → no crash (undefined guard)
  — covered implicitly by the EXTRACTOR_VERSION bump, but keep the guard anyway

---

## Feature 3: Snippet preview for opaque signatures

### Problem restatement

`export const acceptOfferInternal: RegisteredMutation<"internal", …>` hides the
args shape that lives INSIDE the call expression (e.g. Convex
`internalMutation({ args: {...}, handler: ... })`). The checker-rendered type is
either huge or opaque; the useful part is the inline `args`/parameter object
literal in the initializer.

### Behavior spec

- Applies when `docs` is `brief` or `full` (i.e. NOT `none` — reuses the existing
  docs knob, no new option).
- Applies to `const`/`let` entries whose initializer is a CALL EXPRESSION with an
  object-literal argument (the framework-wrapper shape). Plain consts, functions,
  classes are unchanged (their signatures already show parameters).
- For such entries, render a preview block under the signature, indented like a
  doc line:

```
export const acceptOfferInternal: RegisteredMutation<"internal", …>  // L42-88
    // args: { offerId: v.id("offers"), userId: v.id("users"), note?: string }
```

- Preview source, in priority order:
  1. an `args` property of the object-literal argument (Convex convention)
  2. else the parameter list of a `handler` / function-valued property
  3. else no preview (silence beats noise)
- Preview is the SOURCE TEXT of that property value, whitespace-collapsed.
  `docs: "brief"` caps it at 120 chars with `…`; `docs: "full"` allows up to
  ~8 collapsed lines (cap 600 chars) and may wrap onto continuation lines with
  the same `    // ` prefix.

### Implementation (pseudo code)

Also covered by the `EXTRACTOR_VERSION` bump to `"4"` (do one bump for both features).

`model.ts`:
```
DeclEntry += snippet?: string     # collapsed source text of the args shape; absent when not applicable
```

`extractor.ts`, in `variableEntries()`, the non-arrow-function branch (~L545):
```
if decl.initializer and isCallExpression(decl.initializer):
    objArg = first argument of the call that isObjectLiteralExpression
    if objArg:
        prop = objArg.properties.find(name == "args")
        if prop and isPropertyAssignment(prop):
            snippet = "args: " + collapseWhitespace(prop.initializer.getText(sf))
        else:
            fnProp = objArg.properties.find(value is arrow/function AND name in ["handler", ...any])
                     # prefer name "handler"; else first function-valued property
            if fnProp: snippet = fnProp.name + "(" + collapsed parameter list text + ")"
    entry.snippet = snippet   # may stay undefined
```
Cap raw snippet at 600 chars in the extractor (`cleanType`-style hard cap);
the brief/full length policy is the formatter's job.

`formatter.ts`, wherever an entry's doc lines are emitted under the signature:
```
if opts.docs != "none" and entry.snippet:
    text = entry.snippet
    if opts.docs == "brief": text = truncate(text, 120, "…")
    emit indented "// " + text          # wrap at ~110 chars per line in full mode
```
Order under a signature: snippet line(s) AFTER the doc brief (doc explains intent,
snippet shows shape). Note: dense-grouped entries print `text` as-is with no
annotation line — snippets are simply not rendered for dense entries (acceptable;
framework-wrapper consts exceed `DENSE_MAX_CONST_LINES` and are never dense).

No entry-point changes: this rides the existing `docs` option.

### Tests

- fixture: `export const m = fakeMutation({ args: { id: v.id("x") }, handler: async (ctx, a) => {} })`
  - `docs: "none"` → no snippet line
  - `docs: "brief"` → one `// args: { id: v.id("x") }` line, <= 120 chars + prefix
  - `docs: "full"` → full collapsed shape, wrapped
- fixture without `args` but with `handler(ctx, { offerId })` → parameter-list snippet
- plain `export const x = 5` → no snippet
- The existing Convex-shaped fixture (`test/fixtures/`) already guards line
  annotations on wrapper consts — extend it rather than adding a parallel fixture.

---

## Documentation updates

Keep additions proportional — each feature earns roughly the same footprint as
the existing option descriptions, no more.

- [ ] `README.md` "The tool" section: extend the `path` bullet with one sentence
      (arrays + globs, 20-file cap); add one bullet for `includeImports`; extend
      the `docs` bullet with one clause about snippet previews. Do NOT add a new
      top-level section per feature.
- [ ] `README.md` "CLI Usage" options list: add `--include-imports`; note
      comma-separated multi-path in the `<path>` arg description.
- [ ] `README.md` "Backlog and next steps": remove/adjust any items these features
      satisfy (check item 7 "machine-readable output" — unrelated, leave; nothing
      currently lists these, so likely no change — verify).
- [ ] `ts-header-design.md`: append a short decision-log entry (date, the three
      features, the two non-obvious decisions: extract-always/format-conditionally
      for imports, and reusing `docs` instead of a new snippet option).
- [ ] `mirica-tool/ts_header.js`: update `path` and add `includeImports` parameter
      descriptions; one added line in `MCP_TOOL_INSTRUCTIONS` showing a batch call.
      Then re-copy to the Mirica `custom-mcp-tools/` dir and Reload Tools
      (see README "Mirica" section for paths).
- [ ] `http-server.mjs` header comment: update the POST body shape.

## Implementation checklist (do in this order)

Preparation
- [ ] `npm test` passes on a clean checkout (baseline)

Feature 2 + 3 share the model/extractor version bump — do them before Feature 1
so the batch code path is built against the final single-file behavior.

Feature 2: includeImports
- [ ] `model.ts`: `FileHeaderModel.imports`, `HeaderOptions.includeImports` + default
- [ ] `extractor.ts`: collect collapsed import text
- [ ] `formatter.ts`: conditional import block + 120-char elision
- [ ] `router.ts`: thread `includeImports` through `TsHeaderRequest` → `formatFileHeader`
- [ ] `server.ts` zod schema + description; `cli.ts` `--include-imports`;
      `http-server.mjs` passthrough; `mirica-tool/ts_header.js` param + body
- [ ] Unit tests (extractor + formatter + router option threading)

Feature 3: snippet preview
- [ ] `model.ts`: `DeclEntry.snippet`
- [ ] `extractor.ts`: call-expression/object-literal detection in `variableEntries`
- [ ] `formatter.ts`: snippet line under signature, brief/full length policy
- [ ] Extend Convex-shaped fixture + unit tests for all three `docs` modes
- [ ] Bump `EXTRACTOR_VERSION` to `"4"` in `router.ts` (once, covers 2+3)

Feature 1: batch paths
- [ ] `router.ts`: widen `TsHeaderRequest.path`; extract `fileHeader()` helper;
      add `handleBatch`, `globWalk`, `globToRegex`, 20-file cap, budget split
- [ ] `server.ts` zod union + roots-matching fix; `cli.ts` comma-split;
      `http-server.mjs` null-guard fix; `mirica-tool/ts_header.js` description
- [ ] Unit tests (7 cases listed above)

Wrap-up
- [ ] All documentation checklist items above
- [ ] `npm run validate` (typecheck + lint + tests) passes
- [ ] `npm run smoke-test` — eyeball a batch call, an `includeImports` header,
      and a snippet preview
- [ ] Rebuild and redeploy: `npm run build`, restart the HTTP bridge
      (kill `node .../http-server.mjs`, rerun), re-copy the Mirica tool file,
      Reload Tools in Mirica settings

## Out of scope (do not do)

- Glob library dependency (subset implementation only)
- Batch over directories / TOCs inside batch output
- Filtering or line-annotating import statements
- Snippet previews for class methods or standalone functions (signatures already
  show parameters)
- A separate `snippets` option (rides `docs` by design)