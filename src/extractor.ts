/**
 * Extractor: ts.SourceFile + ts.TypeChecker -> FileHeaderModel.
 * Raw TypeScript compiler API implementation (design doc §9).
 *
 * The single exported entry point is `extract()`. Nothing outside this file
 * touches ts.* node types for extraction purposes, so this module can be
 * replaced wholesale (e.g. by a ts-morph implementation) without changes
 * elsewhere.
 */

import ts from "typescript";
import type {
  DeclEntry,
  DeclKind,
  Depth,
  DocInfo,
  ErrorMark,
  FileHeaderModel,
} from "./model.js";

const MAX_ERR_MSG = 90;
const BRIEF_MAX = 100;
/** Max raw snippet length before hard-cap truncation in the extractor. */
const MAX_SNIPPET_LEN = 600;
/** Max rendered length for a variable/property type before eliding with … */
const MAX_TYPE_LEN = 999999;
/** Max rendered length for a full signature line before eliding with … */
const MAX_SIG_LEN = 999999;
/** A body-less const is "dense" (groupable, no own annotation) only when small. */
const DENSE_MAX_CONST_LINES = 5;
/** Types/interfaces/enums stay groupable up to a larger span. */
const DENSE_MAX_TYPE_LINES = 12;

/**
 * De-noise a checker-rendered type: strip `import("...").` qualifiers
 * (framework types like Convex render every reference fully qualified),
 * then hard-cap the length. A truncated type with a line number beats a
 * complete 150-token type that buries the header (design review 2026-07).
 */
function cleanType(t: string, max = MAX_TYPE_LEN): string {
  let s = t.replace(/import\("[^"]*"\)\./g, "");
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

export interface ExtractInput {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  /** Semantic + syntactic diagnostics already filtered to this file. */
  diagnostics: readonly ts.Diagnostic[];
  /** Workspace-relative display path. */
  relPath: string;
  depth: Depth;
}

export function extract(input: ExtractInput): FileHeaderModel {
  const { sourceFile, checker, diagnostics, relPath, depth } = input;
  const errors = mapDiagnostics(sourceFile, diagnostics);
  const fileDoc = detectFileDoc(sourceFile);

  const entries: DeclEntry[] = [];
  const reexports: string[] = [];
  const imports: string[] = [];
  let statementCount = 0;
  let reexportCount = 0;
  let hiddenDeclCount = 0;

  for (const stmt of sourceFile.statements) {
    statementCount++;
    if (ts.isExportDeclaration(stmt)) {
      reexportCount++;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        reexports.push(stmt.moduleSpecifier.text);
      }
      continue;
    }
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      statementCount--; // imports don't count toward barrel ratio
      imports.push(stmt.getText(sourceFile).replace(/\s+/g, " ").trim());
      continue;  
    }
    const extracted = extractStatement(stmt, checker, sourceFile, depth, errors);
    // A promoted file-level doc must not ALSO appear as the first
    // declaration's doc (the compiler attaches file headers to whatever
    // declaration comes first — a misattribution the source can't help).
    if (stmt === fileDoc.suppressOn) {
      for (const e of extracted) {
        e.doc = e.doc?.deprecated ? { deprecated: true } : undefined;
      }
    }
    for (const e of extracted) {
      if (depth === "exports" && !e.exported) {
        hiddenDeclCount++;
        continue;
      }
      entries.push(e);
    }
  }

  const exportCount = countExports(entries) + reexportCount;
  const barrel =
      statementCount > 0 && reexportCount / statementCount >= 0.8 && reexportCount >= 2;

  return {
    path: relPath,
    fileDoc: fileDoc.brief,
    totalLines: sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1,
    exportCount,
    barrel,
    reexports,
    entries,
    imports,
    hiddenDeclCount,
    fileErrors: errors.unattached,
    skippedRanges: [],
  };
}

// ---------------------------------------------------------------------------
// File-level JSDoc detection
// ---------------------------------------------------------------------------

/**
 * A JSDoc block at the very top of a file is usually a FILE header, but the
 * compiler attaches it to the first statement. Promote it to a file-level
 * description when:
 *  - the first statement carries 2+ JSDoc blocks (first is the file's,
 *    last is the declaration's own — docInfo already uses the last), or
 *  - the first statement is an import (imports don't take doc comments), or
 *  - there is a blank-line gap between the doc and the declaration
 *    (in which case the declaration's doc is suppressed — see extract()).
 * A doc butted directly against the first declaration stays that
 * declaration's doc.
 */
function detectFileDoc(sf: ts.SourceFile): { brief?: string; suppressOn?: ts.Statement } {
  const first = sf.statements[0];
  if (!first) return {};
  const jsDocs = (first as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs?.length) return {};
  const doc = jsDocs[0];
  const docStartLine = sf.getLineAndCharacterOfPosition(doc.getStart(sf)).line + 1;
  if (docStartLine > 3) return {};
  const comment =
      typeof doc.comment === "string"
      ? doc.comment
      : doc.comment?.map((c) => c.text ?? "").join("") ?? "";
  const brief = firstSentence(comment);
  if (!brief) return {};

  if (jsDocs.length > 1) return { brief };
  if (ts.isImportDeclaration(first) || ts.isImportEqualsDeclaration(first)) return { brief };

  const docEndLine = sf.getLineAndCharacterOfPosition(doc.getEnd()).line + 1;
  const stmtLine = sf.getLineAndCharacterOfPosition(first.getStart(sf)).line + 1;
  if (stmtLine - docEndLine >= 2) return { brief, suppressOn: first };
  return {};
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

interface ErrorIndex {
  /** line (1-based) -> first error on that line */
  byLine: Map<number, ErrorMark>;
  unattached: ErrorMark[];
  claim(fromLine: number, toLine: number): ErrorMark | undefined;
}

function mapDiagnostics(
    sf: ts.SourceFile,
    diags: readonly ts.Diagnostic[]
): ErrorIndex {
  const byLine = new Map<number, ErrorMark>();
  for (const d of diags) {
    if (d.start === undefined) continue;
    const line = sf.getLineAndCharacterOfPosition(d.start).line + 1;
    if (byLine.has(line)) continue;
    const message = ts
        .flattenDiagnosticMessageText(d.messageText, " ")
        .slice(0, MAX_ERR_MSG);
    byLine.set(line, { line, code: d.code, message });
  }
  const claimed = new Set<number>();
  return {
    byLine,
    unattached: [],
    claim(fromLine, toLine) {
      for (let l = fromLine; l <= toLine; l++) {
        if (byLine.has(l) && !claimed.has(l)) {
          claimed.add(l);
          return byLine.get(l);
        }
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Statement dispatch
// ---------------------------------------------------------------------------

function extractStatement(
    stmt: ts.Statement,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex
): DeclEntry[] {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    return [functionEntry(stmt, stmt.name.text, checker, sf, depth, errors)];
  }
  if (ts.isClassDeclaration(stmt)) {
    return [classEntry(stmt, checker, sf, depth, errors)];
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    return [printedEntry(stmt, stmt.name.text, "interface", sf, errors, stmt)];
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    return [printedEntry(stmt, stmt.name.text, "type", sf, errors, stmt)];
  }
  if (ts.isEnumDeclaration(stmt)) {
    return [printedEntry(stmt, stmt.name.text, "enum", sf, errors, stmt)];
  }
  if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
    return [namespaceEntry(stmt, checker, sf, depth, errors)];
  }
  if (ts.isVariableStatement(stmt)) {
    return variableEntries(stmt, checker, sf, depth, errors);
  }
  if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
    return [defaultExportEntry(stmt, sf, errors)];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Functions (incl. overloads, arrow-function consts, inner functions)
// ---------------------------------------------------------------------------

function functionEntry(
    fn: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    name: string,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex,
    opts: { keyword?: string; exported?: boolean; isDefault?: boolean; arrowStyle?: boolean } = {}
): DeclEntry {
  const exported = opts.exported ?? isExported(fn as ts.Declaration);
  const { line, endLine } = lines(sf, (fn as ts.FunctionDeclaration).name ?? fn, fn);
  const sigText = signatureText(fn, checker, opts.arrowStyle);
  const keyword = opts.keyword ?? "function ";
  const prefix = exported ? (opts.isDefault ? "export default " : "export ") : "";
  const text = opts.arrowStyle
               ? `${prefix}${keyword}${name}: ${sigText}`
               : `${prefix}${keyword}${name}${sigText}`;

  const entry: DeclEntry = {
    kind: "function",
    name,
    text,
    line,
    endLine,
    exported,
    isDefault: opts.isDefault,
    dense: false,
    doc: docInfo(fn, sf),
    error: errors.claim(line, endLine),
  };

  if (depth === "deep" && fn.body) {
    const inner = innerFunctions(fn.body, checker, sf, errors);
    if (inner.length > 0) entry.children = inner;
  }
  return entry;
}

/** Render "(params): ReturnType" — or "(params) => ReturnType" for arrow style — using checked types. */
function signatureText(
    node: ts.SignatureDeclaration,
    checker: ts.TypeChecker,
    arrowStyle = false
): string {
  const sig = checker.getSignatureFromDeclaration(node);
  if (!sig) return "(…)";
  let flags = ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  if (arrowStyle) flags |= ts.TypeFormatFlags.WriteArrowStyleSignature;
  let text = checker.signatureToString(sig, node, flags, ts.SignatureKind.Call);
  // signatureToString gives "(a: T): R" — exactly what we want.
  // De-noise: optional params render as "x?: T | undefined"; the "?" already says it.
  text = text.replace(/\?\:\s*([^,)]*?)\s*\|\s*undefined(?=[,)])/g, "?: $1");
  return cleanType(text, MAX_SIG_LEN);
}

function innerFunctions(
    body: ts.Node,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    errors: ErrorIndex
): DeclEntry[] {
  const out: DeclEntry[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.push(functionEntry(node, node.name.text, checker, sf, "deep", errors, { exported: false }));
      return; // its own children handled recursively inside functionEntry
    }
    if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        ts.isIdentifier(node.name)
    ) {
      out.push(
          functionEntry(node.initializer, node.name.text, checker, sf, "deep", errors, {
            keyword: "const ",
            exported: false,
            arrowStyle: true,
          })
      );
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      out.push(classEntry(node, checker, sf, "deep", errors, { forceLocal: true }));
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function classEntry(
    cls: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex,
    opts: { forceLocal?: boolean } = {}
): DeclEntry {
  const name = cls.name?.text ?? "(anonymous class)";
  const exported = !opts.forceLocal && isExported(cls);
  const isDefault = hasModifier(cls, ts.SyntaxKind.DefaultKeyword);
  const { line, endLine } = lines(sf, cls.name ?? cls, cls);

  // Heritage clauses collapse to one line: `extends React.Component<\n  {...},\n  {...}\n>`
  // as-written breaks the header's valid-TypeScript look (field test 2026-07).
  const heritage = (cls.heritageClauses ?? [])
      .map((h) =>
               h.getText(sf).replace(/\s+/g, " ").replace(/< /g, "<").replace(/ >/g, ">")
      )
      .join(" ");
  const abstract = hasModifier(cls, ts.SyntaxKind.AbstractKeyword) ? "abstract " : "";
  const prefix = exported ? (isDefault ? "export default " : "export ") : "";
  const typeParams = cls.typeParameters
                     ? `<${cls.typeParameters.map((t) => t.getText(sf)).join(", ")}>`
                     : "";

  const children: DeclEntry[] = [];
  for (const member of cls.members) {
    const m = memberEntry(member, checker, sf, depth, errors);
    if (!m) continue;
    if (depth === "exports" && m.text.startsWith("private ")) continue;
    children.push(m);
  }

  return {
    kind: "class",
    name,
    text: `${prefix}${abstract}class ${name}${typeParams}${heritage ? " " + heritage : ""}`,
    line,
    endLine,
    exported,
    isDefault,
    dense: false,
    doc: docInfo(cls, sf),
    error: errors.claim(line, line), // header line only; members claim their own
    children,
  };
}

function memberEntry(
    member: ts.ClassElement,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex
): DeclEntry | undefined {
  const mods = memberModifiers(member);

  if (ts.isConstructorDeclaration(member)) {
    const { line, endLine } = lines(sf, member, member);
    return {
      kind: "constructor",
      name: "constructor",
      text: `${mods}constructor${signatureText(member, checker).replace(/:\s*[^:]*$/, "")}`,
      line,
      endLine,
      exported: false,
      dense: false,
      doc: docInfo(member, sf),
      error: errors.claim(line, endLine),
    };
  }

  if (ts.isMethodDeclaration(member) && member.name) {
    const name = member.name.getText(sf);
    const { line, endLine } = lines(sf, member.name, member);
    let inner: DeclEntry[] | undefined;
    if (depth === "deep" && member.body) {
      const found = innerFunctions(member.body, checker, sf, errors);
      if (found.length) inner = found;
    }
    return {
      kind: "method",
      name,
      text: `${mods}${name}${signatureText(member, checker)}`,
      line,
      endLine,
      exported: false,
      dense: false,
      doc: docInfo(member, sf),
      error: errors.claim(line, endLine),
      children: inner,
    };
  }

  if (ts.isPropertyDeclaration(member) && member.name) {
    const name = member.name.getText(sf);
    const { line } = lines(sf, member.name, member);
    const type = cleanType(
        member.type
        ? member.type.getText(sf)
        : checker.typeToString(checker.getTypeAtLocation(member))
    );
    return {
      kind: "property",
      name,
      text: `${mods}${name}: ${type}`,
      line,
      endLine: line,
      exported: false,
      dense: true,
      doc: docInfo(member, sf),
      error: errors.claim(line, line),
    };
  }

  if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
    const name = member.name.getText(sf);
    const { line } = lines(sf, member.name, member);
    const isGet = ts.isGetAccessorDeclaration(member);
    const type = isGet
                 ? checker.typeToString(checker.getTypeAtLocation(member.name))
                 : member.parameters[0]?.type?.getText(sf) ?? "unknown";
    return {
      kind: "accessor",
      name,
      text: `${mods}${isGet ? "get" : "set"} ${name}: ${type}`,
      line,
      endLine: line,
      exported: false,
      dense: true,
      doc: docInfo(member, sf),
      error: errors.claim(line, line),
    };
  }

  return undefined;
}

function memberModifiers(member: ts.ClassElement): string {
  const parts: string[] = [];
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) parts.push("private");
  if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) parts.push("protected");
  if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) parts.push("static");
  if (hasModifier(member, ts.SyntaxKind.AbstractKeyword)) parts.push("abstract");
  if (hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)) parts.push("readonly");
  const name = (member as { name?: ts.PropertyName }).name;
  if (name && ts.isPrivateIdentifier(name)) parts.push("private");
  return parts.length ? parts.join(" ") + " " : "";
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

function namespaceEntry(
    ns: ts.ModuleDeclaration,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex
): DeclEntry {
  const name = (ns.name as ts.Identifier).text;
  const { line, endLine } = lines(sf, ns.name, ns);
  const children: DeclEntry[] = [];
  if (ns.body && ts.isModuleBlock(ns.body)) {
    for (const stmt of ns.body.statements) {
      for (const e of extractStatement(stmt, checker, sf, depth, errors)) {
        if (depth === "exports" && !e.exported) continue;
        children.push(e);
      }
    }
  }
  return {
    kind: "namespace",
    name,
    text: `${isExported(ns) ? "export " : ""}namespace ${name}`,
    line,
    endLine,
    exported: isExported(ns),
    dense: false,
    doc: docInfo(ns, sf),
    error: errors.claim(line, line),
    children,
  };
}

// ---------------------------------------------------------------------------
// Variables (incl. arrow-function consts)
// ---------------------------------------------------------------------------

function variableEntries(
    stmt: ts.VariableStatement,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    depth: Depth,
    errors: ErrorIndex
): DeclEntry[] {
  const exported = isExported(stmt);
  const kw = stmt.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
  const out: DeclEntry[] = [];

  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue; // destructuring: v2
    const name = decl.name.text;

    if (
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    ) {
      const entry = functionEntry(decl.initializer, name, checker, sf, depth, errors, {
        keyword: `${kw} `,
        exported,
        arrowStyle: true,
      });
      entry.doc = docInfo(stmt, sf) ?? entry.doc;
      out.push(entry);
      continue;
    }

    const { line, endLine } = lines(sf, decl.name, decl);
    const type = cleanType(
        decl.type
        ? decl.type.getText(sf)
        : checker.typeToString(
            checker.getTypeAtLocation(decl),
            decl,
            ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
        )
    );
    // Regression guard (Convex-style `export const x = framework({...})`):
    // a const spanning many lines must keep its own line annotation, or the
    // header loses its jump targets. Dense (= groupable) only when small.
    const span = endLine - line + 1;
    const snippet = extractSnippet(decl, sf);
    out.push({
               kind: kw as DeclKind,
               name,
               text: `${exported ? "export " : ""}${kw} ${name}: ${type}`,
               line,
               endLine,
               exported,
               dense: span <= DENSE_MAX_CONST_LINES,
               doc: docInfo(stmt, sf),
               error: errors.claim(line, endLine),
               snippet,
             });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Printed declarations (interfaces, type aliases, enums) — rendered as written
// ---------------------------------------------------------------------------

function printedEntry(
    node: ts.Statement,
    name: string,
    kind: DeclKind,
    sf: ts.SourceFile,
    errors: ErrorIndex,
    named: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration
): DeclEntry {
  const { line, endLine } = lines(sf, named.name, node);
  let text = node.getText(sf);
  // Strip leading JSDoc that getText may include via full text (it doesn't — getText excludes trivia)
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 110) text = collapsed;
  return {
    kind,
    name,
    text,
    line,
    endLine,
    exported: isExported(node),
    dense: endLine - line + 1 <= DENSE_MAX_TYPE_LINES,
    doc: docInfo(node, sf),
    error: errors.claim(line, endLine),
  };
}

// ---------------------------------------------------------------------------
// JSDoc
// ---------------------------------------------------------------------------

function docInfo(node: ts.Node, sf: ts.SourceFile): DocInfo | undefined {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const tags = ts.getJSDocTags(node);
  const deprecated = tags.some((t) => t.tagName.text === "deprecated");
  if ((!jsDocs || jsDocs.length === 0) && !deprecated) return undefined;

  let brief: string | undefined;
  let full: string | undefined;
  if (jsDocs && jsDocs.length > 0) {
    const doc = jsDocs[jsDocs.length - 1];
    full = doc.getText(sf);
    const comment =
        typeof doc.comment === "string"
        ? doc.comment
        : doc.comment?.map((c) => c.text ?? "").join("") ?? "";
    brief = firstSentence(comment);
  }
  if (!brief && !full && !deprecated) return undefined;
  return { brief, full, deprecated };
}

function firstSentence(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const m = clean.match(/^.*?[.!?](?=\s|$)/);
  const s = m ? m[0] : clean;
  if (s.length <= BRIEF_MAX) return s;
  // Over the cap: cut at the last word boundary before it, not mid-word.
  const slice = s.slice(0, BRIEF_MAX - 1);
  const cut = slice.lastIndexOf(" ");
  return (cut > 0 ? slice.slice(0, cut) : slice) + "…";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

function lines(
    sf: ts.SourceFile,
    nameNode: ts.Node,
    fullNode: ts.Node
): { line: number; endLine: number } {
  const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(fullNode.getEnd()).line + 1;
  return { line, endLine };
}

// ---------------------------------------------------------------------------
// Snippet extraction for framework-wrapper consts (Feature 3)
// ---------------------------------------------------------------------------

/**
 * For `const x = framework({ args: {...}, handler: ... })` patterns, extract
 * a collapsed snippet of the `args` shape or handler parameter list.
 * Returns undefined for plain consts, non-call initializers, etc.
 */
function extractSnippet(decl: ts.VariableDeclaration, sf: ts.SourceFile): string | undefined {
  if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined;
  const call = decl.initializer;
  // Find the first object-literal argument
  const objArg = call.arguments.find((a) => ts.isObjectLiteralExpression(a)) as
      ts.ObjectLiteralExpression | undefined;
  if (!objArg) return undefined;

  // Priority 1: an `args` property (Convex convention)
  const argsProp = objArg.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "args"
  ) as ts.PropertyAssignment | undefined;
  if (argsProp) {
    let text = "args: " + argsProp.initializer.getText(sf).replace(/\s+/g, " ");
    if (text.length > MAX_SNIPPET_LEN) text = text.slice(0, MAX_SNIPPET_LEN - 1) + "…";
    return text;
  }

  // Priority 2: a handler / first function-valued property → parameter list
  const fnProp = findFnProp(objArg, sf);
  if (fnProp) {
    return fnProp;
  }

  return undefined;
}

/** Find a function-valued property (prefer "handler") and return its collapsed parameter text. */
function findFnProp(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string | undefined {
  let fallback: ts.PropertyAssignment | undefined;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const init = p.initializer;
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf);
    if (name === "handler") {
      const params = init.parameters.map((pm) => pm.getText(sf)).join(", ").replace(/\s+/g, " ");
      let text = `handler(${params})`;
      if (text.length > MAX_SNIPPET_LEN) text = text.slice(0, MAX_SNIPPET_LEN - 1) + "…";
      return text;
    }
    if (!fallback) fallback = p;
  }
  if (fallback) {
    const init = fallback.initializer as ts.ArrowFunction | ts.FunctionExpression;
    const name = ts.isIdentifier(fallback.name) ? fallback.name.text : fallback.name.getText(sf);
    const params = init.parameters.map((pm) => pm.getText(sf)).join(", ").replace(/\s+/g, " ");
    let text = `${name}(${params})`;
    if (text.length > MAX_SNIPPET_LEN) text = text.slice(0, MAX_SNIPPET_LEN - 1) + "…";
    return text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Default exports (export default <expr>)
// ---------------------------------------------------------------------------

/**
 * `export default someCall({...})` — e.g. a Convex schema's
 * `export default defineSchema({...})` — must surface as a declaration, or
 * the file renders as "0 exports" with an empty body (field report 2026-07).
 * When the expression is a call whose first argument is an object literal,
 * the object's top-level keys become children with their own line numbers.
 */
function defaultExportEntry(
    stmt: ts.ExportAssignment,
    sf: ts.SourceFile,
    errors: ErrorIndex
): DeclEntry {
  const expr = stmt.expression;
  const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;

  let text: string;
  let name = "default";
  let children: DeclEntry[] | undefined;

  if (ts.isCallExpression(expr)) {
    const callee = expr.expression.getText(sf).replace(/\s+/g, " ");
    name = callee;
    const firstArg = expr.arguments[0];
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      text = `export default ${callee}({...})`;
      const keys: DeclEntry[] = [];
      for (const p of firstArg.properties) {
        const keyName = p.name ? p.name.getText(sf) : p.getText(sf).slice(0, 40);
        const kLine = sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1;
        keys.push({
          kind: "property",
          name: keyName,
          text: keyName,
          line: kLine,
          endLine: kLine,
          exported: false,
          dense: false,
        });
      }
      if (keys.length > 0) children = keys;
    } else {
      text = `export default ${callee}(…)`;
    }
  } else {
    let collapsed = expr.getText(sf).replace(/\s+/g, " ").trim();
    if (collapsed.length > 80) collapsed = collapsed.slice(0, 79) + "…";
    text = `export default ${collapsed}`;
  }

  return {
    kind: "const",
    name,
    text,
    line,
    endLine,
    exported: true,
    isDefault: true,
    dense: false,
    doc: docInfo(stmt, sf),
    error: errors.claim(line, endLine),
    children,
  };
}

function countExports(entries: DeclEntry[]): number {
  return entries.filter((e) => e.exported).length;
}
