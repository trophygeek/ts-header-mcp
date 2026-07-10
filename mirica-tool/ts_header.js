// Mirica custom MCP tool: ts-header
// Bridges to the local ts-header HTTP server (http-server.mjs in the ts-header repo).
// Start the bridge with:  node /Users/tomn/src/ts-header/http-server.mjs   (port 7461)

const TS_HEADER_URL = "http://127.0.0.1:7461/ts-header";

const MCP_TOOL_META = {
    scope: "global",
    state: "stateless",
    description: "Header-file view of TypeScript source: function/class/type signatures with original line numbers, per file, directory, or whole project. Backed by a local ts-header HTTP bridge."
};

const MCP_TOOLS = {
    view: {
        description: "View TypeScript code as a compact header: every function, class, and type signature with its source line number (// L45). Give a directory path to see what each file exports; give a file path/glob/array to see signatures. Works even when the code has errors. Use this INSTEAD of reading whole .ts files - then read source only at the line numbers you need. Start with path '.' for a project overview.",
        parameters: {
            type: "object",
            properties: {
                workspace: { type: "string", description: "Optional absolute path to the TypeScript project root. If omitted, the tool will attempt to auto-detect the workspace directory." },
                path: {
                    anyOf: [
                        { type: "string" },
                        { type: "array", items: { type: "string" } }
                    ],
                    description: "File or directory path relative to the workspace. '.' for the project overview. Supports glob patterns or an array of paths for batch headers (cap of 20)."
                },
                depth: { type: "string", description: "exports (default): exported declarations only. all: also non-exported and private. deep: also inner functions/classes nested in function bodies." },
                docs: { type: "string", description: "none: signatures only. brief (default): one-sentence doc summaries. full: complete JSDoc including @param/@throws." },
                max_tokens: { type: "integer", description: "Approximate output budget. Default 4000. Raise if output was truncated." },
                filter: { type: "string", description: "Show only symbols whose NAME matches this pattern (case-insensitive regex; plain text works too). With path '.', acts as a project-wide typed symbol search." },
                includeImports: { type: "boolean", description: "When true, include the file's import statements in the header output. Default false." }
            },
            required: ["path"]
        }
    }
};

const MCP_TOOL_INSTRUCTIONS = `
ts_header__view requires a local bridge process:
    node /Users/tomn/src/ts-header/http-server.mjs
If a call fails with a connection error, ask the user to start the bridge (or start it yourself via execute_command, backgrounded), then retry.

Usage pattern (ls/cat model):
1. view(workspace, ".") -> project overview (directories + top exports)
2. view(workspace, "src") -> per-file export list
3. view(workspace, "src/foo.ts") -> full signatures with // L-numbers; then read the source file only at those lines.
4. view(workspace, "src/**/*.ts", { includeImports: true }) -> batch view files matching glob with their imports.
Filter example: view(workspace, ".", filter: "booking") = project-wide symbol search.
`;

function view(params) {
    let workspace = params.workspace;
    if (!workspace) {
        if (typeof process !== "undefined") {
            workspace = process.env.WORKSPACE_ROOT || process.env.PROJECT_ROOT || process.env.PWD || process.cwd();
        }
    }

    if (!workspace) {
        return "ERROR: 'workspace' parameter is missing and could not be determined automatically.";
    }

    let resp;
    try {
        resp = fetch(TS_HEADER_URL, {
            method: "POST",
            body: {
                workspace: workspace,
                path: params.path,
                depth: params.depth,
                docs: params.docs,
                max_tokens: params.max_tokens,
                filter: params.filter,
                includeImports: params.includeImports
            },
            contentType: "application/json"
        });
    } catch (e) {
        return "ERROR: could not reach ts-header bridge at " + TS_HEADER_URL +
            " (" + e + "). Start it with: node /Users/tomn/src/ts-header/http-server.mjs";
    }
    if (!resp.ok) {
        return "ERROR: bridge returned HTTP " + resp.status + ": " + resp.text();
    }
    const data = resp.json();
    if (!data.ok) {
        return "ts_header error: " + data.error;
    }
    return data.text;
}
