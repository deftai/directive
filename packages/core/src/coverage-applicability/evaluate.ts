/**
 * Shared fail-closed coverage applicability evaluator (#5421 Prefer-A Bound).
 * Classifies the complete reviewed change set bound to PrePrInputBinding fields.
 */

import * as childProcess from "node:child_process";
import { COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP } from "../pre-pr-controller/phases.js";

export type PathClassification = "coverable" | "inert" | "unknown";

export interface ClassifiedChange {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly classification: PathClassification;
}

export type CoverageApplicabilityResult =
  | {
      readonly outcome: "not-applicable";
      readonly reason: typeof COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP;
      readonly changes: readonly ClassifiedChange[];
    }
  | {
      readonly outcome: "applicable";
      readonly coverablePaths: readonly string[];
      readonly changes: readonly ClassifiedChange[];
    }
  | {
      readonly outcome: "refuse";
      readonly code: string;
      readonly reason: string;
      readonly changes: readonly ClassifiedChange[];
    };

export interface EvaluateCoverageApplicabilityInput {
  readonly projectRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  /** When false, skip HEAD-tree vs binding treeHash check (tests only). */
  readonly requireTreeMatch?: boolean;
}

export type GitRunResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly message: string };

export interface CoverageApplicabilityDeps {
  /** Returned-failure git runner — must not throw; map spawn failures to `{ ok: false }`. */
  readonly runGit?: (args: readonly string[], cwd: string) => GitRunResult;
  readonly classifyPath?: (
    path: string,
    status: string,
    oldPath: string | null,
  ) => PathClassification;
}

function defaultRunGit(args: readonly string[], cwd: string): GitRunResult {
  const result = childProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? result.error?.message ?? "git failed").trim();
    return {
      ok: false,
      message: `coverage-applicability: git ${args.join(" ")} failed: ${stderr}`,
    };
  }
  return { ok: true, stdout: String(result.stdout ?? "") };
}

function refuseGitFailure(
  message: string,
  input: EvaluateCoverageApplicabilityInput,
  empty: ClassifiedChange[],
): CoverageApplicabilityResult {
  if (
    message.includes("baseSha") ||
    message.includes(input.baseSha) ||
    /unknown revision|bad revision|needed a single revision/i.test(message)
  ) {
    return {
      outcome: "refuse",
      code: "invalid-base",
      reason: message,
      changes: empty,
    };
  }
  return {
    outcome: "refuse",
    code: "git-failure",
    reason: message,
    changes: empty,
  };
}

/** Closed executable / measurement-relevant extensions. */
const COVERABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".cs",
  ".fs",
  ".vb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".rb",
  ".php",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".mli",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".sql",
  ".vue",
  ".svelte",
  // MDX/HTML can embed JS — treat as coverable, never inert N/A (#5421 Greptile P1).
  ".mdx",
  ".html",
  ".htm",
]);

/** Runtime / build / test / workflow config that changes executable behavior. */
const COVERABLE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "taskfile.yml",
  "taskfile.yaml",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "cmakelists.txt",
  "cargo.toml",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pom.xml",
  "directory.build.props",
  "directory.packages.props",
]);

const COVERABLE_BASENAME_PREFIXES = [
  "vitest.config.",
  "jest.config.",
  "webpack.config.",
  "rollup.config.",
  "vite.config.",
  "esbuild.config.",
  "tsconfig",
  "jsconfig",
];

const INERT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".rst",
  ".adoc",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".css",
  ".scss",
  ".sass",
  ".less",
]);

const INERT_BASENAMES = new Set([
  "changelog.md",
  "readme.md",
  "license",
  "license.md",
  "notice",
  "authors",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
]);

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function basenameOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.toLowerCase();
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isUnderPrefix(path: string, prefixes: readonly string[]): boolean {
  const p = posixPath(path).toLowerCase();
  return prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Live project settings under xbrief/ — not planning prose; must stay applicable. */
const LIVE_SETTINGS_PATHS = new Set([
  "xbrief/project-definition.xbrief.json",
  "xbrief/plan.xbrief.json",
  "xbrief/specification.xbrief.json",
]);

const PROJECT_DEFINITION_PATH = "xbrief/project-definition.xbrief.json";

/** Closed LifecycleItem keys emitted by project:render / scanLifecycleFolders (#5479). */
const REGISTRY_ITEM_KEYS = new Set(["id", "title", "status", "metadata"]);

/** Closed item.metadata keys from renderer output (plus unreadable-file `error`). */
const REGISTRY_ITEM_METADATA_KEYS = new Set([
  "source_path",
  "lifecycle_folder",
  "references",
  "error",
]);

function isLiveSettingsPath(path: string): boolean {
  return LIVE_SETTINGS_PATHS.has(posixPath(path).toLowerCase());
}

function isProjectDefinitionPath(path: string): boolean {
  return posixPath(path).toLowerCase() === PROJECT_DEFINITION_PATH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => structuralEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const setB = new Set(keysB);
  for (const key of keysA) {
    if (!setB.has(key)) return false;
    if (!structuralEqual(a[key], b[key])) return false;
  }
  return true;
}

function jsonPointerEscape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function joinPointer(prefix: string, segment: string): string {
  return `${prefix}/${jsonPointerEscape(segment)}`;
}

/**
 * Collect changed JSON Pointers at refresh granularity (#5479).
 * Arrays under compared roots are atomic (e.g. `/plan/items`, not per-index).
 */
function collectChangedPointers(base: unknown, head: unknown, prefix = ""): string[] {
  if (structuralEqual(base, head)) return [];
  if (Array.isArray(base) || Array.isArray(head)) {
    return prefix.length > 0 ? [prefix] : ["/"];
  }
  if (!isPlainObject(base) || !isPlainObject(head)) {
    return prefix.length > 0 ? [prefix] : ["/"];
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  const changed: string[] = [];
  for (const key of keys) {
    const child = joinPointer(prefix, key);
    const hasBase = Object.hasOwn(base, key);
    const hasHead = Object.hasOwn(head, key);
    if (!hasBase || !hasHead) {
      changed.push(child);
      continue;
    }
    changed.push(...collectChangedPointers(base[key], head[key], child));
  }
  return changed;
}

function isValidRegistryItem(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  for (const key of Object.keys(item)) {
    if (!REGISTRY_ITEM_KEYS.has(key)) return false;
  }
  if (
    typeof item.id !== "string" ||
    typeof item.title !== "string" ||
    typeof item.status !== "string"
  ) {
    return false;
  }
  if (!Object.hasOwn(item, "metadata")) return true;
  const metadata = item.metadata;
  if (!isPlainObject(metadata)) return false;
  for (const key of Object.keys(metadata)) {
    if (!REGISTRY_ITEM_METADATA_KEYS.has(key)) return false;
  }
  if (Object.hasOwn(metadata, "source_path") && typeof metadata.source_path !== "string") {
    return false;
  }
  if (
    Object.hasOwn(metadata, "lifecycle_folder") &&
    typeof metadata.lifecycle_folder !== "string"
  ) {
    return false;
  }
  if (Object.hasOwn(metadata, "error") && typeof metadata.error !== "string") {
    return false;
  }
  if (Object.hasOwn(metadata, "references") && !Array.isArray(metadata.references)) {
    return false;
  }
  return true;
}

function isValidRegistryItems(items: unknown): boolean {
  return Array.isArray(items) && items.every(isValidRegistryItem);
}

function isValidStalenessFlags(flags: unknown): boolean {
  return Array.isArray(flags) && flags.every((f) => typeof f === "string");
}

function resolveInfoRootKey(doc: Record<string, unknown>): "xBRIEFInfo" | "vBRIEFInfo" | null {
  if (isPlainObject(doc.xBRIEFInfo)) return "xBRIEFInfo";
  if (isPlainObject(doc.vBRIEFInfo)) return "vBRIEFInfo";
  return null;
}

/**
 * Prefer-A Bound #5479: true when base→head PROJECT-DEFINITION delta is only the
 * closed project:render refresh set under validated registry schemas.
 */
export function isProjectDefinitionRegistryRefreshOnly(
  baseDoc: unknown,
  headDoc: unknown,
): boolean {
  if (!isPlainObject(baseDoc) || !isPlainObject(headDoc)) return false;

  const basePlan = isPlainObject(baseDoc.plan) ? baseDoc.plan : null;
  const headPlan = isPlainObject(headDoc.plan) ? headDoc.plan : null;
  if (basePlan === null || headPlan === null) return false;

  if (!isValidRegistryItems(basePlan.items) || !isValidRegistryItems(headPlan.items)) {
    return false;
  }

  const baseInfoRoot = resolveInfoRootKey(baseDoc);
  const headInfoRoot = resolveInfoRootKey(headDoc);
  if (baseInfoRoot === null || headInfoRoot === null || baseInfoRoot !== headInfoRoot) {
    return false;
  }
  const baseUpdated = (baseDoc[baseInfoRoot] as Record<string, unknown>).updated;
  const headUpdated = (headDoc[headInfoRoot] as Record<string, unknown>).updated;
  if (typeof baseUpdated !== "string" || typeof headUpdated !== "string") {
    return false;
  }

  const baseMetaMissing = !Object.hasOwn(basePlan, "metadata");
  const headHasMeta = Object.hasOwn(headPlan, "metadata");
  const baseMeta = isPlainObject(basePlan.metadata) ? basePlan.metadata : null;
  const headMeta = isPlainObject(headPlan.metadata) ? headPlan.metadata : null;

  // Narrow first-time /plan/metadata create: only validated staleness_flags.
  if (baseMetaMissing && headHasMeta) {
    if (headMeta === null) return false;
    const headMetaKeys = Object.keys(headMeta);
    if (headMetaKeys.length !== 1 || headMetaKeys[0] !== "staleness_flags") return false;
    if (!isValidStalenessFlags(headMeta.staleness_flags)) return false;
  } else if (baseMeta !== null || headMeta !== null) {
    if (baseMeta === null || headMeta === null) return false;
    if (
      Object.hasOwn(baseMeta, "staleness_flags") &&
      !isValidStalenessFlags(baseMeta.staleness_flags)
    ) {
      return false;
    }
    if (
      Object.hasOwn(headMeta, "staleness_flags") &&
      !isValidStalenessFlags(headMeta.staleness_flags)
    ) {
      return false;
    }
  }

  const changed = collectChangedPointers(baseDoc, headDoc);
  const allow = new Set<string>([
    "/plan/items",
    `/${baseInfoRoot}/updated`,
    "/plan/metadata/staleness_flags",
  ]);
  // First-time metadata object creation appears as `/plan/metadata` (key added).
  if (baseMetaMissing && headHasMeta) {
    allow.add("/plan/metadata");
  }
  return changed.every((pointer) => allow.has(pointer));
}

function readBlobJson(
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
  projectRoot: string,
  sha: string,
  path: string,
): { ok: true; value: unknown } | { ok: false } {
  const shown = runGit(["show", `${sha}:${posixPath(path)}`], projectRoot);
  if (!shown.ok) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(shown.stdout) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * After path classify, demote PROJECT-DEFINITION coverable→inert for this evaluation
 * only when status is M and closed refresh proof succeeds (#5479 Prefer-A Bound).
 */
function demoteProjectDefinitionRefreshChanges(
  changes: readonly ClassifiedChange[],
  input: EvaluateCoverageApplicabilityInput,
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
): ClassifiedChange[] {
  return changes.map((change) => {
    if (change.classification !== "coverable") return change;
    if (!isProjectDefinitionPath(change.path)) return change;
    // Bound: only regular-file modifications; A/D/R/C stay coverable.
    if (change.status !== "M") return change;
    const baseBlob = readBlobJson(runGit, input.projectRoot, input.baseSha, change.path);
    const headBlob = readBlobJson(runGit, input.projectRoot, input.headSha, change.path);
    if (!baseBlob.ok || !headBlob.ok) return change;
    if (!isProjectDefinitionRegistryRefreshOnly(baseBlob.value, headBlob.value)) {
      return change;
    }
    return {
      status: change.status,
      path: change.path,
      oldPath: change.oldPath,
      classification: "inert",
    };
  });
}

function isCoverableConfig(path: string): boolean {
  const base = basenameOf(path);
  if (COVERABLE_BASENAMES.has(base)) return true;
  if (COVERABLE_BASENAME_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  const p = posixPath(path).toLowerCase();
  if (isLiveSettingsPath(p)) return true;
  if (p.includes(".github/workflows/") && (base.endsWith(".yml") || base.endsWith(".yaml"))) {
    return true;
  }
  if (base.endsWith(".csproj") || base.endsWith(".fsproj") || base.endsWith(".vbproj")) {
    return true;
  }
  if (base.endsWith(".sln") || base.endsWith(".props") || base.endsWith(".targets")) {
    return true;
  }
  return false;
}

/**
 * Closed classifier rules. Markdown/JSON/xbrief are inert only when these rules
 * positively match — never by blanket extension alone outside planning/docs paths.
 */
export function classifyChangedPath(
  path: string,
  _status: string,
  _oldPath: string | null,
): PathClassification {
  const p = posixPath(path);
  const base = basenameOf(p);
  const ext = extensionOf(p);

  if (isCoverableConfig(p)) return "coverable";
  if (COVERABLE_EXTENSIONS.has(ext)) {
    // Declaration files remain coverable (they are TypeScript surface).
    return "coverable";
  }

  if (INERT_BASENAMES.has(base)) return "inert";

  // Planning / design / decision artifacts under known roots.
  if (
    isUnderPrefix(p, [
      "xbrief",
      "vbrief",
      ".planning",
      "docs",
      "design",
      "content/docs",
      "content/meta",
    ])
  ) {
    if (
      INERT_EXTENSIONS.has(ext) ||
      ext === ".json" ||
      ext === ".yaml" ||
      ext === ".yml" ||
      ext === ".toml"
    ) {
      return "inert";
    }
  }

  // Root / docs-adjacent prose.
  if (INERT_EXTENSIONS.has(ext) && !p.includes("/src/") && !p.includes("/packages/")) {
    return "inert";
  }

  // Generated registry references that are documentation projections.
  if (
    (ext === ".json" || ext === ".md") &&
    (p.includes("/registry/") || p.endsWith(".registry.json") || p.includes("references/"))
  ) {
    return "inert";
  }

  // Istanbul / coverage tool output — measurement artifact, not product under review.
  if (
    isUnderPrefix(p, ["coverage", ".nyc_output"]) ||
    base === "coverage-final.json" ||
    base === "lcov.info" ||
    base === "clover.xml" ||
    base.endsWith(".lcov")
  ) {
    return "inert";
  }

  return "unknown";
}

export interface NameStatusRow {
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/**
 * Decode one Git C-quoted path (`"docs/caf\303\251.md"` → `docs/café.md`).
 * Unquoted paths are returned unchanged. Used only for non-`-z` fallbacks.
 */
export function decodeGitQuotedPath(raw: string): string {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  let out = "";
  const utf8Bytes: number[] = [];
  const flushBytes = (): void => {
    if (utf8Bytes.length === 0) return;
    out += Buffer.from(utf8Bytes).toString("utf8");
    utf8Bytes.length = 0;
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      flushBytes();
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      flushBytes();
      out += "\\";
      break;
    }
    if (next >= "0" && next <= "7") {
      let oct = next;
      let consumed = 1;
      const n2 = inner[i + 2];
      const n3 = inner[i + 3];
      if (n2 !== undefined && n2 >= "0" && n2 <= "7") {
        oct += n2;
        consumed = 2;
        if (n3 !== undefined && n3 >= "0" && n3 <= "7") {
          oct += n3;
          consumed = 3;
        }
      }
      utf8Bytes.push(Number.parseInt(oct, 8));
      i += consumed;
      continue;
    }
    flushBytes();
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case '"':
      case "\\":
        out += next;
        break;
      default:
        out += next;
        break;
    }
    i += 1;
  }
  flushBytes();
  return out;
}

/**
 * Parse `git diff -z --name-status` (NUL-separated; no C-quoting).
 * Also accepts legacy tab/LF text and decodes quoted paths.
 */
export function parseNameStatus(text: string): NameStatusRow[] {
  if (text.includes("\0")) {
    const tokens = text.split("\0");
    const rows: NameStatusRow[] = [];
    let i = 0;
    while (i < tokens.length) {
      const status = (tokens[i] ?? "").trim();
      if (status.length === 0) {
        i += 1;
        continue;
      }
      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = tokens[i + 1] ?? "";
        const path = tokens[i + 2] ?? "";
        if (oldPath.length > 0 && path.length > 0) {
          rows.push({ status, oldPath, path });
        }
        i += 3;
        continue;
      }
      const path = tokens[i + 1] ?? "";
      if (path.length > 0) {
        rows.push({ status, oldPath: null, path });
      }
      i += 2;
    }
    return rows;
  }

  const rows: NameStatusRow[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = (parts[0] ?? "").trim();
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts.length < 3) continue;
      rows.push({
        status,
        oldPath: decodeGitQuotedPath(parts[1] ?? ""),
        path: decodeGitQuotedPath(parts[2] ?? ""),
      });
      continue;
    }
    rows.push({
      status,
      oldPath: null,
      path: decodeGitQuotedPath(parts[1] ?? ""),
    });
  }
  return rows.filter((r) => r.path.length > 0);
}

function isRenameToDocumentWithoutProof(
  row: NameStatusRow,
  classify: typeof classifyChangedPath,
): boolean {
  if (!(row.status.startsWith("R") || row.status.startsWith("C"))) return false;
  if (row.oldPath === null) return true;
  const oldClass = classify(row.oldPath, row.status, null);
  const newClass = classify(row.path, row.status, row.oldPath);
  // Only proven-inert old paths may rename to inert without further proof.
  // Coverable or unknown → inert is rename-to-document without proof.
  return oldClass !== "inert" && newClass === "inert";
}

export function evaluateCoverageApplicability(
  input: EvaluateCoverageApplicabilityInput,
  deps: CoverageApplicabilityDeps = {},
): CoverageApplicabilityResult {
  const runGit = deps.runGit ?? defaultRunGit;
  const classify = deps.classifyPath ?? classifyChangedPath;
  const empty: ClassifiedChange[] = [];

  if (!input.baseSha || input.baseSha.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-base",
      reason: "coverage-applicability: invalid or empty baseSha",
      changes: empty,
    };
  }
  if (!input.headSha || input.headSha.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-head",
      reason: "coverage-applicability: invalid or empty headSha",
      changes: empty,
    };
  }
  if (!input.treeHash || input.treeHash.trim().length === 0) {
    return {
      outcome: "refuse",
      code: "invalid-tree",
      reason: "coverage-applicability: invalid or empty treeHash",
      changes: empty,
    };
  }

  if (input.requireTreeMatch !== false) {
    const headTreeResult = runGit(["rev-parse", `${input.headSha}^{tree}`], input.projectRoot);
    if (!headTreeResult.ok) return refuseGitFailure(headTreeResult.message, input, empty);
    if (headTreeResult.stdout.trim() !== input.treeHash.trim()) {
      return {
        outcome: "refuse",
        code: "tree-mismatch",
        reason: "coverage-applicability: binding treeHash does not match the reviewed head tree",
        changes: empty,
      };
    }
  }

  // Validate base is resolvable.
  const baseResult = runGit(["rev-parse", "--verify", "-q", input.baseSha], input.projectRoot);
  if (!baseResult.ok) return refuseGitFailure(baseResult.message, input, empty);

  const nameStatusResult = runGit(
    ["diff", "-z", "--name-status", "--find-renames", input.baseSha, input.headSha],
    input.projectRoot,
  );
  if (!nameStatusResult.ok) return refuseGitFailure(nameStatusResult.message, input, empty);
  const rows = parseNameStatus(nameStatusResult.stdout);
  if (rows.length === 0) {
    return {
      outcome: "refuse",
      code: "empty-selection",
      reason:
        "coverage-applicability: empty or failed path selection is not proof of an inert diff",
      changes: empty,
    };
  }

  const changes: ClassifiedChange[] = [];
  for (const row of rows) {
    if (isRenameToDocumentWithoutProof(row, classify)) {
      return {
        outcome: "refuse",
        code: "rename-to-document",
        reason: `coverage-applicability: rename-to-document without content/type proof (${row.oldPath} -> ${row.path})`,
        changes,
      };
    }
    let classification: PathClassification;
    try {
      classification = classify(row.path, row.status, row.oldPath);
    } catch (err: unknown) {
      return {
        outcome: "refuse",
        code: "classifier-failure",
        reason: `coverage-applicability: classifier failure: ${String((err as Error).message ?? err)}`,
        changes,
      };
    }
    changes.push({
      status: row.status,
      path: row.path,
      oldPath: row.oldPath,
      classification,
    });
  }

  if (changes.some((c) => c.classification === "unknown")) {
    const unknownPaths = changes.filter((c) => c.classification === "unknown").map((c) => c.path);
    return {
      outcome: "refuse",
      code: "unknown-path",
      reason: `coverage-applicability: unknown path classification: ${unknownPaths.join(", ")}`,
      changes,
    };
  }

  if (!changes.every((c) => c.classification === "coverable" || c.classification === "inert")) {
    return {
      outcome: "refuse",
      code: "mixed-unclassified",
      reason: "coverage-applicability: mixed classification without all-inert proof",
      changes,
    };
  }

  // Prefer-A Bound: dirty tree that is not the bound reviewed tree must refuse N/A.
  // Run after committed refuse paths so unknown/rename/etc. are not masked by dirty-tree
  // (hotspots may still measure when a report exists for dirty-tree only).
  const dirtyResult = runGit(["status", "--porcelain", "-uall"], input.projectRoot);
  if (!dirtyResult.ok) return refuseGitFailure(dirtyResult.message, input, empty);
  if (dirtyResult.stdout.trim().length > 0) {
    return {
      outcome: "refuse",
      code: "dirty-tree",
      reason:
        "coverage-applicability: dirty working tree is not the bound reviewed tree; " +
        "commit or stash coverable edits before coverage N/A",
      changes,
    };
  }

  // #5479 Prefer-A Bound: demote PROJECT-DEFINITION refresh-only M rows after
  // path classify + binding refuses, before applicable aggregation.
  const evaluatedChanges = demoteProjectDefinitionRefreshChanges(changes, input, runGit);

  const coverable = evaluatedChanges.filter((c) => c.classification === "coverable");
  if (coverable.length > 0) {
    return {
      outcome: "applicable",
      coverablePaths: coverable.map((c) => c.path),
      changes: evaluatedChanges,
    };
  }

  return {
    outcome: "not-applicable",
    reason: COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
    changes: evaluatedChanges,
  };
}

/** True when the controller may honor the coverage_headroom skip channel. */
export function isCoverageHeadroomNotApplicable(
  input: EvaluateCoverageApplicabilityInput,
  deps?: CoverageApplicabilityDeps,
): boolean {
  return evaluateCoverageApplicability(input, deps).outcome === "not-applicable";
}
