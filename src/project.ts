/**
 * Project manager (design doc §3): nearest-tsconfig discovery and one
 * long-lived ts.LanguageService per discovered config, LRU-evicted.
 *
 * Anti-pollution invariant: compiler options are ALWAYS overridden with
 * noEmit + incremental:false so a user tsconfig with `incremental: true`
 * can never cause a .tsbuildinfo write into their repo.
 */

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const FORCED_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  incremental: false,
  composite: false,
  declaration: false,
  tsBuildInfoFile: undefined,
};

interface ProjectEntry {
  service: ts.LanguageService;
  fileNames: Set<string>;
  versions: Map<string, string>;
  lastUsed: number;
}

export class ProjectManager {
  private projects = new Map<string, ProjectEntry>(); // key: tsconfig path or "<inferred>"
  private configForDir = new Map<string, string | undefined>();

  constructor(private maxProjects: number = 4) {}

  /** Returns program pieces for one file, creating/reusing its project. */
  getFileContext(absFile: string): {
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    diagnostics: ts.Diagnostic[];
  } | undefined {
    const configPath = this.findConfig(absFile);
    const entry = this.getProject(configPath, absFile);
    entry.lastUsed = Date.now();

    if (!entry.fileNames.has(absFile)) {
      // File outside the config's include set (or inferred project): add it.
      entry.fileNames.add(absFile);
      this.bump(entry, absFile);
    }
    this.refreshVersions(entry);

    const program = entry.service.getProgram();
    const sourceFile = program?.getSourceFile(absFile);
    if (!program || !sourceFile) return undefined;
    return {
      sourceFile,
      checker: program.getTypeChecker(),
      diagnostics: [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
      ],
    };
  }

  private findConfig(absFile: string): string | undefined {
    const dir = path.dirname(absFile);
    if (this.configForDir.has(dir)) return this.configForDir.get(dir);
    const found = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
    this.configForDir.set(dir, found);
    return found;
  }

  private getProject(configPath: string | undefined, seedFile: string): ProjectEntry {
    const key = configPath ?? "<inferred>";
    const existing = this.projects.get(key);
    if (existing) return existing;

    let fileNames: string[] = [seedFile];
    let options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      allowJs: true,
    };
    let projectReferences: readonly ts.ProjectReference[] | undefined;

    if (configPath) {
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        raw.config ?? {},
        ts.sys,
        path.dirname(configPath)
      );
      fileNames = parsed.fileNames.length ? parsed.fileNames : [seedFile];
      options = parsed.options;
      projectReferences = parsed.projectReferences;
      // Monorepo project references: fold referenced projects' sources into
      // this program so cross-package types resolve against source, not
      // stale build output. (Solution-builder integration: M2 refinement.)
      for (const ref of projectReferences ?? []) {
        const refConfig = ts.resolveProjectReferencePath(ref);
        const refRaw = ts.readConfigFile(refConfig, ts.sys.readFile);
        if (refRaw.config) {
          const refParsed = ts.parseJsonConfigFileContent(
            refRaw.config,
            ts.sys,
            path.dirname(refConfig)
          );
          fileNames.push(...refParsed.fileNames);
        }
      }
    }
    options = { ...options, ...FORCED_OPTIONS };

    const entry = this.createEntry(new Set(fileNames.map((f) => path.resolve(f))), options);
    this.projects.set(key, entry);
    this.evict();
    return entry;
  }

  private createEntry(fileNames: Set<string>, options: ts.CompilerOptions): ProjectEntry {
    const versions = new Map<string, string>();
    const entry: ProjectEntry = { service: undefined as any, fileNames, versions, lastUsed: Date.now() };

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...entry.fileNames],
      getScriptVersion: (f) => entry.versions.get(path.resolve(f)) ?? statVersion(f),
      getScriptSnapshot: (f) => {
        if (!fs.existsSync(f)) return undefined;
        return ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
      },
      getCurrentDirectory: () => process.cwd(),
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    entry.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return entry;
  }

  /** Refresh versions from disk so the incremental service sees edits. */
  private refreshVersions(entry: ProjectEntry): void {
    for (const f of entry.fileNames) {
      entry.versions.set(f, statVersion(f));
    }
  }

  private bump(entry: ProjectEntry, file: string): void {
    entry.versions.set(path.resolve(file), statVersion(file));
  }

  private evict(): void {
    while (this.projects.size > this.maxProjects) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [k, v] of this.projects) {
        if (v.lastUsed < oldest) {
          oldest = v.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) return;
      this.projects.get(oldestKey)!.service.dispose();
      this.projects.delete(oldestKey);
    }
  }
}

function statVersion(f: string): string {
  try {
    const s = fs.statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "0";
  }
}
