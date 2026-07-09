/**
 * Formatter unit tests. The formatter is a pure function over FileHeaderModel,
 * so these build small models by hand and assert on the rendered text.
 * No TypeScript compiler involvement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatFileHeader,
  formatFileToc,
  formatProjectToc,
  formatRecursiveFileList,
  type DirFileSummary,
} from "../../src/formatter.js";
import type { DeclEntry, FileHeaderModel } from "../../src/model.js";

function entry(partial: Partial<DeclEntry> & Pick<DeclEntry, "name" | "text">): DeclEntry {
  return {
    kind: "function",
    line: 1,
    endLine: 1,
    exported: true,
    dense: false,
    ...partial,
  };
}

function model(entries: DeclEntry[], partial: Partial<FileHeaderModel> = {}): FileHeaderModel {
  return {
    path: "src/a.ts",
    totalLines: 100,
    exportCount: entries.filter((e) => e.exported).length,
    barrel: false,
    reexports: [],
    entries,
    imports: [],
    fileErrors: [],
    skippedRanges: [],
    ...partial,
  };
}

describe("annotations", () => {
  it("uses a point annotation for single-line declarations", () => {
    const out = formatFileHeader(model([entry({ name: "f", text: "export function f(): void", line: 7, endLine: 7 })]));
    assert.match(out, /export function f\(\): void\s+\/\/ L7\n/);
  });

  it("uses a range annotation for multi-line declarations", () => {
    const out = formatFileHeader(model([entry({ name: "f", text: "export function f(): void", line: 7, endLine: 12 })]));
    assert.match(out, /\/\/ L7-12/);
  });

  it("includes the error's own line when it differs from the declaration line", () => {
    const out = formatFileHeader(
      model([entry({ name: "App", text: "export function App(): JSX.Element", line: 100, endLine: 300, error: { line: 177, code: 2339, message: "Property 'env' does not exist" } })])
    );
    assert.match(out, /\/\/ L100-300 ⚠ at L177 TS2339/);
  });

  it("appends the TS error code and message", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(o: Ordr): number", line: 3, endLine: 5, error: { line: 3, code: 2304, message: "Cannot find name 'Ordr'." } })])
    );
    assert.match(out, /\/\/ L3-5 ⚠ TS2304: Cannot find name 'Ordr'\. — type unreliable/);
  });
});

describe("docs modes", () => {
  const withDoc = () =>
    entry({
      name: "getUser",
      text: "getUser(id: string): User",
      line: 4,
      endLine: 4,
      doc: { brief: "Fetches a user.", full: "/** Fetches a user.\n * @throws on bad id */", deprecated: false },
    });

  it("brief renders the first sentence after the signature", () => {
    const out = formatFileHeader(model([withDoc()]), { docs: "brief" });
    const lines = out.split("\n");
    const sigIdx = lines.findIndex((l) => l.includes("getUser(id: string)"));
    assert.ok(lines[sigIdx + 1].includes("// Fetches a user."), "doc line follows signature");
  });

  it("none omits the doc text", () => {
    const out = formatFileHeader(model([withDoc()]), { docs: "none" });
    assert.ok(!out.includes("Fetches a user."));
  });

  it("full renders the JSDoc block before the signature", () => {
    const out = formatFileHeader(model([withDoc()]), { docs: "full" });
    assert.ok(out.indexOf("@throws") < out.indexOf("getUser(id: string)"));
  });

  it("deprecated marker survives docs:none", () => {
    const e = entry({ name: "patch", text: "patch(): void", doc: { deprecated: true } });
    const out = formatFileHeader(model([e]), { docs: "none" });
    assert.match(out, /⚠ deprecated/);
  });
});

describe("dense-block grouping", () => {
  const typeRun = (fromLine: number, span: number): DeclEntry[] => [
    entry({ kind: "type", name: "A", text: "export type A = string;", line: fromLine, endLine: fromLine, dense: true }),
    entry({ kind: "interface", name: "B", text: "export interface B { x: number }", line: fromLine + 1, endLine: fromLine + span - 1, dense: true }),
  ];

  it("groups a run whose source span exceeds the threshold", () => {
    const out = formatFileHeader(model(typeRun(10, 9)), { denseGroupMinLines: 6 });
    assert.match(out, /\/\/ -- types: L10-18 --/);
    assert.ok(!/export type A = string;.*\/\/ L10/.test(out), "grouped members drop per-line annotations");
  });

  it("keeps per-line annotations for a short run", () => {
    const out = formatFileHeader(model(typeRun(10, 3)), { denseGroupMinLines: 6 });
    assert.ok(!out.includes("-- types:"));
    assert.match(out, /\/\/ L10/);
  });

  it("does not group a run containing an errored entry", () => {
    const run = typeRun(10, 9);
    run[0].error = { line: 10, code: 2304, message: "boom" };
    const out = formatFileHeader(model(run), { denseGroupMinLines: 6 });
    assert.ok(!out.includes("-- types:"));
    assert.match(out, /⚠ TS2304/);
  });
});

describe("containers and children", () => {
  it("renders class members indented inside braces", () => {
    const cls = entry({
      kind: "class",
      name: "Svc",
      text: "export class Svc",
      line: 5,
      endLine: 20,
      children: [entry({ kind: "method", name: "run", text: "run(): void", line: 8, endLine: 10, exported: false })],
    });
    const out = formatFileHeader(model([cls]));
    assert.match(out, /export class Svc \{\s+\/\/ L5-20/);
    assert.match(out, /\n  run\(\): void\s+\/\/ L8-10/);
    assert.match(out, /\n\}/);
  });
});

describe("file-level doc", () => {
  it("renders the file doc directly under the banner", () => {
    const out = formatFileHeader(model([], { fileDoc: "Spot reallocation optimizer." }));
    const lines = out.split("\n");
    assert.match(lines[0], /^\/\/ ==== /);
    assert.equal(lines[1], "// Spot reallocation optimizer.");
  });

  it("brief docs render BEFORE multi-line declarations", () => {
    const e = entry({
      kind: "interface",
      name: "Realloc",
      text: "export interface Realloc {\n  bookingId: string;\n}",
      line: 5,
      endLine: 8,
      dense: false,
      doc: { brief: "Optimizes layout.", deprecated: false },
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    assert.ok(
      out.indexOf("// Optimizes layout.") < out.indexOf("export interface Realloc"),
      `doc should precede the declaration:\n${out}`
    );
  });

  it("brief docs still render after single-line declarations", () => {
    const e = entry({
      name: "f",
      text: "export function f(): void",
      doc: { brief: "Does f.", deprecated: false },
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    assert.ok(out.indexOf("export function f(): void") < out.indexOf("// Does f."));
  });
});

describe("overload chains", () => {
  it("renders consecutive same-name functions without blank lines between", () => {
    const overloads = [
      entry({ name: "parseId", text: "export function parseId(raw: string): Id", line: 3, endLine: 3 }),
      entry({ name: "parseId", text: "export function parseId(raw: number): Id", line: 4, endLine: 4 }),
      entry({ name: "parseId", text: "export function parseId(raw: string | number): Id", line: 5, endLine: 7 }),
      entry({ name: "other", text: "export function other(): void", line: 10, endLine: 10 }),
    ];
    const out = formatFileHeader(model(overloads));
    assert.match(out, /parseId\(raw: string\): Id\s+\/\/ L3\n.*parseId\(raw: number\): Id\s+\/\/ L4\n.*parseId\(raw: string \| number\): Id\s+\/\/ L5-7\n\n/);
    assert.doesNotMatch(out, /L3\n\n/, "no blank line inside the chain");
  });
});

describe("special files and budgets", () => {
  it("renders barrel files as a re-export summary", () => {
    const out = formatFileHeader(model([], { barrel: true, reexports: ["./a.js", "./b.js"] }));
    assert.match(out, /barrel file: re-exports \.\/a\.js, \.\/b\.js/);
  });

  it("caps long barrel re-export lists at 8", () => {
    const many = Array.from({ length: 18 }, (_, i) => `./m${i}.js`);
    const header = formatFileHeader(model([], { barrel: true, reexports: many }));
    assert.match(header, /\.\/m7\.js, \+10 more/);
    const toc = formatFileToc("src", [
      { fileName: "index.ts", totalLines: 20, exportNames: [], barrel: true, reexports: many, isTest: false },
    ]);
    assert.match(toc, /\+10 more/);
  });

  it("adds an error banner above the threshold", () => {
    const entries = Array.from({ length: 11 }, (_, i) =>
      entry({ name: `f${i}`, text: `f${i}(): void`, line: i + 1, endLine: i + 1, error: { line: i + 1, code: 2304, message: "x" } })
    );
    const out = formatFileHeader(model(entries));
    assert.match(out, /⚠ 11 type\/syntax errors in this file/);
  });

  it("truncates to the token budget with a marker", () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ name: `f${i}`, text: `export function f${i}(argument: SomeLongTypeName): AnotherLongTypeName`, line: i + 1, endLine: i + 1 })
    );
    const out = formatFileHeader(model(entries), { maxTokens: 100 });
    assert.match(out, /truncated at ~100 tokens/);
    assert.ok(out.length < 100 * 4 + 200, "output respects the budget");
  });
});

describe("structural elision", () => {
  it("renders { bookingStatus: string; offerExpiry?: number | undefined; } verbatim, preserving optionality and types", () => {
    const e = entry({
      kind: "function",
      name: "isOfferClaimable",
      text: "export function isOfferClaimable(booking: { bookingStatus: string; offerExpiry?: number | undefined; }): boolean",
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.ok(out.includes("bookingStatus: string; offerExpiry?: number | undefined"));
    assert.ok(!out.includes("…"));
  });

  it("renders a 2-property args object in full even when signature exceeds 120 chars", () => {
    const e = entry({
      kind: "function",
      name: "createBookingWithAQuiteLongName",
      text: "export function createBookingWithAQuiteLongName(args: { idempotencyKey: string; bookingId: Id<\"bookings\">; }): Promise<void>",
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.ok(out.includes("idempotencyKey: string; bookingId: Id<\"bookings\">"));
    assert.ok(!out.includes("…"));
  });

  it("renders a 3-property inline parameter type in full", () => {
    const e = entry({
      kind: "function",
      name: "f",
      text: "export function f(param: { a: string; b: number; c: boolean; }): void",
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.ok(out.includes("a: string; b: number; c: boolean"));
    assert.ok(!out.includes("…"));
  });

  it("elides an object type >200 chars with >4 properties to first 3 full properties + …N more", () => {
    const e = entry({
      kind: "const",
      name: "myVal",
      text: "export const myVal: { veryLongPropNameNumberOne: string; veryLongPropNameNumberTwo: number; veryLongPropNameNumberThree: boolean; veryLongPropNameNumberFour: string; veryLongPropNameNumberFive: number; veryLongPropNameNumberSix: boolean }",
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.match(out, /veryLongPropNameNumberOne: string; veryLongPropNameNumberTwo: number; veryLongPropNameNumberThree: boolean; …3 more/);
    assert.doesNotMatch(out, /veryLongPropNameNumberFour/);
  });

  it("renders a long signature with modest type nodes in full without any elision", () => {
    const sig = "export function myLongSignatureWithModestTypes(a: string, b: number, c: boolean, d: string, e: number, f: boolean): { success: boolean; msg: string; }";
    const e = entry({
      kind: "function",
      name: "myLongSignatureWithModestTypes",
      text: sig,
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.ok(out.includes(sig));
    assert.ok(!out.includes("…"));
  });

  it("retains non-object types in full without character-level cuts (wrap-and-render-full)", () => {
    const veryLongUnion = "export type Union = A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y | Z | AA | BB | CC | DD | EE";
    const e = entry({
      kind: "type",
      name: "Union",
      text: veryLongUnion,
      line: 1,
      endLine: 1,
    });
    const out = formatFileHeader(model([e]));
    assert.ok(out.includes(veryLongUnion), "union type remains fully intact");
  });
});

describe("directory TOCs", () => {
  const file = (partial: Partial<DirFileSummary> & Pick<DirFileSummary, "fileName">): DirFileSummary => ({
    totalLines: 10,
    exportNames: ["a"],
    barrel: false,
    reexports: [],
    isTest: false,
    ...partial,
  });

  it("labels barrels and tags test files", () => {
    const out = formatFileToc("src", [
      file({ fileName: "index.ts", barrel: true, reexports: ["./a.js"] }),
      file({ fileName: "a.test.ts", isTest: true }),
    ]);
    assert.match(out, /index\.ts\s+.*barrel: \.\/a\.js/);
    assert.match(out, /a\.test\.ts \[test\]/);
  });

  it("caps export name lists with a +n more suffix (file rows cap at 24)", () => {
    const names = Array.from({ length: 30 }, (_, i) => `export${i}`);
    const out = formatFileToc("src", [file({ fileName: "big.ts", exportNames: names })]);
    assert.match(out, /\+6 more/);
  });

  it("dedupes names and drops single-character junk", () => {
    const out = formatFileToc("src", [
      file({ fileName: "x.ts", exportNames: ["App", "App", "a", "ErrorBoundary", "App"] }),
    ]);
    assert.match(out, /App, ErrorBoundary/);
    assert.equal((out.match(/App/g) ?? []).length, 1);
    assert.ok(!/\ba,/.test(out) && !/, a\b/.test(out));
  });

  it("project TOC file rows carry line counts and test tags", () => {
    const out = formatProjectToc(
      "src",
      [{ dirName: "services", fileCount: 1, totalLines: 100, topExports: ["A"] }],
      [
        file({ fileName: "root.ts", totalLines: 42 }),
        file({ fileName: "root.test.ts", totalLines: 7, isTest: true }),
      ]
    );
    assert.match(out, /root\.ts\s+42L/);
    assert.match(out, /root\.test\.ts \[test\]\s+7L/);
  });

  it("project TOC totals files and lines across directories", () => {
    const out = formatProjectToc(
      "src",
      [
        { dirName: "services", fileCount: 3, totalLines: 300, topExports: ["A"] },
        { dirName: "models", fileCount: 2, totalLines: 200, topExports: ["B"] },
      ],
      []
    );
    assert.match(out, /2 dirs, 5 files, 500 lines/);
    assert.match(out, /drill down: ts_header\("src\/services"\)/);
  });
});

describe("includeImports", () => {
  const imports = [
    'import { mutation, query } from "./_generated/server";',
    'import type { Doc } from "./_generated/dataModel";',
    'import * as bookings from "@roar/domain";',
  ];

  it("does not render imports when includeImports is false (default)", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void" })], { imports }),
    );
    assert.ok(!out.includes("-- imports --"));
    assert.ok(!out.includes("mutation"));
  });

  it("renders the import block when includeImports is true", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void" })], { imports }),
      { includeImports: true },
    );
    assert.ok(out.includes("// -- imports --"));
    assert.ok(out.includes('import { mutation, query } from "./_generated/server";'));
    assert.ok(out.includes('import type { Doc } from "./_generated/dataModel";'));
    assert.ok(out.includes('import * as bookings from "@roar/domain";'));
    // Imports should appear between banner and entries
    const importsIdx = out.indexOf("// -- imports --");
    const entryIdx = out.indexOf("export function f(): void");
    assert.ok(importsIdx < entryIdx, "imports block precedes entries");
  });

  it("elides a long named-import list to stay within 120 chars", () => {
    const longImport =
      'import { veryLongExportNameAlpha, veryLongExportNameBeta, veryLongExportNameGamma, veryLongExportNameDelta, veryLongExportNameEpsilon } from "./big-module";';
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void" })], { imports: [longImport] }),
      { includeImports: true },
    );
    const importLine = out.split("\n").find((l) => l.includes("import {"));
    assert.ok(importLine, "import line is present");
    assert.ok(importLine!.length <= 120, `import line is ${importLine!.length} chars, expected <= 120`);
    assert.ok(importLine!.includes("…"), "elided with …");
    assert.ok(importLine!.includes("./big-module"), "module specifier preserved");
  });

  it("does not crash when model has no imports field (old cached model)", () => {
    // Simulate an old persisted model without the imports field
    const oldModel = model([entry({ name: "f", text: "export function f(): void" })]);
    delete (oldModel as Record<string, unknown>).imports;
    const out = formatFileHeader(oldModel, { includeImports: true });
    // Should not throw, and should not contain imports section
    assert.ok(!out.includes("-- imports --"));
    assert.ok(out.includes("export function f(): void"));
  });

  it("does not render imports block when imports array is empty", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void" })], { imports: [] }),
      { includeImports: true },
    );
    assert.ok(!out.includes("-- imports --"));
  });
});
describe("plain-text annotations (no file:// links)", () => {
  it("emits plain L-annotations and a plain banner even when workspaceRoot is set", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void", line: 7, endLine: 7 })]),
      { workspaceRoot: "/ws" },
    );
    assert.match(out, /^\/\/ ==== src\/a\.ts — /);
    assert.match(out, /\/\/ L7\n/);
  });

  it("emits plain range annotations", () => {
    const out = formatFileHeader(
      model([entry({ name: "f", text: "export function f(): void", line: 7, endLine: 12 })]),
      { workspaceRoot: "/ws" },
    );
    assert.match(out, /\/\/ L7-12/);
  });

  it("output contains no file:// substring anywhere", () => {
    const run = [
      entry({ kind: "type", name: "A", text: "export type A = string;", line: 10, endLine: 10, dense: true }),
      entry({ kind: "interface", name: "B", text: "export interface B { x: number }", line: 11, endLine: 18, dense: true }),
      entry({ name: "f", text: "export function f(): void", line: 20, endLine: 25 }),
    ];
    const out = formatFileHeader(model(run), { denseGroupMinLines: 6, workspaceRoot: "/ws" });
    assert.ok(!out.includes("file://"), "no file:// links in output");
    assert.match(out, /-- types: L10-18 --/);
  });
});
describe("snippet preview", () => {
  const withSnippet = (snippet: string) =>
    entry({
      kind: "const",
      name: "createBooking",
      text: "export const createBooking: Registered<Args, Promise<Result>>",
      line: 42,
      endLine: 88,
      snippet,
    });

  it("renders snippet line in brief mode, capped at 120 chars", () => {
    const out = formatFileHeader(model([withSnippet('args: { id: "x" }')]), { docs: "brief" });
    assert.ok(out.includes('// args: { id: "x" }'), "snippet line present");
    // snippet should appear after the signature line
    assert.ok(out.indexOf("createBooking") < out.indexOf('args: { id: "x" }'));
  });

  it("elides a long snippet to <= 120 chars in brief mode without a mid-token cut", () => {
    const long = "args: { " + "x".repeat(200) + " }";
    const out = formatFileHeader(model([withSnippet(long)]), { docs: "brief" });
    const snippetLine = out.split("\n").find((l) => l.includes("// args:"));
    assert.ok(snippetLine, "snippet line present");
    // "    // " prefix is 7 chars, snippet capped at 120 → total ≤ 127
    const text = snippetLine!.trimStart().replace(/^\/\/ /, "");
    assert.ok(text.length <= 121, `snippet text is ${text.length} chars, expected <= 121`);
    assert.ok(text.endsWith("…") || / …\d* ?more?\s*\}?$/.test(text) || /…\d+ more/.test(text), `elision marker present: ${text}`);
  });

  it("renders full snippet in full mode (no 120-char cap)", () => {
    const long = "args: { " + "field".repeat(30) + " }";
    const out = formatFileHeader(model([withSnippet(long)]), { docs: "full" });
    // In full mode the snippet can be longer than 120 chars across continuation lines
    assert.ok(out.includes("args:"), "snippet present");
  });

  it("does not render snippet when docs is none", () => {
    const out = formatFileHeader(model([withSnippet('args: { id: "x" }')]), { docs: "none" });
    assert.ok(!out.includes('args: { id: "x" }'), "no snippet in docs:none");
  });

  it("does not render snippet for entries without one", () => {
    const plain = entry({ name: "f", text: "export function f(): void" });
    const out = formatFileHeader(model([plain]), { docs: "brief" });
    assert.ok(!out.includes("args:"), "no snippet for plain function");
  });
});
describe("default export rendering", () => {
  const schemaEntry = (): DeclEntry =>
    entry({
      kind: "const",
      name: "defineSchema",
      text: "export default defineSchema({...})",
      line: 6,
      endLine: 258,
      isDefault: true,
      children: [
        entry({ kind: "property", name: "bookings", text: "bookings", line: 12, endLine: 12, exported: false }),
        entry({ kind: "property", name: "schedules", text: "schedules", line: 48, endLine: 48, exported: false }),
        entry({ kind: "property", name: "profiles", text: "profiles", line: 90, endLine: 90, exported: false }),
      ],
    });

  it("renders the default export with its L-range annotation", () => {
    const out = formatFileHeader(model([schemaEntry()]));
    assert.match(out, /export default defineSchema\(\{\.\.\.\}\)\s+\/\/ L6-258/);
  });

  it("renders top-level keys as indented child lines with their line numbers", () => {
    const out = formatFileHeader(model([schemaEntry()]));
    assert.match(out, /\n  bookings\s+\/\/ L12/);
    assert.match(out, /\n  schedules\s+\/\/ L48/);
    assert.match(out, /\n  profiles\s+\/\/ L90/);
  });
});
describe("empty headers", () => {
  it("points to depth:\"all\" when depth-hidden declarations exist", () => {
    const out = formatFileHeader(model([], { hiddenDeclCount: 14 }), { depth: "exports" });
    assert.match(out, /\/\/ no symbols at depth:"exports" — 14 non-exported declarations exist; try depth:"all"/);
    assert.ok(!out.includes("L-numbers above"), "no misleading hint line");
  });

  it("says the file has nothing extractable when truly empty", () => {
    const out = formatFileHeader(model([], { hiddenDeclCount: 0 }));
    assert.match(out, /\/\/ no extractable declarations — read the file directly/);
    assert.ok(!out.includes("L-numbers above"), "no misleading hint line");
  });
});
describe("args-line gating", () => {
  it("suppresses the args line when it restates the rendered signature's property names", () => {
    const e = entry({
      kind: "const",
      name: "getSchedule",
      text: 'export const getSchedule: RegisteredQuery<"public", { scheduleId: Id<"schedules">; }, Promise<unknown>>',
      line: 10,
      endLine: 20,
      snippet: 'args: { scheduleId: v.id("schedules"), }',
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    assert.ok(!out.includes("// args:"), `redundant args line should be suppressed:\n${out}`);
  });

  it("keeps the args line when the rendered signature was elided with …n more", () => {
    const bigArgs = Array.from({ length: 8 }, (_, i) => `veryLongPropertyNameNumber${i}: string`).join("; ");
    const e = entry({
      kind: "const",
      name: "createBooking",
      text: `export const createBooking: Registered<{ ${bigArgs} }, Promise<void>>`,
      line: 10,
      endLine: 60,
      snippet: "args: { " + Array.from({ length: 8 }, (_, i) => `veryLongPropertyNameNumber${i}: v.string()`).join(", ") + " }",
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    assert.ok(out.includes("// args:"), `args line should be kept when signature is elided:\n${out}`);
  });

  it("keeps the args line when it shows names the signature does not", () => {
    const e = entry({
      kind: "const",
      name: "m",
      text: "export const m: Registered<{ id: string; }, Promise<void>>",
      line: 1,
      endLine: 5,
      snippet: "args: { id: v.id(), extraFlag: v.boolean() }",
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    assert.ok(out.includes("// args:"), "args line kept — extraFlag not in signature");
  });

  it("never truncates an args line mid-identifier; elides whole properties with …n more", () => {
    const props = Array.from({ length: 10 }, (_, i) => `anExtremelyLongIdentifierNumber${i}: v.string()`);
    const e = entry({
      kind: "const",
      name: "m",
      text: "export const m: SomethingOpaque",
      line: 1,
      endLine: 40,
      snippet: `args: { ${props.join(", ")} }`,
    });
    const out = formatFileHeader(model([e]), { docs: "brief" });
    const line = out.split("\n").find((l) => l.includes("// args:"));
    assert.ok(line, "args line present");
    assert.match(line!, /…\d+ more/, "whole-property elision marker present");
    // Every identifier that appears must be complete
    for (const m2 of line!.matchAll(/anExtremelyLongIdentifierNumber\d*/g)) {
      assert.match(m2[0], /^anExtremelyLongIdentifierNumber\d+$/, `mid-identifier cut: ${m2[0]}`);
    }
    assert.ok(!/[A-Za-z_$]…/.test(line!), "no identifier is cut directly before the ellipsis");
  });
});
describe("batch hint after multi-file filter results", () => {
  const mf = (relPath: string) => ({ relPath, totalLines: 10, exportNames: ["x1"], isTest: false });

  it("spells out the batch call listing the matched files", () => {
    const out = formatRecursiveFileList("convex", [mf("convex/bookingsWaitlist.ts"), mf("convex/bookingsCheckIn.ts"), mf("convex/bookingsCore.ts"), mf("convex/bookingsCancel.ts")]);
    assert.ok(
      out.includes('// full headers for all matches: ts_header(["convex/bookingsWaitlist.ts", "convex/bookingsCheckIn.ts", "convex/bookingsCore.ts", "convex/bookingsCancel.ts"])'),
      `batch hint present:\n${out}`
    );
  });

  it("caps the spelled-out list at 5 files", () => {
    const files = Array.from({ length: 8 }, (_, i) => mf(`src/f${i}.ts`));
    const out = formatRecursiveFileList("src", files);
    const hint = out.split("\n").find((l) => l.includes("full headers for all matches"))!;
    assert.ok(hint, "hint line present");
    assert.equal((hint.match(/\.ts"/g) ?? []).length, 5, "exactly 5 files listed");
    assert.ok(hint.includes("…"), "remainder elided");
  });

  it("emits no batch hint for a single match", () => {
    const out = formatRecursiveFileList("src", [mf("src/only.ts")]);
    assert.ok(!out.includes("full headers for all matches"));
  });
});