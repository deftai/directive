import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const CODE_STRUCTURE_VERSION = "0.1";
export const DIRECTIVE_HOME = "x-directive/architecture.codeStructure";
export const PLAN_HOME = "plan.architecture.codeStructure";
export const PROJECT_DEFINITION_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";

const GENERATED_PROJECTION_MARKERS = ["generated", "do not edit", "source of truth"] as const;

const DERIVED_FACT_KEYS = new Set([
  "callgraph",
  "classes",
  "coupling",
  "dependencies",
  "dependencygraph",
  "entrypoints",
  "exports",
  "filecount",
  "files",
  "functions",
  "imports",
  "language",
  "languages",
  "loc",
  "symbols",
]);

export interface CsFinding {
  readonly code: string;
  readonly message: string;
  readonly location: string;
}

export interface ValidationResult {
  readonly errors: CsFinding[];
  readonly warnings: CsFinding[];
  readonly ok: boolean;
}

export interface ExtractedCodeStructure {
  readonly record: Record<string, unknown>;
  readonly home: string;
}

function finding(code: string, message: string, location: string): CsFinding {
  return { code, message, location };
}

/** Linear stable-id check mirroring `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. */
export function isStableId(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  let i = 0;
  const c0 = value.charCodeAt(i);
  if (c0 < 97 || c0 > 122) {
    return false;
  }
  i += 1;
  while (i < value.length) {
    const c = value.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      i += 1;
      continue;
    }
    break;
  }
  while (i < value.length) {
    if (value.charAt(i) !== "-") {
      return false;
    }
    i += 1;
    if (i >= value.length) {
      return false;
    }
    let seg = 0;
    while (i < value.length) {
      const c = value.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        i += 1;
        seg += 1;
        continue;
      }
      break;
    }
    if (seg === 0) {
      return false;
    }
  }
  return true;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeRelativePath(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  if (!text || text.includes("\\") || text.startsWith("~") || text.startsWith("$")) {
    return false;
  }
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
    return false;
  }
  const parts = text.split("/");
  return !parts.includes("..");
}

function normalKey(value: string): string {
  let out = "";
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    const c = lower.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += lower.charAt(i);
    }
  }
  return out;
}

function projectRelative(path: string, projectRoot: string): string {
  try {
    const rel = resolve(path).slice(resolve(projectRoot).length + 1);
    return rel.replace(/\\/g, "/");
  } catch {
    return path;
  }
}

export function extractCodeStructureHomes(data: Record<string, unknown>): ExtractedCodeStructure[] {
  const homes: ExtractedCodeStructure[] = [];
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null) {
    const architecture = (plan as Record<string, unknown>).architecture;
    if (typeof architecture === "object" && architecture !== null) {
      const record = (architecture as Record<string, unknown>).codeStructure;
      if (typeof record === "object" && record !== null) {
        homes.push({ record: record as Record<string, unknown>, home: PLAN_HOME });
      }
    }
  }
  const extension = data["x-directive/architecture"];
  if (typeof extension === "object" && extension !== null) {
    const record = (extension as Record<string, unknown>).codeStructure;
    if (typeof record === "object" && record !== null) {
      homes.push({ record: record as Record<string, unknown>, home: DIRECTIVE_HOME });
    }
  }
  return homes;
}

export function extractCodeStructure(data: Record<string, unknown>): ExtractedCodeStructure | null {
  const homes = extractCodeStructureHomes(data);
  return homes[0] ?? null;
}

function scanForDerivedFactKeys(value: unknown, errors: CsFinding[], location: string): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const keyLocation = location ? `${location}.${key}` : key;
      if (DERIVED_FACT_KEYS.has(normalKey(key))) {
        errors.push(
          finding(
            "CS-DERIVED-FACT",
            `codeStructure must not author derived fact key '${key}'`,
            keyLocation,
          ),
        );
      }
      scanForDerivedFactKeys(nested, errors, keyLocation);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scanForDerivedFactKeys(value[index], errors, `${location}[${index}]`);
    }
  }
}

function validateRequiredArrays(
  record: Record<string, unknown>,
  errors: CsFinding[],
  source: string,
): void {
  if (record.version !== CODE_STRUCTURE_VERSION) {
    errors.push(
      finding("CS-VERSION", `codeStructure.version must be '${CODE_STRUCTURE_VERSION}'`, source),
    );
  }
  for (const key of ["modules", "pathOwnership", "allowedPatterns", "projectionManifest"]) {
    if (!Array.isArray(record[key])) {
      errors.push(finding("CS-SHAPE", `codeStructure.${key} must be an array`, source));
    }
  }
  const modules = record.modules;
  if (Array.isArray(modules) && modules.length === 0) {
    errors.push(
      finding("CS-MODULES", "codeStructure.modules must contain at least one module", source),
    );
  }
}

function validateModule(
  module: unknown,
  index: number,
  errors: CsFinding[],
  globOwner: Map<string, string>,
): string | null {
  const location = `modules[${index}]`;
  if (typeof module !== "object" || module === null) {
    errors.push(finding("CS-MODULE", "module entry must be an object", location));
    return null;
  }
  const rec = module as Record<string, unknown>;
  const moduleId = rec.id;
  if (!isStableId(moduleId)) {
    errors.push(
      finding(
        "CS-MODULE-ID",
        "module id must be a stable lowercase kebab-case id",
        `${location}.id`,
      ),
    );
    return null;
  }
  const id = String(moduleId);
  for (const key of ["name", "purpose"]) {
    if (!nonEmptyString(rec[key])) {
      errors.push(finding("CS-MODULE", `module '${id}' needs non-empty ${key}`, location));
    }
  }
  const globs = rec.pathGlobs;
  if (!Array.isArray(globs) || globs.length === 0) {
    errors.push(
      finding("CS-GLOB", `module '${id}' needs at least one pathGlob`, `${location}.pathGlobs`),
    );
    return id;
  }
  for (let globIndex = 0; globIndex < globs.length; globIndex += 1) {
    const globValue = globs[globIndex];
    const globLocation = `${location}.pathGlobs[${globIndex}]`;
    if (!safeRelativePath(globValue)) {
      errors.push(
        finding("CS-GLOB", `module '${id}' pathGlob must be repository-relative`, globLocation),
      );
      continue;
    }
    const gv = String(globValue);
    const prior = globOwner.get(gv);
    if (prior !== undefined && prior !== id) {
      errors.push(
        finding(
          "CS-GLOB-CONFLICT",
          `pathGlob '${gv}' is assigned to both '${prior}' and '${id}'`,
          globLocation,
        ),
      );
    } else {
      globOwner.set(gv, id);
    }
  }
  return id;
}

function validateModuleRef(
  moduleId: unknown,
  moduleIds: Set<string>,
  location: string,
  errors: CsFinding[],
): void {
  if (typeof moduleId !== "string" || !moduleIds.has(moduleId)) {
    errors.push(
      finding(
        "CS-MODULE-REF",
        `module reference '${String(moduleId)}' does not match a declared module id`,
        location,
      ),
    );
  }
}

function validatePathOwnership(
  entries: unknown[],
  moduleIds: Set<string>,
  errors: CsFinding[],
): void {
  const ownership = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const location = `pathOwnership[${index}]`;
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      errors.push(finding("CS-OWNERSHIP", "pathOwnership entry must be an object", location));
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const globValue = rec.pathGlob;
    if (!safeRelativePath(globValue)) {
      errors.push(
        finding("CS-GLOB", "pathOwnership.pathGlob must be repository-relative", location),
      );
    }
    const moduleId = rec.module;
    validateModuleRef(moduleId, moduleIds, `${location}.module`, errors);
    if (typeof globValue === "string" && typeof moduleId === "string") {
      const prior = ownership.get(globValue);
      if (prior !== undefined && prior !== moduleId) {
        errors.push(
          finding(
            "CS-OWNERSHIP-CONFLICT",
            `pathOwnership '${globValue}' points at both '${prior}' and '${moduleId}'`,
            location,
          ),
        );
      } else {
        ownership.set(globValue, moduleId);
      }
    }
  }
}

function validateAllowedPatterns(
  entries: unknown[],
  moduleIds: Set<string>,
  errors: CsFinding[],
): void {
  const seenIds = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const location = `allowedPatterns[${index}]`;
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      errors.push(finding("CS-PATTERN", "allowedPatterns entry must be an object", location));
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const patternId = rec.id;
    if (!isStableId(patternId)) {
      errors.push(
        finding("CS-PATTERN-ID", "allowed pattern id must be stable kebab-case", location),
      );
    } else {
      const pid = String(patternId);
      if (seenIds.has(pid)) {
        errors.push(finding("CS-PATTERN-ID", `duplicate allowed pattern id '${pid}'`, location));
      } else {
        seenIds.add(pid);
      }
    }
    validateModuleRef(rec.module, moduleIds, `${location}.module`, errors);
    for (const key of ["name", "description"]) {
      if (!nonEmptyString(rec[key])) {
        errors.push(finding("CS-PATTERN", `allowed pattern needs ${key}`, location));
      }
    }
    const appliesTo = rec.appliesTo;
    if (appliesTo === undefined || appliesTo === null) {
      continue;
    }
    if (!Array.isArray(appliesTo)) {
      errors.push(finding("CS-PATTERN", "allowed pattern appliesTo must be an array", location));
      continue;
    }
    for (let pathIndex = 0; pathIndex < appliesTo.length; pathIndex += 1) {
      if (!safeRelativePath(appliesTo[pathIndex])) {
        errors.push(
          finding(
            "CS-PATH",
            "allowed pattern appliesTo path must be repository-relative",
            `${location}.appliesTo[${pathIndex}]`,
          ),
        );
      }
    }
  }
}

function projectionHasGeneratedBanner(path: string): boolean {
  try {
    const text = readFileSync(path, { encoding: "utf8" }).slice(0, 2048).toLowerCase();
    return GENERATED_PROJECTION_MARKERS.every((marker) => text.includes(marker));
  } catch {
    return false;
  }
}

function validateProjectionManifest(
  entries: unknown[],
  errors: CsFinding[],
  projectRoot: string | null,
): void {
  const seenPaths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const location = `projectionManifest[${index}]`;
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      errors.push(finding("CS-PROJECTION", "projectionManifest entry must be an object", location));
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const pathValue = rec.path;
    if (!safeRelativePath(pathValue)) {
      errors.push(finding("CS-PATH", "projection path must be repository-relative", location));
    } else {
      const pv = String(pathValue);
      if (seenPaths.has(pv)) {
        errors.push(finding("CS-PROJECTION", `duplicate projection path '${pv}'`, location));
      } else {
        seenPaths.add(pv);
      }
    }
    if (!isStableId(rec.kind)) {
      errors.push(finding("CS-PROJECTION", "projection kind must be stable kebab-case", location));
    }
    if (!nonEmptyString(rec.source)) {
      errors.push(finding("CS-PROJECTION", "projection source must be non-empty", location));
    } else if (rec.source !== PLAN_HOME && rec.source !== DIRECTIVE_HOME) {
      errors.push(
        finding(
          "CS-PROJECTION-SOURCE",
          `projection source must be '${PLAN_HOME}' or '${DIRECTIVE_HOME}'`,
          `${location}.source`,
        ),
      );
    }
    if (typeof rec.generated !== "boolean") {
      errors.push(finding("CS-PROJECTION", "projection generated must be boolean", location));
    } else if (rec.generated !== true) {
      errors.push(
        finding(
          "CS-PROJECTION",
          "projectionManifest entries must declare generated=true",
          location,
        ),
      );
    }
    for (const commandKey of ["task", "freshnessTask"]) {
      if (commandKey in rec) {
        errors.push(
          finding(
            "CS-PROJECTION-COMMAND",
            `projectionManifest must not store runner-specific ${commandKey}`,
            `${location}.${commandKey}`,
          ),
        );
      }
    }
    if (projectRoot !== null && typeof pathValue === "string" && safeRelativePath(pathValue)) {
      const projectionPath = join(projectRoot, pathValue);
      if (existsSync(projectionPath) && !projectionHasGeneratedBanner(projectionPath)) {
        errors.push(
          finding(
            "CS-PROJECTION-BANNER",
            "existing projection path must carry a generated banner and source pointer",
            `${location}.path`,
          ),
        );
      }
    }
  }
}

function validateFilePurposeOverrides(
  entries: unknown,
  moduleIds: Set<string>,
  errors: CsFinding[],
): void {
  if (entries === undefined || entries === null) {
    return;
  }
  if (!Array.isArray(entries)) {
    errors.push(
      finding("CS-FILE-OVERRIDE", "filePurposeOverrides must be an array", "filePurposeOverrides"),
    );
    return;
  }
  const seenPaths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const location = `filePurposeOverrides[${index}]`;
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      errors.push(finding("CS-FILE-OVERRIDE", "file override must be an object", location));
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const pathValue = rec.path;
    if (!safeRelativePath(pathValue)) {
      errors.push(finding("CS-PATH", "file override path must be repository-relative", location));
    } else {
      const pv = String(pathValue);
      if (seenPaths.has(pv)) {
        errors.push(finding("CS-FILE-OVERRIDE", `duplicate override path '${pv}'`, location));
      } else {
        seenPaths.add(pv);
      }
    }
    if (!nonEmptyString(rec.purpose)) {
      errors.push(finding("CS-FILE-OVERRIDE", "file override needs purpose", location));
    }
    if ("module" in rec) {
      validateModuleRef(rec.module, moduleIds, `${location}.module`, errors);
    }
  }
}

function validateGlossaryRefs(
  entries: unknown,
  errors: CsFinding[],
  projectRoot: string | null,
): void {
  if (entries === undefined || entries === null) {
    return;
  }
  if (!Array.isArray(entries)) {
    errors.push(finding("CS-GLOSSARY", "glossaryRefs must be an array", "glossaryRefs"));
    return;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const location = `glossaryRefs[${index}]`;
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      errors.push(finding("CS-GLOSSARY", "glossary ref must be an object", location));
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (!nonEmptyString(rec.term)) {
      errors.push(finding("CS-GLOSSARY", "glossary ref needs term", location));
    }
    const uri = rec.uri;
    if ("uri" in rec && !safeRelativePath(uri)) {
      errors.push(finding("CS-PATH", "glossary ref uri must be repository-relative", location));
    } else if (projectRoot !== null && typeof uri === "string") {
      const target = join(projectRoot, uri);
      if (!existsSync(target)) {
        errors.push(
          finding(
            "CS-GLOSSARY-URI",
            `glossary ref uri does not exist: '${uri}'`,
            `${location}.uri`,
          ),
        );
      }
    }
  }
}

function hasGlobMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

function validateBoundedness(record: Record<string, unknown>, warnings: CsFinding[]): void {
  const modules = asList(record.modules);
  const overrides = asList(record.filePurposeOverrides);
  if (overrides.length > 0 && overrides.length > Math.max(10, modules.length * 2)) {
    warnings.push(
      finding(
        "CS-BOUNDEDNESS",
        "filePurposeOverrides should stay bounded to human overrides, not become a per-file registry",
        "filePurposeOverrides",
      ),
    );
  }
  const ownership = asList(record.pathOwnership);
  if (ownership.length > 0 && ownership.length > Math.max(12, modules.length * 3)) {
    warnings.push(
      finding(
        "CS-BOUNDEDNESS",
        "pathOwnership is large relative to module count; prefer module globs where possible",
        "pathOwnership",
      ),
    );
  }
  for (let index = 0; index < modules.length; index += 1) {
    const module = modules[index];
    if (typeof module !== "object" || module === null) {
      continue;
    }
    const globs = (module as Record<string, unknown>).pathGlobs;
    if (!Array.isArray(globs) || globs.length !== 1 || typeof globs[0] !== "string") {
      continue;
    }
    const globValue = String(globs[0]);
    if (!hasGlobMagic(globValue)) {
      warnings.push(
        finding(
          "CS-SINGLE-FILE-MODULE",
          "module has a single non-glob path; ensure this is intentional and not per-file metadata",
          `modules[${index}].pathGlobs[0]`,
        ),
      );
    }
  }
}

export function validateCodeStructure(
  record: Record<string, unknown>,
  source = "<memory>",
  projectRoot: string | null = null,
): ValidationResult {
  const errors: CsFinding[] = [];
  const warnings: CsFinding[] = [];
  validateRequiredArrays(record, errors, source);
  scanForDerivedFactKeys(record, errors, "codeStructure");

  const globOwner = new Map<string, string>();
  const moduleIds = new Set<string>();
  for (let index = 0; index < asList(record.modules).length; index += 1) {
    const moduleId = validateModule(asList(record.modules)[index], index, errors, globOwner);
    if (moduleId === null) {
      continue;
    }
    if (moduleIds.has(moduleId)) {
      errors.push(
        finding("CS-MODULE-ID", `duplicate module id '${moduleId}'`, `modules[${index}].id`),
      );
    }
    moduleIds.add(moduleId);
  }

  validatePathOwnership(asList(record.pathOwnership), moduleIds, errors);
  validateAllowedPatterns(asList(record.allowedPatterns), moduleIds, errors);
  validateProjectionManifest(asList(record.projectionManifest), errors, projectRoot);
  validateFilePurposeOverrides(record.filePurposeOverrides, moduleIds, errors);
  validateGlossaryRefs(record.glossaryRefs, errors, projectRoot);
  validateBoundedness(record, warnings);
  return { errors, warnings, ok: errors.length === 0 };
}

export function loadJsonFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, { encoding: "utf8" });
  } catch {
    throw new Error(`codeStructure file not found: ${path}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${msg}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${path} top-level value must be an object`);
  }
  return data as Record<string, unknown>;
}

export function validateFile(
  path: string,
  options: { projectRoot?: string | null; allowStandalone?: boolean } = {},
): ValidationResult {
  const projectRoot = options.projectRoot ?? null;
  const allowStandalone = options.allowStandalone ?? true;
  const data = loadJsonFile(path);
  const homes = extractCodeStructureHomes(data);
  const errors: CsFinding[] = [];
  if (homes.length > 1) {
    errors.push(
      finding(
        "CS-HOME-CONFLICT",
        `only one codeStructure home is allowed; found ${homes.map((h) => h.home).join(", ")}`,
        path,
      ),
    );
  }
  if (projectRoot !== null && !allowStandalone) {
    const relPath = projectRelative(path, projectRoot);
    if (relPath !== PROJECT_DEFINITION_PATH && homes.length > 0) {
      errors.push(
        finding(
          "CS-HOME",
          "canonical codeStructure metadata must live in vbrief/PROJECT-DEFINITION.vbrief.json; sibling files must be generated projections",
          path,
        ),
      );
    }
  }
  if (homes.length === 0) {
    return {
      errors: [
        finding("CS-MISSING", `no ${PLAN_HOME} or ${DIRECTIVE_HOME} record found`, path),
        ...errors,
      ],
      warnings: [],
      ok: false,
    };
  }
  const extracted = homes[0];
  if (extracted === undefined) {
    return {
      errors: [
        finding("CS-MISSING", `no ${PLAN_HOME} or ${DIRECTIVE_HOME} record found`, path),
        ...errors,
      ],
      warnings: [],
      ok: false,
    };
  }
  const result = validateCodeStructure(extracted.record, `${path}:${extracted.home}`, projectRoot);
  return {
    errors: [...errors, ...result.errors],
    warnings: result.warnings,
    ok: errors.length === 0 && result.ok,
  };
}

export function discoverCodeStructurePaths(projectRoot: string): string[] {
  const paths = new Map<string, string>();
  const projectDef = join(projectRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (existsSync(projectDef)) {
    try {
      const data = loadJsonFile(projectDef);
      if (extractCodeStructure(data) !== null) {
        paths.set(projectDef.replace(/\\/g, "/"), projectDef);
      }
    } catch {
      paths.set(projectDef.replace(/\\/g, "/"), projectDef);
    }
  }
  const vbriefRoot = join(projectRoot, "vbrief");
  if (existsSync(vbriefRoot)) {
    const stack = [vbriefRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        continue;
      }
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          stack.push(full);
          continue;
        }
        if (!name.endsWith(".vbrief.json") || full === projectDef) {
          continue;
        }
        try {
          const data = loadJsonFile(full);
          if (extractCodeStructure(data) !== null) {
            paths.set(full.replace(/\\/g, "/"), full);
          }
        } catch {
          // skip
        }
      }
    }
  }
  return [...paths.keys()].sort();
}

export interface CodeStructureSummary {
  readonly path: string;
  readonly ok: boolean;
  readonly errors: CsFinding[];
  readonly warnings: CsFinding[];
}

function resultToDict(path: string, result: ValidationResult): CodeStructureSummary {
  return { path, ok: result.ok, errors: result.errors, warnings: result.warnings };
}

function configErrorToDict(path: string, error: string): CodeStructureSummary {
  return {
    path,
    ok: false,
    errors: [{ code: "CS-CONFIG", message: error, location: path }],
    warnings: [],
  };
}

export interface CodeStructureEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly summaries: readonly CodeStructureSummary[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodeStructureEvaluateOptions {
  readonly paths?: readonly string[];
  readonly json?: boolean;
  readonly strict?: boolean;
}

export function evaluateCodeStructure(
  projectRoot: string,
  options: CodeStructureEvaluateOptions = {},
): CodeStructureEvaluateResult {
  const root = resolve(projectRoot);
  const explicitPaths = options.paths !== undefined && options.paths.length > 0;
  const paths =
    explicitPaths && options.paths
      ? options.paths.map((p) => resolve(p))
      : discoverCodeStructurePaths(root);

  if (paths.length === 0) {
    if (options.json) {
      return {
        code: 0,
        summaries: [],
        stdout: `${JSON.stringify({ ok: true, validated: [] }, null, 2)}\n`,
        stderr: "",
      };
    }
    return {
      code: 0,
      summaries: [],
      stdout: "OK: no codeStructure metadata found\n",
      stderr: "",
    };
  }

  const summaries: CodeStructureSummary[] = [];
  let exitCode: 0 | 1 | 2 = 0;

  for (const path of paths) {
    try {
      const result = validateFile(path, {
        projectRoot: explicitPaths ? null : root,
        allowStandalone: explicitPaths,
      });
      summaries.push(resultToDict(path, result));
      if (exitCode === 0 && (!result.ok || (options.strict && result.warnings.length > 0))) {
        exitCode = 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summaries.push(configErrorToDict(path, msg));
      exitCode = 2;
    }
  }

  if (options.json) {
    const payload = {
      ok: exitCode === 0,
      validated: summaries.map((s) => ({
        path: s.path,
        ok: s.ok,
        errors: s.errors,
        warnings: s.warnings,
      })),
    };
    return {
      code: exitCode,
      summaries,
      stdout: `${JSON.stringify(payload, null, 2)}\n`,
      stderr: "",
    };
  }

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  for (const summary of summaries) {
    for (const f of summary.errors) {
      const prefix = f.code === "CS-CONFIG" ? "ERROR" : "FAIL";
      const line = `${prefix}: ${summary.path}: ${f.code}: ${f.location}: ${f.message}`;
      if (prefix === "ERROR") {
        stderrLines.push(line);
      } else {
        stdoutLines.push(line);
      }
    }
    for (const f of summary.warnings) {
      stdoutLines.push(`WARN: ${summary.path}: ${f.code}: ${f.location}: ${f.message}`);
    }
    if (summary.ok && !(options.strict && summary.warnings.length > 0)) {
      stdoutLines.push(`OK: ${summary.path}`);
    }
  }

  return {
    code: exitCode,
    summaries,
    stdout: stdoutLines.length > 0 ? `${stdoutLines.join("\n")}\n` : "",
    stderr: stderrLines.length > 0 ? `${stderrLines.join("\n")}\n` : "",
  };
}
