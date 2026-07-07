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

  it("caps export name lists with a +n more suffix", () => {
    const names = Array.from({ length: 12 }, (_, i) => `export${i}`);
    const out = formatFileToc("src", [file({ fileName: "big.ts", exportNames: names })]);
    assert.match(out, /\+4 more/);
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
