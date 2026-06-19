import { existsSync, globSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { extractCodeStructure, loadJsonFile } from "../verify-source/code-structure-validate.js";
import { sortedStringifyPretty } from "./json.js";
import {
  CODEBASE_MAP_FORMAT_VERSION,
  CODEBASE_MAP_KIND,
  CODEBASE_PROVIDER_CONTRACT_VERSION,
} from "./projection-registry.js";

export const DEFAULT_PROVIDER_NAME = "directive-default-extractor";
export const DEFAULT_PROVIDER_VERSION = "0.1";
export const MAX_IMPORT_SCAN_BYTES = 262_144;
export const MAX_FILES_PER_MODULE = 100;
export const MAX_EVIDENCE_PER_EDGE = 5;

export const SKIP_DIRS = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "swarm-worktrees",
]);

export const LANGUAGE_BY_SUFFIX: Readonly<Record<string, string>> = {
  ".go": "Go",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".py": "Python",
  ".sh": "Shell",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".yaml": "YAML",
  ".yml": "YAML",
};

export const ENTRYPOINT_NAMES = new Set([
  "__main__.py",
  "cli.py",
  "cmd.py",
  "index.js",
  "index.ts",
  "main.go",
  "main.py",
  "run",
  "run.py",
]);

export class CodeStructureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeStructureConfigError";
  }
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function relativeFile(path: string, projectRoot: string): string {
  return posixPath(relative(projectRoot, path));
}

/** Return the authored codeStructure source path used by the default extractor. */
export function defaultCodeStructurePath(projectRoot: string, codeStructurePath?: string): string {
  return codeStructurePath ?? join(projectRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json");
}

function stableId(value: string): string {
  let slug = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      slug += value.charAt(i).toLowerCase();
    } else if (slug.length > 0 && slug.charAt(slug.length - 1) !== "-") {
      slug += "-";
    }
  }
  while (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }
  return slug.length > 0 ? slug : "root";
}

function hasGlobMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

function repoFiles(projectRoot: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st: Stats | undefined;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) {
          walk(full);
        }
      } else if (st.isFile()) {
        files.push(full);
      }
    }
  }
  walk(projectRoot);
  return files.sort((a, b) =>
    relativeFile(a, projectRoot).localeCompare(relativeFile(b, projectRoot)),
  );
}

function globFiles(projectRoot: string, globs: string[]): string[] {
  const files = new Map<string, string>();
  for (const globValue of globs) {
    let matches: string[];
    try {
      matches = globSync(globValue, { cwd: projectRoot });
    } catch {
      continue;
    }
    for (const match of matches) {
      const full = join(projectRoot, match);
      let st: Stats | undefined;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) {
        continue;
      }
      const relParts = relativeFile(full, projectRoot).split("/");
      if (relParts.some((part) => SKIP_DIRS.has(part))) {
        continue;
      }
      files.set(relativeFile(full, projectRoot), full);
    }
  }
  return [...files.keys()].sort().map((key) => files.get(key) as string);
}

function loadAuthoredCodeStructure(
  projectRoot: string,
  codeStructurePath?: string,
): [{ record: Record<string, unknown>; home: string } | null, string | null] {
  const path = defaultCodeStructurePath(projectRoot, codeStructurePath);
  if (!existsSync(path)) {
    return [null, null];
  }
  let data: Record<string, unknown>;
  try {
    data = loadJsonFile(path);
  } catch (err) {
    throw new CodeStructureConfigError(String(err));
  }
  const extracted = extractCodeStructure(data);
  if (extracted === null) {
    return [null, null];
  }
  return [{ record: extracted.record, home: extracted.home }, extracted.home];
}

function modulePrefixes(
  module: Record<string, unknown>,
  files: string[],
  projectRoot: string,
): Set<string> {
  const prefixes = new Set<string>();
  const globs = module.pathGlobs;
  if (Array.isArray(globs)) {
    for (const globValue of globs) {
      if (typeof globValue !== "string") {
        continue;
      }
      const first = globValue.split("/", 1)[0] ?? "";
      if (first && !hasGlobMagic(first) && first !== "." && first !== "**") {
        prefixes.add(first.endsWith(".py") ? first.slice(0, -3) : first);
      }
    }
  }
  for (const filePath of files) {
    const relParts = relativeFile(filePath, projectRoot).split("/");
    if (relParts.length > 1) {
      prefixes.add(relParts[0] ?? "");
    } else if (filePath.endsWith(".py")) {
      const base = relativeFile(filePath, projectRoot).split("/").pop() ?? "";
      prefixes.add(base.endsWith(".py") ? base.slice(0, -3) : base);
    }
  }
  prefixes.delete("");
  return prefixes;
}

function curatedModules(
  projectRoot: string,
  codeStructure: Record<string, unknown>,
): [
  Record<string, unknown>[],
  Map<string, string>,
  Map<string, Set<string>>,
  Record<string, string>[],
] {
  const artifacts: Record<string, unknown>[] = [];
  const fileToModule = new Map<string, string>();
  const prefixesByModule = new Map<string, Set<string>>();
  const degraded: Record<string, string>[] = [];

  const modules = codeStructure.modules;
  if (!Array.isArray(modules)) {
    return [artifacts, fileToModule, prefixesByModule, degraded];
  }

  for (const rawModule of modules) {
    if (typeof rawModule !== "object" || rawModule === null || Array.isArray(rawModule)) {
      continue;
    }
    const mod = rawModule as Record<string, unknown>;
    const moduleId = String(mod.id ?? "unknown");
    const globs = Array.isArray(mod.pathGlobs)
      ? mod.pathGlobs.filter((v): v is string => typeof v === "string")
      : [];
    const files = globFiles(projectRoot, globs);
    const relFiles = files.map((p) => relativeFile(p, projectRoot));
    for (const relPath of relFiles) {
      if (!fileToModule.has(relPath)) {
        fileToModule.set(relPath, moduleId);
      }
    }
    if (relFiles.length > MAX_FILES_PER_MODULE) {
      degraded.push({
        code: "MODULE-FILES-TRUNCATED",
        module: moduleId,
        message: `Module file list was truncated to ${MAX_FILES_PER_MODULE} deterministic entries.`,
      });
    }
    artifacts.push({
      id: moduleId,
      name: mod.name,
      purpose: mod.purpose,
      pathGlobs: globs,
      fileCount: relFiles.length,
      files: relFiles.slice(0, MAX_FILES_PER_MODULE),
      derivedFrom: {
        intent: "codeStructure.modules[]",
        files: "repository-glob-walk",
      },
    });
    prefixesByModule.set(moduleId, modulePrefixes(mod, files, projectRoot));
  }
  return [artifacts, fileToModule, prefixesByModule, degraded];
}

function directoryModules(
  projectRoot: string,
): [
  Record<string, unknown>[],
  Map<string, string>,
  Map<string, Set<string>>,
  Record<string, string>[],
] {
  const grouped = new Map<string, string[]>();
  for (const filePath of repoFiles(projectRoot)) {
    const parts = relativeFile(filePath, projectRoot).split("/");
    if (parts.length === 0) {
      continue;
    }
    const top = parts.length > 1 ? (parts[0] ?? "root-files") : "root-files";
    const list = grouped.get(top) ?? [];
    list.push(filePath);
    grouped.set(top, list);
  }

  const modules: Record<string, unknown>[] = [];
  const fileToModule = new Map<string, string>();
  const prefixesByModule = new Map<string, Set<string>>();
  const degradedMarkers: Record<string, string>[] = [
    {
      code: "NO-CODESTRUCTURE",
      message:
        "No authored codeStructure metadata was found; modules were derived from " +
        "top-level repository paths.",
    },
  ];

  for (const top of [...grouped.keys()].sort()) {
    const moduleId = stableId(top);
    const paths = (grouped.get(top) ?? []).sort((a, b) =>
      relativeFile(a, projectRoot).localeCompare(relativeFile(b, projectRoot)),
    );
    const relFiles = paths.map((p) => relativeFile(p, projectRoot));
    for (const relPath of relFiles) {
      if (!fileToModule.has(relPath)) {
        fileToModule.set(relPath, moduleId);
      }
    }
    if (relFiles.length > MAX_FILES_PER_MODULE) {
      degradedMarkers.push({
        code: "MODULE-FILES-TRUNCATED",
        module: moduleId,
        message: `Module file list was truncated to ${MAX_FILES_PER_MODULE} deterministic entries.`,
      });
    }
    modules.push({
      id: moduleId,
      name: top,
      purpose: null,
      pathGlobs: [top !== "root-files" ? `${top}/**/*` : "*"],
      fileCount: relFiles.length,
      files: relFiles.slice(0, MAX_FILES_PER_MODULE),
      derivedFrom: {
        intent: "directory-derived-fallback",
        files: "repository-tree-walk",
      },
    });
    prefixesByModule.set(moduleId, top !== "root-files" ? new Set([top]) : new Set());
  }

  return [modules, fileToModule, prefixesByModule, degradedMarkers];
}

function matchPyImport(line: string): string | null {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
    i += 1;
  }
  if (line.slice(i, i + 6) === "import" && (i + 6 >= line.length || line.charCodeAt(i + 6) <= 32)) {
    i += 6;
    while (i < line.length && line.charCodeAt(i) <= 32) {
      i += 1;
    }
    let name = "";
    const c0 = line.charCodeAt(i);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) {
      return null;
    }
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 95 ||
        c === 46
      ) {
        name += line.charAt(i);
        i += 1;
      } else {
        break;
      }
    }
    return name.length > 0 ? name : null;
  }
  return null;
}

function matchPyFromImport(line: string): string | null {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
    i += 1;
  }
  if (line.slice(i, i + 4) !== "from") {
    return null;
  }
  i += 4;
  while (i < line.length && line.charCodeAt(i) <= 32) {
    i += 1;
  }
  let name = "";
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 46
    ) {
      name += line.charAt(i);
      i += 1;
    } else {
      break;
    }
  }
  while (i < line.length && line.charCodeAt(i) <= 32) {
    i += 1;
  }
  if (line.slice(i, i + 6) !== "import") {
    return null;
  }
  return name.length > 0 ? name : null;
}

function extractQuotedImport(line: string, prefix: string): string | null {
  const idx = line.indexOf(prefix);
  if (idx < 0) {
    return null;
  }
  const q1 = line.indexOf('"', idx);
  const q2 = line.indexOf("'", idx);
  let q = -1;
  let quote = '"';
  if (q1 >= 0 && (q2 < 0 || q1 < q2)) {
    q = q1;
    quote = '"';
  } else if (q2 >= 0) {
    q = q2;
    quote = "'";
  }
  if (q < 0) {
    return null;
  }
  const end = line.indexOf(quote, q + 1);
  if (end < 0) {
    return null;
  }
  return line.slice(q + 1, end);
}

function readImports(path: string): [number, string][] {
  const ext = path.slice(path.lastIndexOf("."));
  if (![".go", ".js", ".jsx", ".py", ".ts", ".tsx"].includes(ext)) {
    return [];
  }
  let st: Stats | undefined;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (st.size > MAX_IMPORT_SCAN_BYTES) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, { encoding: "utf8" });
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const imports: [number, string][] = [];
  let inGoImportBlock = false;

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    const stripped = line.trim();

    if (ext === ".go") {
      if (stripped === "import (") {
        inGoImportBlock = true;
        continue;
      }
      if (inGoImportBlock && stripped === ")") {
        inGoImportBlock = false;
        continue;
      }
      if (inGoImportBlock) {
        const q = stripped.indexOf('"');
        if (q >= 0) {
          const end = stripped.indexOf('"', q + 1);
          if (end > q) {
            imports.push([lineNumber, stripped.slice(q + 1, end)]);
          }
        }
        continue;
      }
      const goMatch = stripped.match(/^\s*import\s+"([^"]+)"/);
      if (goMatch?.[1] !== undefined) {
        imports.push([lineNumber, goMatch[1]]);
      }
      continue;
    }

    const pyImport = matchPyImport(line);
    if (pyImport !== null) {
      imports.push([lineNumber, pyImport]);
      continue;
    }
    const pyFrom = matchPyFromImport(line);
    if (pyFrom !== null) {
      imports.push([lineNumber, pyFrom]);
      continue;
    }
    const esFrom = extractQuotedImport(line, "from");
    if (esFrom !== null && line.includes("import")) {
      imports.push([lineNumber, esFrom]);
      continue;
    }
    const requireVal = extractQuotedImport(line, "require(");
    if (requireVal !== null) {
      imports.push([lineNumber, requireVal]);
      continue;
    }
    const bareImport = extractQuotedImport(line, "import");
    if (bareImport !== null) {
      imports.push([lineNumber, bareImport]);
    }
  }
  return imports;
}

function importTargets(ref: string, prefixesByModule: Map<string, Set<string>>): Set<string> {
  if (ref.startsWith(".")) {
    return new Set();
  }
  const normalized = ref.startsWith("@") ? ref.slice(1) : ref;
  let firstSegment = normalized;
  const slashIdx = normalized.search(/[/.]/);
  if (slashIdx >= 0) {
    firstSegment = normalized.slice(0, slashIdx);
  }
  const targets = new Set<string>();
  for (const [moduleId, prefixes] of prefixesByModule) {
    if (prefixes.has(firstSegment) || prefixes.has(ref)) {
      targets.add(moduleId);
    }
  }
  return targets;
}

function couplingEdges(
  projectRoot: string,
  fileToModule: Map<string, string>,
  prefixesByModule: Map<string, Set<string>>,
): Record<string, unknown>[] {
  const edges = new Map<string, Record<string, unknown>[]>();
  const sortedFiles = [...fileToModule.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [relPath, sourceModule] of sortedFiles) {
    const path = join(projectRoot, relPath);
    for (const [lineNumber, importRef] of readImports(path)) {
      for (const targetModule of importTargets(importRef, prefixesByModule)) {
        if (targetModule === sourceModule) {
          continue;
        }
        const key = `${sourceModule}\0${targetModule}`;
        let evidence = edges.get(key);
        if (evidence === undefined) {
          evidence = [];
          edges.set(key, evidence);
        }
        if (evidence.length < MAX_EVIDENCE_PER_EDGE) {
          evidence.push({ path: relPath, line: lineNumber, import: importRef });
        }
      }
    }
  }

  const out: Record<string, unknown>[] = [];
  for (const key of [...edges.keys()].sort()) {
    const [source, target] = key.split("\0");
    out.push({
      from: source,
      to: target,
      derivedFrom: "import-line-heuristic",
      confidence: "heuristic",
      evidence: edges.get(key),
    });
  }
  return out;
}

function entryPoints(fileToModule: Map<string, string>): Record<string, string>[] {
  const entries: Record<string, string>[] = [];
  for (const [relPath, moduleId] of [...fileToModule.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const parts = relPath.split("/");
    const name = parts[parts.length - 1] ?? relPath;
    if (ENTRYPOINT_NAMES.has(name) || parts[0] === "cmd") {
      entries.push({
        path: relPath,
        module: moduleId,
        derivedFrom: "filename-heuristic",
        confidence: "heuristic",
      });
    }
  }
  return entries;
}

function languageDistribution(fileToModule: Map<string, string>): Record<string, unknown>[] {
  const counts = new Map<string, number>();
  for (const relPath of fileToModule.keys()) {
    const dot = relPath.lastIndexOf(".");
    const suffix = dot >= 0 ? relPath.slice(dot) : "";
    const language = LANGUAGE_BY_SUFFIX[suffix] ?? "Other";
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([language, files]) => ({
      language,
      files,
      derivedFrom: "extension-heuristic",
    }));
}

/** Build a deterministic tier-1 codebase-map artifact. */
export function buildCodebaseMap(
  projectRoot: string,
  options: { codeStructurePath?: string; fallbackReason?: string | null } = {},
): Record<string, unknown> {
  const root = resolve(projectRoot);
  const [codeStructure] = loadAuthoredCodeStructure(root, options.codeStructurePath);
  const sourcePath = defaultCodeStructurePath(root, options.codeStructurePath);

  let modules: Record<string, unknown>[];
  let fileToModule: Map<string, string>;
  let prefixesByModule: Map<string, Set<string>>;
  let degraded: Record<string, string>[];

  if (codeStructure !== null) {
    [modules, fileToModule, prefixesByModule, degraded] = curatedModules(
      root,
      codeStructure.record,
    );
  } else {
    [modules, fileToModule, prefixesByModule, degraded] = directoryModules(root);
  }

  degraded = [
    ...degraded,
    {
      code: "AST-FREE-HEURISTICS",
      message:
        "Default extractor uses repository walking and import-line heuristics only; " +
        "no AST or language parser provider was configured.",
    },
  ];
  if (options.fallbackReason) {
    degraded.push({ code: "PROVIDER-FALLBACK", message: options.fallbackReason });
  }

  const provider: Record<string, unknown> = {
    name: DEFAULT_PROVIDER_NAME,
    version: DEFAULT_PROVIDER_VERSION,
    mode: "default",
    degraded: true,
  };
  if (options.fallbackReason) {
    provider.fallbackReason = options.fallbackReason;
  }

  return {
    formatVersion: CODEBASE_MAP_FORMAT_VERSION,
    contractVersion: CODEBASE_PROVIDER_CONTRACT_VERSION,
    kind: CODEBASE_MAP_KIND,
    provider,
    source: {
      projectRoot: root,
      codeStructurePath: sourcePath,
      codeStructureHome: codeStructure?.home ?? null,
    },
    modules,
    coupling: couplingEdges(root, fileToModule, prefixesByModule),
    entryPoints: entryPoints(fileToModule),
    languageDistribution: languageDistribution(fileToModule),
    degraded,
  };
}

export function configErrorToDict(
  path: string,
  error: CodeStructureConfigError | Error,
): Record<string, unknown> {
  return {
    path,
    ok: false,
    errors: [{ code: "CS-CONFIG", message: String(error), location: path }],
    warnings: [],
  };
}

export interface DefaultExtractorCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI entry point. */
export function runDefaultExtractorCli(argv: string[]): DefaultExtractorCliResult {
  let projectRoot = ".";
  let codeStructurePath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { exitCode: 2, stdout: "", stderr: "argument --path: expected one argument\n" };
      }
      codeStructurePath = value;
      i += 1;
    } else if (arg?.startsWith("--path=")) {
      codeStructurePath = arg.slice("--path=".length);
    }
  }

  const root = resolve(projectRoot);
  try {
    const artifact = buildCodebaseMap(root, { codeStructurePath });
    return {
      exitCode: 0,
      stdout: sortedStringifyPretty(artifact),
      stderr: "",
    };
  } catch (err) {
    if (err instanceof CodeStructureConfigError || err instanceof Error) {
      const path = defaultCodeStructurePath(root, codeStructurePath);
      return {
        exitCode: 2,
        stdout: "",
        stderr: sortedStringifyPretty(configErrorToDict(path, err)),
      };
    }
    throw err;
  }
}
