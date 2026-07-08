/**
 * Minimal .gitignore matcher for directory listings (design review 2026-07).
 * Reads the workspace-root .gitignore only. Supported subset: comments,
 * blank lines, negation (!), directory-only patterns (trailing /), root
 * anchoring (leading /), `*`, `?`, and `**`. Nested .gitignore files and
 * more exotic bracket patterns are not handled; the hardcoded skip list
 * (node_modules, .git, dist, ...) remains as a baseline underneath.
 * Disable entirely with TS_HEADER_GITIGNORE=0.
 */

import fs from "node:fs";
import path from "node:path";

interface Rule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

export class GitIgnore {
  private constructor(private rules: Rule[]) {}

  static load(workspaceRoot: string): GitIgnore | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(workspaceRoot, ".gitignore"), "utf8");
    } catch {
      return undefined;
    }
    const rules: Rule[] = [];
    for (let line of raw.split("\n")) {
      line = line.replace(/\r$/, "");
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      let pattern = line.trim();
      let negated = false;
      if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
      }
      let dirOnly = false;
      if (pattern.endsWith("/")) {
        dirOnly = true;
        pattern = pattern.slice(0, -1);
      }
      // Anchored if it starts with / or contains a / before the last segment.
      const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
      if (pattern.startsWith("/")) pattern = pattern.slice(1);
      const re = toRegex(pattern, anchored);
      if (re) rules.push({ re, negated, dirOnly });
    }
    return rules.length ? new GitIgnore(rules) : undefined;
  }

  /** relPath uses forward slashes and no leading ./ ; last matching rule wins. */
  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(relPath)) ignored = !r.negated;
    }
    return ignored;
  }
}

function toRegex(pattern: string, anchored: boolean): RegExp | undefined {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/`, `/**`, or bare `**` — crosses directory boundaries.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  try {
    return new RegExp(`${prefix}${out}$`);
  } catch {
    return undefined; // skip patterns our subset can't express
  }
}
