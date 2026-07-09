#!/usr/bin/env node
/**
 * ts-header CLI entry point for non-MCP integrations.
 * Usage: ts-header-cli <workspaceRoot> <path> [--depth=exports|all|deep] [--docs=none|brief|full] [--max-tokens=N] [--filter=PATTERN] [--include-imports]
 *
 * Prints the header text to stdout, errors to stderr.
 * Exit code 0 on success, 1 on error.
 */

import { loadConfig } from "./config.js";
import { Router } from "./router.js";

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: ts-header-cli <workspaceRoot> <path> [--depth=exports|all|deep] [--docs=none|brief|full] [--max-tokens=N] [--filter=PATTERN] [--include-imports]");
    process.exit(1);
  }

  const workspaceRoot = args[0];
  const reqPath = args[1];

  // Parse optional flags
  let depth: "exports" | "all" | "deep" | undefined;
  let docs: "none" | "brief" | "full" | undefined;
  let maxTokens: number | undefined;
  let filter: string | undefined;
  let includeImports = false;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--depth=")) {
      const val = arg.slice("--depth=".length);
      if (val === "exports" || val === "all" || val === "deep") depth = val;
    } else if (arg.startsWith("--docs=")) {
      const val = arg.slice("--docs=".length);
      if (val === "none" || val === "brief" || val === "full") docs = val;
    } else if (arg.startsWith("--max-tokens=")) {
      const val = parseInt(arg.slice("--max-tokens=".length), 10);
      if (!isNaN(val) && val > 0) maxTokens = val;
    } else if (arg.startsWith("--filter=")) {
      filter = arg.slice("--filter=".length);
    } else if (arg === "--include-imports") {
      includeImports = true;
    }
  }

  try {
    const config = loadConfig(workspaceRoot);
    const router = new Router(config);
    const result = router.handle({
      path: reqPath,
      depth,
      docs,
      max_tokens: maxTokens,
      filter,
      includeImports,
    });
    process.stdout.write(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ts-header error: ${msg}`);
    process.exit(1);
  }
}

main();
