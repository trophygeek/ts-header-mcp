/**
 * Smoke test: extract + format the fixture at each depth/docs combination
 * and assert the key invariants from the design doc.
 * Run: npx tsx test/smoke.ts
 */
import ts from "typescript";
import path from "node:path";
import { extract } from "../src/extractor.js";
import { formatFileHeader } from "../src/formatter.js";
import type { Depth } from "../src/model.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/userService.ts");

const program = ts.createProgram([fixture], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  incremental: false, // never write .tsbuildinfo (design doc + temp-file policy)
});
const sf = program.getSourceFile(fixture)!;
const checker = program.getTypeChecker();
const diags = [
  ...program.getSyntacticDiagnostics(sf),
  ...program.getSemanticDiagnostics(sf),
];

function run(depth: Depth, docs: "none" | "brief" | "full") {
  const model = extract({
    sourceFile: sf,
    checker,
    diagnostics: diags,
    relPath: "test/fixtures/userService.ts",
    depth,
  });
  return formatFileHeader(model, { depth, docs });
}

// ---- render the default view for eyeballs ----
const header = run("exports", "brief");
console.log("================ depth:exports docs:brief ================");
console.log(header);
console.log("\n================ depth:deep docs:none ================");
const deep = run("deep", "none");
console.log(deep);

// ---- invariants ----
let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok:   ${name}`);
  }
}

console.log("\n================ assertions ================");
// inferred return type surfaced by the checker
check("getUser shows inferred Promise<User | null>", /getUser\(id: UserId\): Promise<User \| null>/.test(header));
check("createUserService shows inferred UserService return", /createUserService\(cfg: Config\): UserService/.test(header));
// line annotations
check("line annotations present", /\/\/ L\d+/.test(header));
check("class gets a range annotation", /class UserService.*\/\/ L\d+-\d+/.test(header));
// docs
check("brief doc appears after signature", header.includes("// Fetches a user by ID, checking cache first."));
check("second JSDoc sentence excluded in brief", !header.includes("Second sentence"));
// deprecated always surfaces
check("deprecated marker on patch()", /patch\(.*\n?.*deprecated/.test(header) || header.includes("⚠ deprecated"));
const noDocs = run("exports", "none");
check("deprecated survives docs:none", noDocs.includes("⚠ deprecated"));
// dense grouping
check("dense type block grouped with range", /-- types: L\d+-\d+ --/.test(header));
// error marker
check("processOrder carries TS2304 marker", /processOrder.*⚠ TS2304/.test(header));
// depth semantics
check("exports depth hides private invalidate()", !header.includes("invalidate"));
check("exports depth hides non-exported slugify", !header.includes("slugify"));
const all = run("all", "none");
check("all depth shows slugify", all.includes("slugify"));
check("all depth shows private invalidate", all.includes("private invalidate"));
// deep: inner functions
check("deep shows inner validate() inside updateUser", deep.includes("validate(p: Partial<User>): boolean"));
check("deep shows inner arrow const warmup (arrow style)", /const warmup: \(ids: UserId\[\]\) => Promise<void>/.test(deep));
// overloads: at least both overload signatures appear
check("overload signatures present", (deep.match(/parseId\(raw: (string|number)\): UserId/g) ?? []).length >= 2);
// generic arrow const
check("generic arrow const chunk rendered arrow-style", /chunk: <T>\(items: T\[\], size: number\) => T\[\]\[\]/.test(header));
// overload chain renders as a tight block (no blank lines between parseId lines)
check("overloads render tightly", /parseId\(raw: string\): UserId.*\n.*parseId\(raw: number\): UserId.*\n.*parseId\(raw: string \| number\): UserId/.test(header));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
