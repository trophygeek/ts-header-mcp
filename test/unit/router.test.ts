/**
 * Router unit tests: throwaway workspace in the OS temp dir, all three
 * navigation levels, and the zero-writes invariant. Quiet port of the
 * original test/router.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "../../src/router.js";
import { loadConfig } from "../../src/config.js";

let ws: string;
let router: Router;
let before_snapshot: string;

function write(rel: string, content: string) {
  const p = path.join(ws, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function snapshotWorkspace(): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(ws, p));
    }
  };
  walk(ws);
  return files.sort().join("\n");
}

before(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsh-unit-"));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
        strict: true,
        // Trap: these must never cause a write into the workspace.
        incremental: true, tsBuildInfoFile: "./should-never-appear.tsbuildinfo",
      },
      include: ["src"],
    })
  );
  write(
    "src/services/userService.ts",
    `/** Reads users. */
export class UserService {
  /** Fetch by id. */
  getUser(id: string) { return { id, name: "x" }; }
}
export function createUserService() { return new UserService(); }
/** Internal helper, not exported. */
function slugify(s: string): string { return s.toLowerCase().replace(/\\s+/g, "-"); }
`
  );
  write(
    "src/services/authService.ts",
    `/** Token verification utilities. */

export interface TokenPair { access: string; refresh: string }
export function verifyToken(t: string): boolean { return t.length > 0 }
`
  );
  write("src/services/index.ts", `export * from "./userService.js";\nexport * from "./authService.js";\n`);
  write("src/models/user.ts", `export interface User { id: string; name: string }\n`);
  write("src/models/adminUser.ts", `export interface User { id: string; role: "admin" }\n`);
  write("src/utils/retry.ts", `export function retry(): void {}\n`);
  write("src/utils/retry.test.ts", `export function fake() {}\n`);
  // gitignore coverage: an ignored file and an ignored directory
  write(".gitignore", "src/secret.ts\ngenerated/\n");
  write("src/secret.ts", `export function leak(): void {}\n`);
  write("src/generated/schema.ts", `export const generatedSchema: number = 1;\n`);

  before_snapshot = snapshotWorkspace();
  router = new Router(loadConfig(ws));
});

after(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe("navigation levels", () => {
  it("directory of directories returns a project overview", () => {
    const out = router.handle({ path: "src" });
    assert.match(out, /services\/\s+3 files/);
    assert.ok(out.includes("UserService"));
    assert.match(out, /drill down: ts_header\("src\//);
  });

  it("directory of files returns per-file export lists", () => {
    const out = router.handle({ path: "src/services" });
    assert.match(out, /userService\.ts.*UserService, createUserService/);
    assert.ok(!out.includes("slugify"), "non-exported symbols stay out of directory listings");
  });

  it("file path defaults to depth:exports, hiding non-exported symbols", () => {
    const out = router.handle({ path: "src/services/userService.ts" });
    assert.match(out, /getUser\(id: string\): \{ id: string; name: string; \}/);
    assert.match(out, /\/\/ \[?L\d/);
    assert.ok(out.includes("// Fetch by id."));
    // Non-exported helper hidden at default depth ("exports")
    assert.ok(!out.includes("slugify"), "non-exported slugify hidden at default depth");
  });

  it("file path with explicit depth:all shows non-exported symbols", () => {
    const out = router.handle({ path: "src/services/userService.ts", depth: "all" });
    assert.ok(out.includes("slugify"), "non-exported slugify appears at depth:all");
    assert.ok(out.includes("Internal helper"), "its doc appears too");
  });

  it("file path with explicit depth:exports hides non-exported symbols", () => {
    const out = router.handle({ path: "src/services/userService.ts", depth: "exports" });
    assert.ok(out.includes("createUserService"), "exported symbol present");
    assert.ok(!out.includes("slugify"), "non-exported slugify hidden at depth:exports");
  });
});

describe("directory listing details", () => {
  it("appends the file-level doc to TOC rows", () => {
    const out = router.handle({ path: "src/services" });
    assert.match(out, /authService\.ts.*— Token verification utilities\./);
  });

  it("detects barrel files", () => {
    const out = router.handle({ path: "src/services" });
    assert.match(out, /index\.ts.*barrel: \.\/userService\.js, \.\/authService\.js/);
  });

  it("tags test files", () => {
    const out = router.handle({ path: "src/utils" });
    assert.match(out, /retry\.test\.ts \[test\]/);
  });
});

describe("guard rails", () => {
  it("responds gently to missing paths, pointing back to the overview", () => {
    const out = router.handle({ path: "src/nope.ts" });
    assert.ok(out.includes('ts_header(".")'));
  });

  it("declines non-TypeScript files", () => {
    write("notes.md", "# notes\n");
    const out = router.handle({ path: "notes.md" });
    assert.match(out, /not a TypeScript file/);
    fs.rmSync(path.join(ws, "notes.md"));
  });

  it("rejects paths that escape the workspace", () => {
    assert.throws(() => router.handle({ path: "../../etc/passwd" }), /escapes workspace/);
  });
});

describe("multiplicity in directory rollups", () => {
  it("annotates same-named exports from different files as (\u00d7n)", () => {
    const out = router.handle({ path: "src" });
    assert.match(out, /User \(\u00d72\)/);
  });
});

describe("filter parameter", () => {
  it("filters file headers to matching symbols (keeping matching class members)", () => {
    const out = router.handle({ path: "src/services/userService.ts", filter: "getUser" });
    assert.ok(out.includes("getUser"));
    assert.ok(!out.includes("createUserService"));
    assert.match(out, /\[filter: "getUser"/);
  });

  it("recursively lists all matching files with workspace-relative paths, line counts, and matching symbols", () => {
    // filter "User" matches src/services/userService.ts, src/models/user.ts, src/models/adminUser.ts
    const out = router.handle({ path: ".", filter: "User" });
    assert.match(out, /src\/models\/adminUser\.ts\s+2L\s+User/);
    assert.match(out, /src\/models\/user\.ts\s+2L\s+User/);
    assert.match(out, /src\/services\/userService\.ts\s+9L\s+UserService, createUserService/);
  });

  it("promotes to full header when a filtered request resolves to exactly one matching file", () => {
    // filter "createUserService" matches only src/services/userService.ts
    const out = router.handle({ path: ".", filter: "createUserService" });
    assert.match(out, /\[filter: "createUserService" — matched 1 file; showing full header\]/);
    // Should show non-matching symbols too (the whole file)
    assert.ok(out.includes("class UserService"), "contains UserService class");
    assert.ok(out.includes("getUser(id: string)"), "contains getUser method");
  });

  it("falls back to directory-grouped TOC with a hint when recursive listing exceeds budget", () => {
    const out = router.handle({ path: ".", filter: "User", max_tokens: 15 });
    // Should fall back to directory-grouped project TOC
    assert.match(out, /src\/\s+7 files/);
    assert.match(out, /\/\/ hint: too many matching files to list; narrow with a more specific filter/);
  });

  it("says so and appends a hint when filter matches nothing in directory or project overview", () => {
    const out = router.handle({ path: ".", filter: "zzz_nothing" });
    assert.match(out, /no symbols matching the filter under \.\//);
    assert.match(out, /\/\/ hint: try a shorter\/partial filter, or grep for body text/);
  });

  it("says so and appends a hint when filter matches nothing in a single file", () => {
    const out = router.handle({ path: "src/services/userService.ts", filter: "zzz_nothing" });
    assert.match(out, /no symbols matching "zzz_nothing" in src\/services\/userService\.ts/);
    assert.match(out, /\/\/ hint: try a shorter\/partial filter, or grep for body text/);
  });
});

describe("gitignore", () => {
  it("hides gitignored files and directories from listings", () => {
    const out = router.handle({ path: "src" });
    assert.ok(!out.includes("secret"), "ignored file listed");
    assert.ok(!out.includes("generated"), "ignored directory listed");
  });

  it("still serves an ignored file when addressed directly", () => {
    const out = router.handle({ path: "src/secret.ts" });
    assert.ok(out.includes("leak"), "direct file access should bypass listing filters");
  });
});

describe("temp-file policy", () => {
  it("writes nothing into the workspace, even with incremental:true in tsconfig", () => {
    // Exercise all levels first so any would-be writes have happened.
    router.handle({ path: "." });
    router.handle({ path: "src/services" });
    router.handle({ path: "src/services/userService.ts", depth: "deep", docs: "full" });
    assert.equal(snapshotWorkspace(), before_snapshot);
  });
});

describe("includeImports option", () => {
  it("shows imports block when includeImports is true on a file with imports", () => {
    write(
      "src/services/importTest.ts",
      `import { UserService } from "./userService.js";\nimport type { TokenPair } from "./authService.js";\n\nexport function create() { return new UserService(); }\n`
    );
    const out = router.handle({ path: "src/services/importTest.ts", includeImports: true });
    assert.ok(out.includes("// -- imports --"), "imports block present");
    assert.ok(out.includes('import { UserService } from "./userService.js";'));
    assert.ok(out.includes('import type { TokenPair } from "./authService.js";'));
    fs.rmSync(path.join(ws, "src/services/importTest.ts"));
  });

  it("omits imports block when includeImports is not set (default false)", () => {
    write(
      "src/services/importTest2.ts",
      `import { UserService } from "./userService.js";\n\nexport function create() { return new UserService(); }\n`
    );
    const out = router.handle({ path: "src/services/importTest2.ts" });
    assert.ok(!out.includes("-- imports --"), "no imports block by default");
    fs.rmSync(path.join(ws, "src/services/importTest2.ts"));
  });
});
describe("batch file inspection", () => {
  it("array of 2 files → both headers present, in order, separated by blank line", () => {
    const out = router.handle({ path: ["src/services/userService.ts", "src/services/authService.ts"] });
    assert.ok(out.includes("userService.ts"), "first file present");
    assert.ok(out.includes("authService.ts"), "second file present");
    // userService should come before authService
    assert.ok(out.indexOf("userService.ts") < out.indexOf("authService.ts"), "order preserved");
    // Separated by blank line (\n\n between the two headers)
    const first = out.indexOf("userService.ts");
    const second = out.indexOf("authService.ts");
    const between = out.slice(first, second);
    assert.ok(between.includes("\n\n"), "blank-line separator between headers");
  });

  it("glob src/**/*.ts matches nested files, skips .d.ts and node_modules", () => {
    // Write a .d.ts that should be excluded
    write("src/types.d.ts", "export type X = string;\n");
    const out = router.handle({ path: "src/services/*.ts" });
    assert.ok(out.includes("userService.ts"), "userService matched");
    assert.ok(out.includes("authService.ts"), "authService matched");
    assert.ok(!out.includes("types.d.ts"), ".d.ts excluded");
    fs.rmSync(path.join(ws, "src/types.d.ts"));
  });

  it("array with one missing file → other file still rendered + not-found line", () => {
    const out = router.handle({ path: ["src/services/userService.ts", "src/nope.ts"] });
    assert.ok(out.includes("userService.ts"), "existing file rendered");
    assert.ok(out.includes("not found: src/nope.ts"), "not-found note present");
  });

  it("duplicate resolution (file listed twice) → rendered once", () => {
    const out = router.handle({ path: ["src/services/userService.ts", "src/services/userService.ts"] });
    // The banner line with the path should appear exactly once (may be a markdown link)
    const banners = out.split("\n").filter((l) => /==== .*userService\.ts/.test(l));
    assert.equal(banners.length, 1, "deduplicated to single header");
  });

  it(">20 files → refusal message, no headers", () => {
    // Create 21 tiny files
    for (let i = 0; i < 21; i++) write(`src/gen/f${i}.ts`, `export const x${i} = ${i};\n`);
    const paths = Array.from({ length: 21 }, (_, i) => `src/gen/f${i}.ts`);
    const out = router.handle({ path: paths });
    assert.match(out, /batch too large \(21 files\)/);
    assert.ok(!out.includes("===="), "no file headers rendered");
    // Cleanup
    fs.rmSync(path.join(ws, "src/gen"), { recursive: true, force: true });
  });

  it("directory in array → per-item rejection message", () => {
    const out = router.handle({ path: ["src/services", "src/services/userService.ts"] });
    assert.ok(out.includes("src/services is a directory"), "directory rejection note");
    assert.ok(out.includes("userService.ts"), "file still rendered");
  });

  it("filter applies inside batch items", () => {
    const out = router.handle({
      path: ["src/services/userService.ts", "src/services/authService.ts"],
      filter: "getUser",
    });
    assert.ok(out.includes("getUser"), "matching symbol present");
    assert.ok(!out.includes("createUserService"), "non-matching symbol filtered out from first file");
    // authService has no getUser → should show no-symbols message
    assert.ok(out.includes("no symbols matching"), "no-match note for second file");
  });
});
