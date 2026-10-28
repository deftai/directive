/**
 * Shared fail-closed coverage applicability evaluator (#5421 Prefer-A Bound).
 * Classifies the complete reviewed change set bound to PrePrInputBinding fields.
 */

import * as childProcess from "node:child_process";
import { isPythonRunShimContent } from "../deposit/python-free.js";
import type { HookHost } from "../hooks/dispatcher.js";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "../hooks/tools.js";
import {
  AGENT_HOOK_PATH_BY_HOST,
  AGENT_HOOK_PATHS,
  CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
  CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
  hostHookOuterCommand,
  hostHookOuterSha8,
  NESTED_HOOK_TIMEOUT_SECONDS,
  NESTED_TOOL_BEFORE_TIMEOUT_SECONDS,
} from "../init-deposit/agent-hooks.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  bareVersionMarkerRelativePaths,
  CODEQL_CONFIG_REL,
  installerManagedMatchers,
} from "../init-deposit/hygiene.js";
import { HOOK_FILENAMES } from "../init-deposit/scaffold.js";
import { isClosedPlanSequenceShape, PLAN_SEQUENCE_REL_PATH } from "../plan-sequence/types.js";
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
  "bun.lock",
  "bun.lockb",
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
  ".gitignore",
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
const PLAN_XBRIEF_PATH = "xbrief/plan.xbrief.json";
const SPECIFICATION_XBRIEF_PATH = "xbrief/specification.xbrief.json";
const INTERVIEW_CONTINUATION_KEY = "x-directive/interviewContinuation";

/** Closed LifecycleItem keys emitted by project:render / scanLifecycleFolders (#5479). */
const REGISTRY_ITEM_KEYS = new Set(["id", "title", "status", "metadata"]);

/** Closed item.metadata keys from renderer output (plus unreadable-file `error`). */
const REGISTRY_ITEM_METADATA_KEYS = new Set([
  "source_path",
  "lifecycle_folder",
  "references",
  "error",
]);

/** Named interviewContinuation keys eligible for plan.xbrief.json M demotion (#5551). */
const PLAN_INTERVIEW_CONTINUATION_DEMOTION_KEYS = new Set([
  "targetDeliverable",
  "reopenableDecisionSet",
  "confirmations",
]);

/** Named requirements/design narrative keys for specification M demotion (#5551). */
const SPEC_NARRATIVE_DEMOTION_KEYS = new Set(["Requirements", "Design"]);

function isLiveSettingsPath(path: string): boolean {
  return LIVE_SETTINGS_PATHS.has(posixPath(path).toLowerCase());
}

function isProjectDefinitionPath(path: string): boolean {
  return posixPath(path).toLowerCase() === PROJECT_DEFINITION_PATH;
}

function isPlanXbriefPath(path: string): boolean {
  return posixPath(path).toLowerCase() === PLAN_XBRIEF_PATH;
}

function isSpecificationXbriefPath(path: string): boolean {
  return posixPath(path).toLowerCase() === SPECIFICATION_XBRIEF_PATH;
}

function isPlanSequencePath(path: string): boolean {
  return posixPath(path) === PLAN_SEQUENCE_REL_PATH;
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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const INTERVIEW_CONFIRMATION_ALLOWED_KEYS = new Set(["scope", "target", "revisionId", "at"]);

function isInterviewConfirmationEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!INTERVIEW_CONFIRMATION_ALLOWED_KEYS.has(key)) return false;
  }
  if (value.scope !== "answer" && value.scope !== "artifact" && value.scope !== "phase") {
    return false;
  }
  if (Object.hasOwn(value, "target") && typeof value.target !== "string") return false;
  if (Object.hasOwn(value, "revisionId") && typeof value.revisionId !== "string") return false;
  if (Object.hasOwn(value, "at") && typeof value.at !== "string") return false;
  return true;
}

/** Type-check demotion-eligible interviewContinuation fields; other keys ignored. */
function interviewContinuationDemotionFieldsValid(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (Object.hasOwn(value, "targetDeliverable") && typeof value.targetDeliverable !== "string") {
    return false;
  }
  if (
    Object.hasOwn(value, "reopenableDecisionSet") &&
    !isStringArray(value.reopenableDecisionSet)
  ) {
    return false;
  }
  if (Object.hasOwn(value, "confirmations")) {
    if (
      !Array.isArray(value.confirmations) ||
      !value.confirmations.every(isInterviewConfirmationEntry)
    ) {
      return false;
    }
  }
  return true;
}

function interviewContinuationIsDemotionOnlySlice(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!PLAN_INTERVIEW_CONTINUATION_DEMOTION_KEYS.has(key)) return false;
  }
  return interviewContinuationDemotionFieldsValid(value);
}

/**
 * Prefer-A Bound #5551: plan.xbrief.json M demotion for updated + named
 * interviewContinuation carrier keys only (not registry / policy / phase).
 */
export function isPlanInterviewContinuationRefreshOnly(
  baseDoc: unknown,
  headDoc: unknown,
): boolean {
  if (!isPlainObject(baseDoc) || !isPlainObject(headDoc)) return false;
  const basePlan = isPlainObject(baseDoc.plan) ? baseDoc.plan : null;
  const headPlan = isPlainObject(headDoc.plan) ? headDoc.plan : null;
  if (basePlan === null || headPlan === null) return false;

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

  const baseCarrier = Object.hasOwn(basePlan, INTERVIEW_CONTINUATION_KEY)
    ? basePlan[INTERVIEW_CONTINUATION_KEY]
    : undefined;
  const headCarrier = Object.hasOwn(headPlan, INTERVIEW_CONTINUATION_KEY)
    ? headPlan[INTERVIEW_CONTINUATION_KEY]
    : undefined;
  if (baseCarrier !== undefined && !interviewContinuationDemotionFieldsValid(baseCarrier)) {
    return false;
  }
  if (headCarrier !== undefined && !interviewContinuationDemotionFieldsValid(headCarrier)) {
    return false;
  }

  const changed = collectChangedPointers(baseDoc, headDoc);
  const carrierPrefix = `/plan/${jsonPointerEscape(INTERVIEW_CONTINUATION_KEY)}`;
  const allow = new Set<string>([
    `/${baseInfoRoot}/updated`,
    `${carrierPrefix}/targetDeliverable`,
    `${carrierPrefix}/reopenableDecisionSet`,
    `${carrierPrefix}/confirmations`,
  ]);
  // First-time carrier create appears as the parent pointer (no child recurse).
  // Only demote when the new object is demotion-key-only (phase/etc. stay coverable).
  if (
    baseCarrier === undefined &&
    headCarrier !== undefined &&
    interviewContinuationIsDemotionOnlySlice(headCarrier)
  ) {
    allow.add(carrierPrefix);
  }
  return changed.every((pointer) => allow.has(pointer));
}

/**
 * Prefer-A Bound #5551: specification.xbrief.json M demotion for updated +
 * named Requirements/Design narrative strings only.
 */
export function isSpecificationNarrativeRefreshOnly(baseDoc: unknown, headDoc: unknown): boolean {
  if (!isPlainObject(baseDoc) || !isPlainObject(headDoc)) return false;
  const basePlan = isPlainObject(baseDoc.plan) ? baseDoc.plan : null;
  const headPlan = isPlainObject(headDoc.plan) ? headDoc.plan : null;
  if (basePlan === null || headPlan === null) return false;

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

  const baseNarratives = isPlainObject(basePlan.narratives) ? basePlan.narratives : null;
  const headNarratives = isPlainObject(headPlan.narratives) ? headPlan.narratives : null;
  for (const key of SPEC_NARRATIVE_DEMOTION_KEYS) {
    if (
      baseNarratives !== null &&
      Object.hasOwn(baseNarratives, key) &&
      typeof baseNarratives[key] !== "string"
    ) {
      return false;
    }
    if (
      headNarratives !== null &&
      Object.hasOwn(headNarratives, key) &&
      typeof headNarratives[key] !== "string"
    ) {
      return false;
    }
  }

  const changed = collectChangedPointers(baseDoc, headDoc);
  const allow = new Set<string>([`/${baseInfoRoot}/updated`]);
  for (const key of SPEC_NARRATIVE_DEMOTION_KEYS) {
    allow.add(`/plan/narratives/${jsonPointerEscape(key)}`);
  }
  // First-time narratives object create: demote only when every new key is
  // Requirements/Design (Architecture etc. stay coverable).
  if (
    baseNarratives === null &&
    headNarratives !== null &&
    Object.keys(headNarratives).every((key) => SPEC_NARRATIVE_DEMOTION_KEYS.has(key))
  ) {
    allow.add("/plan/narratives");
  }
  return changed.every((pointer) => allow.has(pointer));
}

function demoteLiveSettingsClosedPointerChanges(
  changes: readonly ClassifiedChange[],
  input: EvaluateCoverageApplicabilityInput,
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
): ClassifiedChange[] {
  return changes.map((change) => {
    if (change.classification !== "coverable") return change;
    if (change.status !== "M") return change;
    const planPath = isPlanXbriefPath(change.path);
    const specPath = isSpecificationXbriefPath(change.path);
    if (!planPath && !specPath) return change;
    const baseBlob = readBlobJson(runGit, input.projectRoot, input.baseSha, change.path);
    const headBlob = readBlobJson(runGit, input.projectRoot, input.headSha, change.path);
    if (!baseBlob.ok || !headBlob.ok) return change;
    const ok = planPath
      ? isPlanInterviewContinuationRefreshOnly(baseBlob.value, headBlob.value)
      : isSpecificationNarrativeRefreshOnly(baseBlob.value, headBlob.value);
    if (!ok) return change;
    return {
      status: change.status,
      path: change.path,
      oldPath: change.oldPath,
      classification: "inert",
    };
  });
}

/**
 * Prefer-A Bound #5551: exact-path `.deft/plan-sequence.json` unknown→inert only
 * for A/M after closed-shape proof. R/D/malformed/approved-scope stay unknown.
 */
function provePlanSequenceClosedShapeInert(
  changes: readonly ClassifiedChange[],
  input: EvaluateCoverageApplicabilityInput,
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
): ClassifiedChange[] {
  return changes.map((change) => {
    if (!isPlanSequencePath(change.path)) return change;
    if (change.status !== "A" && change.status !== "M") return change;
    if (change.classification !== "unknown") return change;
    const headBlob = readBlobJson(runGit, input.projectRoot, input.headSha, change.path);
    if (!headBlob.ok) return change;
    if (!isClosedPlanSequenceShape(headBlob.value)) return change;
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

/** Repo-root fixtures/*.json only — not nested /fixtures/ segments or non-json (#5541). */
function isRepoRootFixturesJson(path: string): boolean {
  const p = posixPath(path).toLowerCase();
  if (!p.startsWith("fixtures/")) return false;
  return extensionOf(path) === ".json";
}

/**
 * Prefer-A #5665 limb-1: exact-path framework stamps/markers + policy audit trail.
 * Version siblings from bareVersionMarkerRelativePaths(); not the frozen Go deposit list.
 * Authority/membership under .deft/ and meta/ stay unknown unless another closed rule matches.
 */
const MANAGED_STAMP_LEDGER_INERT_PATHS: ReadonlySet<string> = new Set([
  ".deft/GENERATION.json",
  "meta/policy-changes.log",
  ...bareVersionMarkerRelativePaths(),
]);

function isManagedStampOrPolicyLedgerPath(path: string): boolean {
  return MANAGED_STAMP_LEDGER_INERT_PATHS.has(posixPath(path));
}

/**
 * Prefer-A #5674 residual deposit markers: exact VERSION + lifecycle `.gitkeep`
 * paths from installerManagedMatchers / VBRIEF_LIFECYCLE_DIRS.
 * #5677 Prefer-A Recut-1 adds CODEQL_CONFIG_REL + HOOK_FILENAMES exacts.
 * Keep-unknown: `.deft/core/run` (except deletion shebang proof), approved-scope,
 * HOOK_SUPPORT / adapter .sh|.mjs, unlisted peers.
 */
const PAYLOAD_VERSION_PATH = `${CANONICAL_INSTALL_ROOT}/VERSION`;
const PAYLOAD_RUN_PATH = `${CANONICAL_INSTALL_ROOT}/run`;

function residualDepositInertPaths(): ReadonlySet<string> {
  const gitkeeps = installerManagedMatchers()
    .map((m) => m.exact)
    .filter(
      (exact): exact is string =>
        typeof exact === "string" &&
        (exact.startsWith("xbrief/") || exact.startsWith("vbrief/")) &&
        exact.endsWith("/.gitkeep"),
    );
  const officialGithooks = HOOK_FILENAMES.map((name) => `.githooks/${name}`);
  return new Set<string>([
    PAYLOAD_VERSION_PATH,
    CODEQL_CONFIG_REL,
    ...officialGithooks,
    ...gitkeeps,
  ]);
}

const RESIDUAL_DEPOSIT_INERT_PATHS: ReadonlySet<string> = residualDepositInertPaths();

function isResidualDepositInertPath(path: string): boolean {
  return RESIDUAL_DEPOSIT_INERT_PATHS.has(posixPath(path));
}

const HOST_REGISTRATION_PATHS: ReadonlySet<string> = new Set(AGENT_HOOK_PATHS);

const NESTED_PRE_TOOL_MATCHERS = [
  DIRECT_WRITE_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
] as const;

function isHostRegistrationPath(path: string): boolean {
  return HOST_REGISTRATION_PATHS.has(posixPath(path));
}

function isPayloadRunPath(path: string): boolean {
  return posixPath(path) === PAYLOAD_RUN_PATH;
}

function deftHookCommand(host: HookHost, event: string): string {
  const sha8 = hostHookOuterSha8();
  return `${hostHookOuterCommand(host, sha8)} --host ${host} --event ${event}`;
}

function hostForRegistrationPath(path: string): HookHost | null {
  const p = posixPath(path);
  for (const host of Object.keys(AGENT_HOOK_PATH_BY_HOST) as HookHost[]) {
    if (AGENT_HOOK_PATH_BY_HOST[host] === p) return host;
  }
  return null;
}

function nestedManagedGroup(host: Exclude<HookHost, "cursor">, event: string, matcher?: string) {
  const toolBefore = event === "tool.before";
  const command = deftHookCommand(host, event);
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
        timeout: toolBefore ? NESTED_TOOL_BEFORE_TIMEOUT_SECONDS : NESTED_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function buildCanonicalHostRegistration(host: HookHost): Record<string, unknown> {
  if (host === "cursor") {
    return {
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: deftHookCommand("cursor", "session.start"),
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
        preToolUse: NESTED_PRE_TOOL_MATCHERS.map((matcher) => ({
          command: deftHookCommand("cursor", "tool.before"),
          matcher,
          failClosed: true,
          timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
        })),
        preCompact: [
          {
            command: deftHookCommand("cursor", "session.compact"),
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
        beforeSubmitPrompt: [
          {
            command: deftHookCommand("cursor", "prompt.submit"),
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
        afterAgentResponse: [
          {
            command: deftHookCommand("cursor", "agent.response"),
            timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    };
  }
  const compact = host === "claude" || host === "grok";
  const hooks: Record<string, unknown> = {
    SessionStart: [nestedManagedGroup(host, "session.start")],
    PreToolUse: NESTED_PRE_TOOL_MATCHERS.map((matcher) =>
      nestedManagedGroup(host, "tool.before", matcher),
    ),
  };
  if (compact) {
    hooks.PreCompact = [nestedManagedGroup(host, "session.compact")];
    hooks.PostCompact = [nestedManagedGroup(host, "session.compact")];
  }
  return { hooks };
}

function isCanonicalCursorManagedEntry(eventKey: string, entry: unknown): boolean {
  if (!isPlainObject(entry) || typeof entry.command !== "string") return false;
  const cmd = entry.command;
  if (eventKey === "sessionStart") {
    return (
      cmd === deftHookCommand("cursor", "session.start") &&
      entry.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS
    );
  }
  if (eventKey === "preToolUse") {
    return (
      cmd === deftHookCommand("cursor", "tool.before") &&
      typeof entry.matcher === "string" &&
      (NESTED_PRE_TOOL_MATCHERS as readonly string[]).includes(entry.matcher) &&
      entry.failClosed === true &&
      entry.timeout === CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS
    );
  }
  if (eventKey === "preCompact") {
    return (
      cmd === deftHookCommand("cursor", "session.compact") &&
      entry.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS
    );
  }
  if (eventKey === "beforeSubmitPrompt") {
    return (
      cmd === deftHookCommand("cursor", "prompt.submit") &&
      entry.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS &&
      entry.failClosed !== true
    );
  }
  if (eventKey === "afterAgentResponse") {
    return (
      cmd === deftHookCommand("cursor", "agent.response") &&
      entry.timeout === CURSOR_SESSION_HOOK_TIMEOUT_SECONDS &&
      entry.failClosed !== true
    );
  }
  return false;
}

function isCanonicalNestedManagedGroup(
  host: Exclude<HookHost, "cursor">,
  eventKey: string,
  entry: unknown,
): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) {
    return false;
  }
  const hook = entry.hooks[0];
  if (!isPlainObject(hook) || hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }
  if (eventKey === "SessionStart") {
    return (
      entry.matcher === undefined &&
      hook.command === deftHookCommand(host, "session.start") &&
      hook.timeout === NESTED_HOOK_TIMEOUT_SECONDS
    );
  }
  if (eventKey === "PreToolUse") {
    const expectedCmd = deftHookCommand(host, "tool.before");
    return (
      typeof entry.matcher === "string" &&
      (NESTED_PRE_TOOL_MATCHERS as readonly string[]).includes(entry.matcher) &&
      hook.command === expectedCmd &&
      hook.timeout === NESTED_TOOL_BEFORE_TIMEOUT_SECONDS
    );
  }
  if (eventKey === "PreCompact" || eventKey === "PostCompact") {
    return (
      entry.matcher === undefined &&
      hook.command === deftHookCommand(host, "session.compact") &&
      hook.timeout === NESTED_HOOK_TIMEOUT_SECONDS
    );
  }
  return false;
}

function managedMultisetComplete(
  actual: readonly unknown[],
  expected: readonly unknown[],
): boolean {
  if (actual.length !== expected.length) return false;
  const used = new Set<number>();
  for (const exp of expected) {
    const idx = actual.findIndex((item, i) => !used.has(i) && structuralEqual(item, exp));
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

function partitionCursorRegistration(doc: unknown): {
  readonly managedComplete: boolean;
  readonly consumerRemainder: Record<string, unknown>;
} | null {
  if (!isPlainObject(doc)) return null;
  if (doc.version !== 1) return null;
  const hooks = doc.hooks;
  if (!isPlainObject(hooks)) return null;
  const eventKeys = [
    "sessionStart",
    "preToolUse",
    "preCompact",
    "beforeSubmitPrompt",
    "afterAgentResponse",
  ] as const;
  const consumerHooks: Record<string, unknown[]> = {};
  const managedByEvent: Record<string, unknown[]> = {};
  for (const key of eventKeys) {
    const arr = hooks[key];
    if (arr === undefined) {
      managedByEvent[key] = [];
      continue;
    }
    if (!Array.isArray(arr)) return null;
    const managed: unknown[] = [];
    const consumer: unknown[] = [];
    for (const entry of arr) {
      if (isCanonicalCursorManagedEntry(key, entry)) managed.push(entry);
      else consumer.push(entry);
    }
    managedByEvent[key] = managed;
    if (consumer.length > 0) consumerHooks[key] = consumer;
  }
  for (const key of Object.keys(hooks)) {
    if (!(eventKeys as readonly string[]).includes(key)) {
      // Unknown hook event keys are consumer-authored.
      const value = hooks[key];
      if (Array.isArray(value) && value.length > 0) consumerHooks[key] = [...value];
      else if (value !== undefined) return null;
    }
  }
  const canonical = buildCanonicalHostRegistration("cursor");
  const canonicalHooks = (canonical.hooks ?? {}) as Record<string, unknown[]>;
  const managedComplete = eventKeys.every((key) =>
    managedMultisetComplete(managedByEvent[key] ?? [], canonicalHooks[key] ?? []),
  );
  const remainder: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (key === "hooks" || key === "version") continue;
    remainder[key] = doc[key];
  }
  if (Object.keys(consumerHooks).length > 0) {
    remainder.hooks = consumerHooks;
  }
  return { managedComplete, consumerRemainder: remainder };
}

function partitionNestedRegistration(
  host: Exclude<HookHost, "cursor">,
  doc: unknown,
): {
  readonly managedComplete: boolean;
  readonly consumerRemainder: Record<string, unknown>;
} | null {
  if (!isPlainObject(doc)) return null;
  const hooks = doc.hooks;
  if (!isPlainObject(hooks)) return null;
  const compact = host === "claude" || host === "grok";
  const eventKeys = compact
    ? (["SessionStart", "PreToolUse", "PreCompact", "PostCompact"] as const)
    : (["SessionStart", "PreToolUse"] as const);
  const consumerHooks: Record<string, unknown[]> = {};
  const managedByEvent: Record<string, unknown[]> = {};
  for (const key of eventKeys) {
    const arr = hooks[key];
    if (arr === undefined) {
      managedByEvent[key] = [];
      continue;
    }
    if (!Array.isArray(arr)) return null;
    const managed: unknown[] = [];
    const consumer: unknown[] = [];
    for (const entry of arr) {
      if (isCanonicalNestedManagedGroup(host, key, entry)) managed.push(entry);
      else consumer.push(entry);
    }
    managedByEvent[key] = managed;
    if (consumer.length > 0) consumerHooks[key] = consumer;
  }
  for (const key of Object.keys(hooks)) {
    if (!(eventKeys as readonly string[]).includes(key)) {
      const value = hooks[key];
      if (Array.isArray(value) && value.length > 0) consumerHooks[key] = [...value];
      else if (value !== undefined) return null;
    }
  }
  const canonical = buildCanonicalHostRegistration(host);
  const canonicalHooks = (canonical.hooks ?? {}) as Record<string, unknown[]>;
  const managedComplete = eventKeys.every((key) =>
    managedMultisetComplete(managedByEvent[key] ?? [], canonicalHooks[key] ?? []),
  );
  const remainder: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    if (key === "hooks") continue;
    remainder[key] = doc[key];
  }
  if (Object.keys(consumerHooks).length > 0) {
    remainder.hooks = consumerHooks;
  }
  return { managedComplete, consumerRemainder: remainder };
}

function partitionHostRegistration(
  host: HookHost,
  doc: unknown,
): {
  readonly managedComplete: boolean;
  readonly consumerRemainder: Record<string, unknown>;
} | null {
  return host === "cursor"
    ? partitionCursorRegistration(doc)
    : partitionNestedRegistration(host, doc);
}

function isManagedOnlyHostRegistration(host: HookHost, doc: unknown): boolean {
  const part = partitionHostRegistration(host, doc);
  if (part === null) return false;
  return part.managedComplete && Object.keys(part.consumerRemainder).length === 0;
}

function pathPresenceInTree(
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
  projectRoot: string,
  sha: string,
  path: string,
): "absent" | "present" | "error" {
  const listed = runGit(["ls-tree", "--name-only", sha, "--", posixPath(path)], projectRoot);
  if (!listed.ok) return "error";
  const lines = listed.stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? "absent" : "present";
}

function readBlobText(
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
  projectRoot: string,
  sha: string,
  path: string,
): { ok: true; text: string } | { ok: false } {
  const shown = runGit(["show", `${sha}:${posixPath(path)}`], projectRoot);
  if (!shown.ok) return { ok: false };
  return { ok: true, text: shown.stdout };
}

/**
 * Prefer-A #5677 Recut-1 limb 2: host registration unknown→inert only when A/M
 * managed-projection proof succeeds (verified base absence for A; remainder+canonical for M).
 */
function proveHostRegistrationManagedProjectionInert(
  changes: readonly ClassifiedChange[],
  input: EvaluateCoverageApplicabilityInput,
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
): ClassifiedChange[] {
  return changes.map((change) => {
    if (!isHostRegistrationPath(change.path)) return change;
    if (change.classification !== "unknown") return change;
    if (change.status !== "A" && change.status !== "M") return change;
    const host = hostForRegistrationPath(change.path);
    if (host === null) return change;
    const headBlob = readBlobJson(runGit, input.projectRoot, input.headSha, change.path);
    if (!headBlob.ok) return change;
    if (change.status === "A") {
      const presence = pathPresenceInTree(runGit, input.projectRoot, input.baseSha, change.path);
      if (presence !== "absent") return change;
      if (!isManagedOnlyHostRegistration(host, headBlob.value)) return change;
      return {
        status: change.status,
        path: change.path,
        oldPath: change.oldPath,
        classification: "inert",
      };
    }
    // status=M
    const baseBlob = readBlobJson(runGit, input.projectRoot, input.baseSha, change.path);
    if (!baseBlob.ok) return change;
    const basePart = partitionHostRegistration(host, baseBlob.value);
    const headPart = partitionHostRegistration(host, headBlob.value);
    if (basePart === null || headPart === null) return change;
    if (!headPart.managedComplete) return change;
    if (!structuralEqual(basePart.consumerRemainder, headPart.consumerRemainder)) return change;
    return {
      status: change.status,
      path: change.path,
      oldPath: change.oldPath,
      classification: "inert",
    };
  });
}

/**
 * Prefer-A #5677 Recut-1 limb 5: `.deft/core/run` status=D unknown→inert only with
 * base-blob Python shebang proof (not path-only helper).
 */
function proveRetiredRunShimDeletionInert(
  changes: readonly ClassifiedChange[],
  input: EvaluateCoverageApplicabilityInput,
  runGit: (args: readonly string[], cwd: string) => GitRunResult,
): ClassifiedChange[] {
  return changes.map((change) => {
    if (!isPayloadRunPath(change.path)) return change;
    if (change.classification !== "unknown") return change;
    if (change.status !== "D") return change;
    const baseBlob = readBlobText(runGit, input.projectRoot, input.baseSha, change.path);
    if (!baseBlob.ok) return change;
    if (!isPythonRunShimContent(baseBlob.text.slice(0, 200))) return change;
    return {
      status: change.status,
      path: change.path,
      oldPath: change.oldPath,
      classification: "inert",
    };
  });
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

  // #5541: ordinary Bun consumer fixtures JSON is inert after coverable-first.
  if (isRepoRootFixturesJson(p)) return "inert";

  // #5665: Directive-managed stamps/markers + append-only policy ledger (exact posix).
  if (isManagedStampOrPolicyLedgerPath(p)) return "inert";

  // #5674: exact VERSION + ten lifecycle .gitkeep markers (after coverable-first).
  if (isResidualDepositInertPath(p)) return "inert";

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
      "content/packs",
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

  // #5551: exact-path plan-sequence A/M unknown→inert only after closed-shape proof.
  const afterSequenceProof = provePlanSequenceClosedShapeInert(changes, input, runGit);
  // #5677 Prefer-A Recut-1: host-registration managed-projection + run D shebang proofs
  // must run before unknown-path refuse (same family as plan-sequence).
  const afterRegistrationProof = proveHostRegistrationManagedProjectionInert(
    afterSequenceProof,
    input,
    runGit,
  );
  const afterRunShimProof = proveRetiredRunShimDeletionInert(afterRegistrationProof, input, runGit);

  if (afterRunShimProof.some((c) => c.classification === "unknown")) {
    const unknownPaths = afterRunShimProof
      .filter((c) => c.classification === "unknown")
      .map((c) => c.path);
    return {
      outcome: "refuse",
      code: "unknown-path",
      reason: `coverage-applicability: unknown path classification: ${unknownPaths.join(", ")}`,
      changes: afterRunShimProof,
    };
  }

  if (
    !afterRunShimProof.every(
      (c) => c.classification === "coverable" || c.classification === "inert",
    )
  ) {
    return {
      outcome: "refuse",
      code: "mixed-unclassified",
      reason: "coverage-applicability: mixed classification without all-inert proof",
      changes: afterRunShimProof,
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
      changes: afterRunShimProof,
    };
  }

  // #5479 Prefer-A Bound: demote PROJECT-DEFINITION refresh-only M rows after
  // path classify + binding refuses, before applicable aggregation.
  const afterProjectDef = demoteProjectDefinitionRefreshChanges(afterRunShimProof, input, runGit);
  // #5551 Prefer-A Bound: demote plan/spec closed-pointer M rows; LIVE_SETTINGS stay
  // coverable by default when the allowlist proof fails.
  const evaluatedChanges = demoteLiveSettingsClosedPointerChanges(afterProjectDef, input, runGit);

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
