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
import { loadConfig } from "./config.js";
import { Router } from "./router.js";

const config = loadConfig(process.argv[2] ?? process.cwd());
const router = new Router(config);

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
    try {
      const text = router.handle({
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
