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
  });

  it("file path returns a full header with line annotations and docs", () => {
    const out = router.handle({ path: "src/services/userService.ts" });
    assert.match(out, /getUser\(id: string\): \{ id: string; name: string; \}/);
    assert.match(out, /\/\/ L\d/);
    assert.ok(out.includes("// Fetch by id."));
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

  it("filters directory listings to files with matching exports", () => {
    const out = router.handle({ path: "src/services", filter: "token" });
    assert.ok(out.includes("verifyToken"));
    assert.ok(!out.includes("userService.ts"));
  });

  it("filters the project overview across directories", () => {
    const out = router.handle({ path: "src", filter: "^retry$" });
    assert.ok(out.includes("utils/"));
    assert.ok(!out.includes("services/"));
  });

  it("says so when nothing matches", () => {
    const out = router.handle({ path: "src/services/userService.ts", filter: "zzz_nothing" });
    assert.match(out, /no symbols matching/);
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
