/**
 * Server configuration + temp-file policy (design decision, session 2026-07-06):
 *
 *   1. Default is ZERO disk writes. All caching is in-memory.
 *   2. Persistent cache is opt-in via TS_HEADER_CACHE=1, resolved:
 *        TS_HEADER_CACHE_DIR  ->  $XDG_CACHE_HOME/ts-header  ->  os.tmpdir()/ts-header
 *      never the workspace. Probe-write at startup; on failure, log one line
 *      and degrade to memory-only. Never crash over a cache.
 *   3. If an operator explicitly points the cache inside the workspace, drop a
 *      `.gitignore` containing `*` in the cache dir (node_modules/.cache convention).
 *   4. Compiler options are always overridden with noEmit/incremental:false so
 *      we can never write .tsbuildinfo or emit output into the user's repo,
 *      regardless of their tsconfig.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DocsMode } from "./model.js";

export interface ServerConfig {
  workspaceRoot: string;
  /** null = memory-only (the default and the sandbox-safe mode) */
  cacheDir: string | null;
  docsDefault: DocsMode;
  denseGroupMinLines: number;
  maxLanguageServices: number;
  /** Respect the workspace-root .gitignore in directory listings (default on; TS_HEADER_GITIGNORE=0 disables). */
  useGitignore: boolean;
}

/**
 * Returns an error message if `resolved` is the filesystem root, the home
 * directory, or an ancestor of the home directory. Returns undefined when safe.
 */
export function unsafeWorkspaceReason(resolved: string): string | undefined {
  const root = path.parse(resolved).root;
  const home = os.homedir();
  if (
    resolved === root ||
    resolved === home ||
    home.startsWith(resolved + path.sep)
  ) {
    return (
      `workspaceRoot resolved to "${resolved}" which is the filesystem root, ` +
      `the home directory, or an ancestor of it — this would scan system ` +
      `directories. Pass an explicit project path as the second arg to the server ` +
      `(e.g. "args": ["dist/server.js", "/path/to/project"]).`
    );
  }
  return undefined;
}

export function loadConfig(workspaceRoot: string): ServerConfig {
  const resolved = path.resolve(workspaceRoot);
  const reason = unsafeWorkspaceReason(resolved);
  if (reason) {
    console.error(`[ts-header] WARNING: ${reason}`);
  }
  return {
    workspaceRoot: resolved,
    cacheDir: process.env.TS_HEADER_CACHE === "1" ? resolveCacheDir(workspaceRoot) : null,
    docsDefault: parseDocs(process.env.TS_HEADER_DOCS) ?? "brief",
    denseGroupMinLines: intEnv("TS_HEADER_DENSE_MIN", 6),
    maxLanguageServices: intEnv("TS_HEADER_MAX_PROJECTS", 4),
    useGitignore: process.env.TS_HEADER_GITIGNORE !== "0",
  };
}

function resolveCacheDir(workspaceRoot: string): string | null {
  const candidates = [
    process.env.TS_HEADER_CACHE_DIR,
    process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, "ts-header"),
    path.join(os.tmpdir(), "ts-header"),
  ].filter((c): c is string => !!c);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.probe-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      // Pollution guard: cache explicitly placed inside the workspace must
      // never reach version control.
      const rel = path.relative(path.resolve(workspaceRoot), dir);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const gi = path.join(dir, ".gitignore");
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
      }
      return dir;
    } catch {
      continue; // sandbox said no; try the next candidate
    }
  }
  console.error("[ts-header] no writable cache location; running memory-only (fully supported)");
  return null;
}

function parseDocs(v: string | undefined): DocsMode | undefined {
  return v === "none" || v === "brief" || v === "full" ? v : undefined;
}

function intEnv(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
