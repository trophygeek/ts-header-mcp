/**
 * Extractor unit tests. One program is built over the shared fixture; tests
 * assert on the FileHeaderModel structure rather than rendered text, so they
 * don't break when formatter layout changes. Line-number assertions are
 * relative (name-anchored) so fixture edits above a symbol don't cascade.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../../src/extractor.js";
import type { Depth, FileHeaderModel } from "../../src/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "../fixtures/userService.ts");

let models: Record<Depth, FileHeaderModel>;
let fixtureLines: string[];

before(() => {
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  });
  const sourceFile = program.getSourceFile(fixture)!;
  const checker = program.getTypeChecker();
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  const make = (depth: Depth) =>
      extract({ sourceFile, checker, diagnostics, relPath: "fixture.ts", depth });
  models = { exports: make("exports"), all: make("all"), deep: make("deep") };
  fixtureLines = fs.readFileSync(fixture, "utf8").split("\n");
});

/** 1-based line where `needle` first appears in the fixture source. */
function lineOf(needle: string): number {
  const idx = fixtureLines.findIndex((l) => l.includes(needle));
  assert.notEqual(idx, -1, `fixture contains "${needle}"`);
  return idx + 1;
}

const byName = (m: FileHeaderModel, name: string) => m.entries.filter((e) => e.name === name);

function extractVirtual(source: string): FileHeaderModel {
  const sf = ts.createSourceFile("v.ts", source, ts.ScriptTarget.ES2022, true);
  const program = ts.createProgram(["__v__.ts"], { noEmit: true }, {
    ...ts.createCompilerHost({}),
    getSourceFile: (name, langVersion) =>
        name === "__v__.ts" ? sf : ts.createSourceFile(name, "", langVersion),
    readFile: () => "",
    fileExists: () => true,
  });
  return extract({
                   sourceFile: sf,
                   checker: program.getTypeChecker(),
                   diagnostics: [],
                   relPath: "v.ts",
                   depth: "all",
                 });
}

describe("depth semantics", () => {
  it("exports depth includes only exported declarations", () => {
    assert.ok(models.exports.entries.every((e) => e.exported));
    assert.equal(byName(models.exports, "slugify").length, 0);
  });

  it("all depth adds non-exported top-level declarations", () => {
    assert.equal(byName(models.all, "slugify").length, 1);
    assert.equal(byName(models.all, "slugify")[0].exported, false);
  });

  it("all depth includes private class members", () => {
    const cls = byName(models.all, "UserService")[0];
    assert.ok(cls.children!.some((c) => c.name === "invalidate" && c.text.startsWith("private ")));
  });

  it("exports depth excludes private class members", () => {
    const cls = byName(models.exports, "UserService")[0];
    assert.ok(!cls.children!.some((c) => c.name === "invalidate"));
  });

  it("deep depth surfaces inner functions as children", () => {
    const cls = byName(models.deep, "UserService")[0];
    const updateUser = cls.children!.find((c) => c.name === "updateUser")!;
    assert.ok(updateUser.children!.some((c) => c.name === "validate"));

    const factory = byName(models.deep, "createUserService")[0];
    assert.ok(factory.children!.some((c) => c.name === "warmup"));
  });
});

describe("type information", () => {
  it("uses checker-inferred return types", () => {
    const cls = byName(models.exports, "UserService")[0];
    const getUser = cls.children!.find((c) => c.name === "getUser")!;
    assert.match(getUser.text, /: Promise<User \| null>$/);
  });

  it("renders each overload signature as its own entry", () => {
    const overloads = byName(models.exports, "parseId");
    assert.ok(overloads.length >= 2);
    assert.ok(overloads.some((o) => o.text.includes("raw: string)")));
    assert.ok(overloads.some((o) => o.text.includes("raw: number)")));
  });

  it("renders function-valued consts in arrow style", () => {
    const chunk = byName(models.exports, "chunk")[0];
    assert.equal(chunk.text, "export const chunk: <T>(items: T[], size: number) => T[][]");
  });

  it("drops redundant '| undefined' on optional parameters", () => {
    const cls = byName(models.exports, "UserService")[0];
    const ctor = cls.children!.find((c) => c.kind === "constructor")!;
    assert.match(ctor.text, /cache\?: CacheLayer/);
    assert.ok(!ctor.text.includes("| undefined"));
  });
});

describe("line numbers", () => {
  it("anchors entries to the line of the declaration name", () => {
    const factory = byName(models.exports, "createUserService")[0];
    assert.equal(factory.line, lineOf("export function createUserService"));
  });

  it("gives containers their full source range", () => {
    const cls = byName(models.exports, "UserService")[0];
    assert.equal(cls.line, lineOf("export class UserService"));
    assert.ok(cls.endLine > cls.line);
  });
});

describe("docs and errors", () => {
  it("extracts the first JSDoc sentence only", () => {
    const cls = byName(models.exports, "UserService")[0];
    assert.equal(cls.doc?.brief, "Service for reading and mutating users.");
  });

  it("flags @deprecated", () => {
    const cls = byName(models.exports, "UserService")[0];
    const patch = cls.children!.find((c) => c.name === "patch")!;
    assert.equal(patch.doc?.deprecated, true);
  });

  it("attaches diagnostics to the enclosing declaration", () => {
    const bad = byName(models.exports, "processOrder")[0];
    assert.equal(bad.error?.code, 2304);
    const ok = byName(models.exports, "createUserService")[0];
    assert.equal(ok.error, undefined);
  });
});

describe("framework-style consts (Convex regression)", () => {
  it("keeps a large const NON-dense so it retains its own line annotation", () => {
    const e = byName(models.exports, "createBooking")[0];
    assert.equal(e.dense, false);
    assert.equal(e.line, lineOf("export const createBooking"));
    assert.ok(e.endLine > e.line, "captures the initializer's full range");
  });

  it("small consts remain dense/groupable", () => {
    const e = byName(models.exports, "MAX_PAGE_SIZE")[0];
    assert.equal(e.dense, true);
  });

  it("caps rendered type length with an ellipsis", () => {
    const e = byName(models.exports, "createBooking")[0];
    const type = e.text.replace(/^export const createBooking: /, "");
    assert.ok(type.length <= 160, `type is ${type.length} chars`);
    assert.ok(type.endsWith("…"), "elided with …");
  });

  it("strips import(...) qualifiers from rendered types", () => {
    for (const m of Object.values(models)) {
      for (const e of m.entries) {
        assert.ok(!e.text.includes('import("'), `qualifier leaked in: ${e.text}`);
      }
    }
  });
});

describe("file-level JSDoc", () => {
  it("promotes a gapped file-leading JSDoc to fileDoc", () => {
    assert.equal(
        models.exports.fileDoc,
        "Fixture module for ts-header extraction tests."
    );
  });

  it("suppresses the misattributed doc on the first declaration", () => {
    // Brand is the first statement; the file doc must not become its doc.
    const brand = byName(models.all, "Brand")[0];
    assert.equal(brand.doc, undefined);
  });

  it("keeps a butted-up doc as the declaration's own (no promotion)", () => {
    const m = extractVirtual(`/** Reads users. */\nexport interface A { id: string }\n`);
    assert.equal(m.fileDoc, undefined);
    assert.equal(m.entries[0].doc?.brief, "Reads users.");
  });

  it("splits stacked docs: first to file, last to declaration", () => {
    const m = extractVirtual(
        `/** File overview. */\n/** A's doc. */\nexport interface A { id: string }\n`
    );
    assert.equal(m.fileDoc, "File overview.");
    assert.equal(m.entries[0].doc?.brief, "A's doc.");
  });
});

describe("class rendering", () => {
  it("collapses multi-line heritage clauses to one line", () => {
    const panel = byName(models.exports, "Panel")[0];
    assert.ok(!panel.text.includes("\n"), `heritage not collapsed: ${JSON.stringify(panel.text)}`);
    assert.match(panel.text, /extends Base<\{ children: string; fallback\?: string \}, \{ hasError: boolean \}>/);
  });
});

describe("barrel detection", () => {
  it("marks files that are mostly re-exports", () => {
    const sf = ts.createSourceFile(
        "index.ts",
        `export * from "./a.js";\nexport { b } from "./b.js";\n`,
        ts.ScriptTarget.ES2022,
        true
    );
    // A barrel needs no type information; a throwaway program gives a checker.
    const program = ts.createProgram(["__virtual__.ts"], { noEmit: true }, {
      ...ts.createCompilerHost({}),
      getSourceFile: (name, langVersion) =>
          name === "__virtual__.ts" ? sf : ts.createSourceFile(name, "", langVersion),
      readFile: () => "",
      fileExists: () => true,
    });
    const model = extract({
                            sourceFile: sf,
                            checker: program.getTypeChecker(),
                            diagnostics: [],
                            relPath: "index.ts",
                            depth: "exports",
                          });
    assert.equal(model.barrel, true);
    assert.deepEqual(model.reexports, ["./a.js", "./b.js"]);
  });
});
