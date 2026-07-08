#!/usr/bin/env node
/**
 * ts-header MCP server entry. Stdio transport.
 * Usage: ts-header-mcp [workspaceRoot]   (defaults to cwd)
 *
 * NOTE: this module is the only one that imports @modelcontextprotocol/sdk,
 * so everything below it is testable without the SDK installed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, unsafeWorkspaceReason } from "./config.js";
import { Router } from "./router.js";

const config = loadConfig(process.argv[2] ?? process.cwd());
const unsafeReason = unsafeWorkspaceReason(config.workspaceRoot);

const routers = new Map<string, Router>();

function getRouter(workspaceRoot: string): Router {
  let r = routers.get(workspaceRoot);
  if (!r) {
    const rootConfig = {
      ...config,
      workspaceRoot,
    };
    r = new Router(rootConfig);
    routers.set(workspaceRoot, r);
  }
  return r;
}

if (!unsafeReason) {
  routers.set(config.workspaceRoot, new Router(config));
}

const server = new McpServer({ name: "ts-header", version: "0.1.0" });

server.registerTool(
  "ts_header",
  {
    title: "TypeScript header view",
    description:
      "View TypeScript code as a compact header: every function, class, and type " +
      "signature with its source line number (// L45). Give a directory path to see " +
      "what each file exports; give a file path to see all its signatures. Works even " +
      "when the code has errors. Use this INSTEAD of reading whole files — then read " +
      "the source only at the line numbers you need. Start with ts_header(\".\").",
    inputSchema: {
      path: z
        .string()
        .describe('File or directory path, relative to the workspace. "." for the project overview.'),
      depth: z
        .enum(["exports", "all", "deep"])
        .optional()
        .describe(
          "exports (default): exported declarations only. all: also non-exported and private. " +
            "deep: also inner functions and classes nested inside function bodies."
        ),
      docs: z
        .enum(["none", "brief", "full"])
        .optional()
        .describe(
          "none: signatures only. brief (default): one-sentence doc summaries. " +
            "full: complete JSDoc including @param/@throws."
        ),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Approximate output budget. Default 4000. Raise it if output was truncated."),
      filter: z
        .string()
        .optional()
        .describe(
          "Show only symbols whose NAME matches this pattern (regex, case-insensitive; plain text works too). " +
            "Applies at every level — use ts_header(\".\", {filter: \"booking\"}) to find booking-related symbols across the project."
        ),
    },
  },
  async (args) => {
    // 1. Try to fetch roots from client to support multi-workspace/global setup
    const clientRoots: string[] = [];
    try {
      const result = await server.server.listRoots();
      if (result && result.roots) {
        for (const r of result.roots) {
          if (r.uri.startsWith("file://")) {
            try {
              const p = fileURLToPath(r.uri);
              if (!unsafeWorkspaceReason(p)) {
                clientRoots.push(p);
              }
            } catch {}
          }
        }
      }
    } catch {
      // client might not support roots, or not connected yet
    }

    let chosenRoot: string | undefined;

    if (clientRoots.length > 0) {
      // Try to match the path to one of the roots
      if (args.path && args.path !== ".") {
        for (const root of clientRoots) {
          const fullPath = path.resolve(root, args.path);
          if (fs.existsSync(fullPath)) {
            chosenRoot = root;
            break;
          }
        }
      }
      // If not matched, default to the first root
      if (!chosenRoot) {
        chosenRoot = clientRoots[0];
      }
    }

    // Fallback to configured workspace root if safe
    if (!chosenRoot && !unsafeReason) {
      chosenRoot = config.workspaceRoot;
    }

    if (!chosenRoot) {
      return {
        content: [{
          type: "text",
          text: `// ts_header error: No safe workspace root could be determined.\n` +
            `// Configured root: "${config.workspaceRoot}" (${unsafeReason ?? "safe"})\n` +
            (clientRoots.length === 0 ? "// No safe roots returned by the IDE.\n" : "") +
            `// Fix: configure the server with an explicit path in your MCP config args, e.g. "args": ["dist/server.js", "/path/to/project"]`,
        }],
        isError: true,
      };
    }

    try {
      const activeRouter = getRouter(chosenRoot);
      const text = activeRouter.handle({
        path: args.path,
        depth: args.depth,
        docs: args.docs,
        max_tokens: args.max_tokens,
        filter: args.filter,
      });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `// ts_header error: ${msg}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ts-header] serving ${config.workspaceRoot}` +
  (config.cacheDir ? ` (cache: ${config.cacheDir})` : " (memory-only, zero disk writes)"));
