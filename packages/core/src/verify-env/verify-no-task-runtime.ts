import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

const SUBPROCESS_FUNCS = new Set(["run", "check_call", "check_output", "Popen", "call"]);

interface ImportAlias {
  readonly module: string | null;
  readonly name: string;
  readonly asname: string | null;
}

interface CallSite {
  readonly line: number;
  readonly func: string;
  readonly firstArg: string | null;
}

function splitDotted(name: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < name.length; i += 1) {
    const ch = name.charCodeAt(i);
    if (ch === 46) {
      if (current.length > 0) parts.push(current);
      current = "";
    } else {
      current += name[i];
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function isNameOrAttr(node: string, dotted: string): boolean {
  const parts = splitDotted(dotted);
  const nodeParts = splitDotted(node);
  if (nodeParts.length !== parts.length) return false;
  for (let i = 0; i < parts.length; i += 1) {
    if (nodeParts[i] !== parts[i]) return false;
  }
  return true;
}

function stripCommentsOnly(source: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;
  while (i < source.length) {
    const ch = source[i];
    const next3 = source.slice(i, i + 3);
    if (!inSingle && !inDouble && !inTripleSingle && !inTripleDouble && ch === "#") {
      while (i < source.length && source.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (!inDouble && !inTripleDouble && next3 === "'''" && !inSingle) {
      inTripleSingle = !inTripleSingle;
      out += next3;
      i += 3;
      continue;
    }
    if (!inSingle && !inTripleSingle && next3 === '"""' && !inDouble) {
      inTripleDouble = !inTripleDouble;
      out += next3;
      i += 3;
      continue;
    }
    if (!inDouble && !inTripleDouble && !inTripleSingle && ch === "'" && !inSingle) {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (inSingle && ch === "'" && !inTripleSingle) {
      inSingle = false;
      out += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inTripleSingle && !inTripleDouble && ch === '"' && !inDouble) {
      inDouble = true;
      out += ch;
      i += 1;
      continue;
    }
    if (inDouble && ch === '"' && !inTripleDouble) {
      inDouble = false;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractFirstStringArg(argsText: string): string | null {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const quote = first;
    let i = 1;
    while (i < trimmed.length) {
      if (trimmed[i] === "\\") {
        i += 2;
        continue;
      }
      if (trimmed[i] === quote) {
        return trimmed.slice(1, i);
      }
      i += 1;
    }
    return null;
  }
  if (first === "[" || first === "(") {
    const close = first === "[" ? "]" : ")";
    let depth = 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === first) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const inner = trimmed.slice(1, i).trim();
          if (inner.length === 0) return null;
          const head = inner.split(",")[0]?.trim() ?? "";
          return extractFirstStringArg(head);
        }
      }
    }
  }
  return null;
}

function findCallSites(source: string): CallSite[] {
  const cleaned = stripCommentsOnly(source);
  const lines = cleaned.split("\n");
  const sites: CallSite[] = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx] ?? "";
    let i = 0;
    while (i < line.length) {
      const paren = line.indexOf("(", i);
      if (paren < 0) break;
      let funcEnd = paren - 1;
      while (funcEnd >= 0) {
        const ch = line.charCodeAt(funcEnd);
        if (ch === 32 || ch === 9) {
          funcEnd -= 1;
          continue;
        }
        break;
      }
      let funcStart = funcEnd;
      while (funcStart >= 0) {
        const ch = line.charCodeAt(funcStart);
        if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 46) {
          funcStart -= 1;
          continue;
        }
        break;
      }
      const func = line.slice(funcStart + 1, funcEnd + 1).trim();
      let depth = 1;
      let j = paren + 1;
      let argsText = "";
      while (j < line.length && depth > 0) {
        const ch = line[j];
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (depth > 0) argsText += ch;
        j += 1;
      }
      if (depth === 0 && func.length > 0) {
        sites.push({
          line: lineIdx + 1,
          func,
          firstArg: extractFirstStringArg(argsText),
        });
      }
      i = j;
    }
  }
  return sites;
}

function parseImports(source: string): ImportAlias[] {
  const imports: ImportAlias[] = [];
  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("import ")) {
      const rest = trimmed.slice("import ".length).split("#")[0]?.trim() ?? "";
      for (const part of rest.split(",")) {
        const piece = part.trim();
        if (piece.length === 0) continue;
        const asIdx = piece.indexOf(" as ");
        if (asIdx >= 0) {
          imports.push({
            module: piece.slice(0, asIdx).trim(),
            name: piece.slice(0, asIdx).trim(),
            asname: piece.slice(asIdx + 4).trim(),
          });
        } else {
          imports.push({ module: piece, name: piece, asname: null });
        }
      }
    } else if (trimmed.startsWith("from ")) {
      const withoutComment = trimmed.split("#")[0]?.trim() ?? "";
      const fromPrefix = "from ";
      const importIdx = withoutComment.indexOf(" import ");
      if (importIdx < 0) continue;
      const module = withoutComment.slice(fromPrefix.length, importIdx).trim();
      const namesPart = withoutComment.slice(importIdx + " import ".length).trim();
      for (const part of namesPart.split(",")) {
        const piece = part.trim();
        if (piece.length === 0) continue;
        const asIdx = piece.indexOf(" as ");
        if (asIdx >= 0) {
          imports.push({
            module,
            name: piece.slice(0, asIdx).trim(),
            asname: piece.slice(asIdx + 4).trim(),
          });
        } else {
          imports.push({ module, name: piece, asname: null });
        }
      }
    }
  }
  return imports;
}

class Visitor {
  readonly subprocessNames = new Set<string>(["subprocess"]);
  readonly subprocessFuncNames = new Set<string>();
  readonly shutilNames = new Set<string>(["shutil"]);
  readonly shutilWhichNames = new Set<string>();
  readonly findings: Finding[] = [];

  constructor(private readonly filePath: string) {}

  loadImports(source: string): void {
    for (const imp of parseImports(source)) {
      if (imp.module === "subprocess" || imp.name === "subprocess") {
        this.subprocessNames.add(imp.asname ?? imp.name);
      }
      if (imp.module === "shutil" || imp.name === "shutil") {
        this.shutilNames.add(imp.asname ?? imp.name);
      }
      if (imp.module === "subprocess" && SUBPROCESS_FUNCS.has(imp.name)) {
        this.subprocessFuncNames.add(imp.asname ?? imp.name);
      }
      if (imp.module === "shutil" && imp.name === "which") {
        this.shutilWhichNames.add(imp.asname ?? imp.name);
      }
    }
  }

  visitCalls(sites: CallSite[]): void {
    for (const site of sites) {
      if (site.firstArg !== "task") continue;
      const func = site.func;
      const dot = func.lastIndexOf(".");
      if (dot >= 0) {
        const attr = func.slice(dot + 1);
        const value = func.slice(0, dot);
        if (this.subprocessNames.has(value) && SUBPROCESS_FUNCS.has(attr)) {
          this.findings.push({
            path: this.filePath,
            line: site.line,
            message: "runtime subprocess invocation of go-task is forbidden",
          });
        }
        if (attr === "which" && (isNameOrAttr(value, "shutil") || this.shutilNames.has(value))) {
          this.findings.push({
            path: this.filePath,
            line: site.line,
            message: "runtime go-task PATH probe is forbidden",
          });
        }
      } else if (this.subprocessFuncNames.has(func)) {
        this.findings.push({
          path: this.filePath,
          line: site.line,
          message: "runtime subprocess invocation of go-task is forbidden",
        });
      } else if (this.shutilWhichNames.has(func)) {
        this.findings.push({
          path: this.filePath,
          line: site.line,
          message: "runtime go-task PATH probe is forbidden",
        });
      }
    }
  }
}

function scanFile(path: string, root: string): Finding[] {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    return [{ path: relative(root, path), line: 1, message: String(err) }];
  }
  try {
    const visitor = new Visitor(path);
    visitor.loadImports(source);
    visitor.visitCalls(findCallSites(source));
    return visitor.findings.map((f) => ({
      ...f,
      path: relative(root, f.path),
    }));
  } catch (err) {
    return [{ path: relative(root, path), line: 1, message: String(err) }];
  }
}

export interface ScanOptions {
  readonly root?: string;
  readonly pythonFiles?: () => string[];
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export function defaultPythonFiles(root: string): string[] {
  const files: string[] = [];
  const runPath = join(root, "run");
  try {
    statSync(runPath);
    files.push(runPath);
  } catch {
    // skip
  }
  const scriptsDir = join(root, "scripts");
  try {
    const entries = readdirSync(scriptsDir).sort();
    for (const name of entries) {
      if (!name.endsWith(".py")) continue;
      if (name === "verify_no_task_runtime.py") continue;
      files.push(join(scriptsDir, name));
    }
  } catch {
    // skip
  }
  return files;
}

/** Scan runtime Python files for forbidden go-task dependencies. */
export function scan(options: ScanOptions = {}): Finding[] {
  const root = resolve(options.root ?? defaultRoot());
  const listFiles = options.pythonFiles ?? (() => defaultPythonFiles(root));
  const findings: Finding[] = [];
  for (const path of listFiles()) {
    findings.push(...scanFile(path, root));
  }
  return findings;
}

export interface ScanMainResult {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
}

/** Format scan results like scripts/verify_no_task_runtime.py::main. */
export function formatScanResult(findings: Finding[]): ScanMainResult {
  if (findings.length === 0) {
    return {
      exitCode: 0,
      stdout: "No runtime go-task subprocess dependencies found\n",
      stderr: "",
    };
  }
  const lines = ["Runtime go-task dependencies found:"];
  for (const finding of findings) {
    lines.push(`  ${finding.path}:${finding.line}: ${finding.message}`);
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${lines.join("\n")}\n`,
  };
}
