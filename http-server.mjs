#!/usr/bin/env node
/**
 * ts-header HTTP bridge for clients that can only speak HTTP (e.g. Mirica
 * sandboxed MCP tools). NOT an MCP transport — a plain JSON POST endpoint
 * that reuses the same Router as the stdio server.
 *
 * Usage: node http-server.mjs [port]           (default 7461)
 *
 * POST /ts-header  { workspace, path, depth?, docs?, max_tokens?, filter?, includeImports? }
 *   -> { ok: true, text: "...header..." }  or  { ok: false, error: "..." }
 * GET  /health     -> { ok: true, name: "ts-header-http" }
 *
 * Binds 127.0.0.1 only. Same workspace-safety guards as the stdio server.
 */
import http from "node:http";
import path from "node:path";
import { loadConfig, unsafeWorkspaceReason } from "./dist/config.js";
import { Router } from "./dist/router.js";

const PORT = Number(process.argv[2]) || 7461;
const routers = new Map();

function getRouter(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot);
  const reason = unsafeWorkspaceReason(resolved);
  if (reason) throw new Error(reason);
  let r = routers.get(resolved);
  if (!r) {
    r = new Router(loadConfig(resolved));
    routers.set(resolved, r);
  }
  return r;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, { ok: true, name: "ts-header-http", workspaces: [...routers.keys()] });
  }
  if (req.method !== "POST" || req.url !== "/ts-header") {
    return send(404, { ok: false, error: "POST /ts-header or GET /health" });
  }

  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try {
      const body = JSON.parse(raw || "{}");
      if (!body.workspace) return send(400, { ok: false, error: "missing 'workspace' (absolute path to the project to serve)" });
      if (body.path == null) return send(400, { ok: false, error: "missing 'path' (file/dir relative to workspace; '.' for overview)" });
      const router = getRouter(body.workspace);
      const text = router.handle({
        path: body.path,
        depth: body.depth,
        docs: body.docs,
        max_tokens: body.max_tokens,
        filter: body.filter,
        includeImports: body.includeImports,
      });
      send(200, { ok: true, text });
    } catch (err) {
      send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[ts-header-http] listening on http://127.0.0.1:${PORT}`);
});
