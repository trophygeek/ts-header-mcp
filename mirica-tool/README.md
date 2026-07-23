# Mirica setup

"Mirica" is a human–AI collaboration platform prototype. If you don't use it, you can ignore this directory.

Mirica's custom MCP tools are sandboxed JavaScript files (fetch-only, no process spawning), so they cannot launch a stdio server. Instead, a small HTTP bridge (`http-server.mjs`, in the repo root) wraps the same router and serves plain JSON on `127.0.0.1:7461`, and the Mirica tool file in this directory calls it via `fetch()`.

## Install

```bash
# 1. Build, then start the bridge (detached; survives closing the terminal)
pnpm run build
nohup node /path/to/ts-header/http-server.mjs >/tmp/ts-header-http.log 2>&1 &

# 2. Install the tool file
cp mirica-tool/ts_header.js \
  ~/Library/Application\ Support/ArtificialNecessity/MiricaLLMData/custom-mcp-tools/
#  (Windows: %LOCALAPPDATA%\ArtificialNecessity\MiricaLLMData\custom-mcp-tools\)
```

Then click **Reload Tools** in Mirica's Settings → MCP Tools. The tool appears as `ts_header__view` and takes an extra `workspace` argument (absolute path to the project to serve), since one bridge serves any number of workspaces.

When adding the agent rule from the main README's [“Teach your agent to use it”](../README.md#teach-your-agent-to-use-it) section, use the name `ts_header__view` instead of `ts_header`.

## Operations

The bridge does not persist across reboots. To restart it, rerun the `nohup` line above — or just ask a Mirica agent to start it; the tool's error message on a failed connection includes the exact command. Check whether it is running with `curl -s http://127.0.0.1:7461/health`.

If you change the bridge or the tool: restart the bridge (kill the `node .../http-server.mjs` process and rerun it) after rebuilding, and re-copy `mirica-tool/ts_header.js` + Reload Tools after editing the tool file.
