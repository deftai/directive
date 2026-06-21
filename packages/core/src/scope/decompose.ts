/**
 * scope/decompose.ts -- Apply or validate an approved epic/phase -> story decomposition draft.
 *
 * Faithful TypeScript port of scripts/scope_decompose.py + scripts/_vbrief_story_quality.py.
 * The command is deterministic: it never invents stories from a parent scope.
 * A caller supplies a draft with child story definitions; this module validates
 * that draft, writes the child story vBRIEFs, and updates the parent scope references.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { referenceWithDefaultTrust, slugify } from "../vbrief-build/build.js";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import { formatVbriefJson } from "./vbrief-json.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFECYCLE_FOLDERS = new Set(["proposed", "pending", "active", "completed", "cancelled"]);
const ACTIVE_DECOMPOSITION_STATUSES = new Set(["active", "running"]);
const READY = "ready";
const STORY_READINESS_STATES = new Set([READY, "sequential", "needs_refinement"]);

// ---------------------------------------------------------------------------
// DecompositionError
// ---------------------------------------------------------------------------

export class DecompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompositionError";
  }
}

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function loadJson(path: string): JsonObj {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new DecompositionError(`${path}: cannot read file: ${String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new DecompositionError(`${path}: invalid JSON: ${String(err)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DecompositionError(`${path}: expected a JSON object`);
  }
  return data as JsonObj;
}

function writeJson(path: string, data: JsonObj): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatVbriefJson(data), "utf8");
}

// ---------------------------------------------------------------------------
// Story quality helpers (ported from _vbrief_story_quality.py)
// ---------------------------------------------------------------------------

const BROAD_FILE_SCOPE_ROOTS = new Set(["backend", "frontend", "docs", "vbrief"]);

const CODE_PATH_TERMS = [
  "api",
  "cli",
  "component",
  "config",
  "database",
  "endpoint",
  "file",
  "handler",
  "model",
  "module",
  "repository",
  "route",
  "schema",
  "script",
  "service",
  "source",
  "src/",
];

const VERIFY_EVIDENCE_TERMS = [
  "assert",
  "evidence",
  "fixture",
  "report",
  "spec",
  "test",
  "tests/",
  "verify",
];

const GENERIC_VERIFY_COMMANDS = new Set([
  "cargo test",
  "go test ./...",
  "npm run test",
  "npm test",
  "pytest",
  "task check",
]);

const PLACEHOLDER_ACCEPTANCE_PATTERNS = [
  "acceptance criteria for",
  "copy from parent",
  "copy from specification",
  "placeholder",
  "refine from parent",
  "tbd",
  "to be defined",
  "to refine",
  "to refine from parent scope",
  "todo",
];

const DOCS_ONLY_ACCEPTANCE_PATTERNS = [
  "docs updated",
  "documentation updated",
  "readme updated",
  "update docs",
  "update documentation",
  "update readme",
];

const GENERIC_IMPLEMENTATION_PATTERNS = [
  "add tests so it works",
  "change the code",
  "implement the feature",
  "make it work",
  "update the code",
  "works as expected",
];

const VAGUE_ACCEPTANCE_PATTERNS = [
  "displays a message",
  "handles errors",
  "is implemented",
  "is updated",
  "passes tests",
  "shows a message",
  "the system displays a message",
  "updates the ui",
  "works as expected",
];

const OBSERVABLE_TERMS = [
  "blocks",
  "creates",
  "deletes",
  "displays",
  "emits",
  "fails",
  "persists",
  "records",
  "redirects",
  "rejects",
  "renders",
  "returns",
  "saves",
  "shows",
  "stores",
  "updates",
  "validates",
  "when ",
  "given ",
  "then ",
];

const USER_STORY_RE = /^\s*As\s+an?\s+[^,]+,\s*I\s+want\s+.+,\s*so\s+that\s+.+\.\s*$/is;

export function asStrList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((s) => s.length > 0);
  }
  return [];
}

export function acceptanceTextsFromItems(items: unknown): string[] {
  const texts: string[] = [];
  if (!Array.isArray(items)) return texts;
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const obj = item as JsonObj;
    const narrative = obj.narrative;
    if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
      const acc = (narrative as JsonObj).Acceptance;
      if (typeof acc === "string" && acc.trim().length > 0) texts.push(acc.trim());
    }
    for (const childKey of ["items", "subItems"]) {
      texts.push(...acceptanceTextsFromItems(obj[childKey]));
    }
  }
  return texts;
}

export function itemHasAcceptance(item: JsonObj): boolean {
  const narrative = item.narrative;
  if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
    const acc = (narrative as JsonObj).Acceptance;
    if (typeof acc === "string" && acc.trim().length > 0) return true;
  }
  for (const childKey of ["items", "subItems"]) {
    const children = item[childKey];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === "object" && child !== null && !Array.isArray(child)) {
          if (itemHasAcceptance(child as JsonObj)) return true;
        }
      }
    }
  }
  return false;
}

export function itemsHaveAcceptance(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  return items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      itemHasAcceptance(item as JsonObj),
  );
}

export function itemHasTraces(item: JsonObj): boolean {
  const narrative = item.narrative;
  if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
    const val = (narrative as JsonObj).Traces;
    if (typeof val === "string" && val.trim().length > 0) return true;
  }
  for (const childKey of ["items", "subItems"]) {
    const children = item[childKey];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === "object" && child !== null && !Array.isArray(child)) {
          if (itemHasTraces(child as JsonObj)) return true;
        }
      }
    }
  }
  return false;
}

export function missingRequiredSwarmFields(swarm: JsonObj): string[] {
  const missing: string[] = [];
  for (const key of ["file_scope", "verify_commands", "expected_outputs"]) {
    if (asStrList(swarm[key]).length === 0) missing.push(`plan.metadata.swarm.${key}`);
  }
  if (!("depends_on" in swarm)) missing.push("plan.metadata.swarm.depends_on");
  for (const key of ["conflict_group", "size", "file_scope_confidence", "model_tier"]) {
    const val = swarm[key];
    if (typeof val !== "string" || val.trim().length === 0) {
      missing.push(`plan.metadata.swarm.${key}`);
    }
  }
  return missing;
}

export function deprecatedSubitemsIssues(items: unknown, prefix = "plan.items"): string[] {
  const issues: string[] = [];
  function visit(children: unknown, path: string): void {
    if (!Array.isArray(children)) return;
    for (let i = 0; i < children.length; i += 1) {
      const item = children[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const obj = item as JsonObj;
      const itemPath = `${path}[${i}]`;
      if ("subItems" in obj) issues.push(`${itemPath}.subItems is deprecated; use items`);
      visit(obj.items, `${itemPath}.items`);
      visit(obj.subItems, `${itemPath}.subItems`);
    }
  }
  visit(items, prefix);
  return issues;
}

function sentenceCount(value: string): number {
  return value
    .trim()
    .split(/[.!?]+(?:\s+|$)/)
    .filter((p) => p.trim().length > 0).length;
}

function stepCount(value: string): number {
  const lines = value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bulletLines = lines.filter((l) => /^([-*]|\d+[.)])\s+/.test(l));
  if (bulletLines.length >= 2) return bulletLines.length;
  return sentenceCount(value);
}

function wordCount(value: string): number {
  return (value.match(/\b\w+\b/g) ?? []).length;
}

function normalizeStr(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function descriptionIssues(description: string): string[] {
  if (!description.trim()) return ["plan.narratives.Description is required"];
  if (sentenceCount(description) < 2 || wordCount(description) < 20) {
    return ["plan.narratives.Description must contain at least two concrete sentences"];
  }
  return [];
}

function implementationPlanIssues(implementationPlan: string): string[] {
  if (!implementationPlan.trim()) return ["plan.narratives.ImplementationPlan is required"];
  const issues: string[] = [];
  if (stepCount(implementationPlan) < 2 || wordCount(implementationPlan) < 20) {
    issues.push("plan.narratives.ImplementationPlan must contain at least two concrete steps");
  }
  const lower = implementationPlan.toLowerCase();
  if (PLACEHOLDER_ACCEPTANCE_PATTERNS.some((p) => lower.includes(p))) {
    issues.push("plan.narratives.ImplementationPlan must not be placeholder text");
  }
  if (
    GENERIC_IMPLEMENTATION_PATTERNS.some((p) => lower.includes(p)) ||
    !(
      CODE_PATH_TERMS.some((t) => lower.includes(t)) &&
      VERIFY_EVIDENCE_TERMS.some((t) => lower.includes(t))
    )
  ) {
    issues.push(
      "plan.narratives.ImplementationPlan must identify concrete code paths and verification evidence",
    );
  }
  return issues;
}

function fileScopeIssues(swarm: JsonObj): string[] {
  const issues: string[] = [];
  for (const filePath of asStrList(swarm.file_scope)) {
    const normalized = filePath.trim().replace(/^\/+|\/+$/g, "");
    const root = normalized.split("/")[0] ?? "";
    if (
      /[*?[]/.test(normalized) ||
      BROAD_FILE_SCOPE_ROOTS.has(normalized) ||
      filePath.replace(/\/$/, "") in BROAD_FILE_SCOPE_ROOTS ||
      (BROAD_FILE_SCOPE_ROOTS.has(root) && (normalized === root || normalized === `${root}/*`))
    ) {
      issues.push(`broad file_scope is not swarm-ready: ${filePath}`);
    }
  }
  return issues;
}

function verifyCommandIssues(swarm: JsonObj): string[] {
  const commands = asStrList(swarm.verify_commands).map((c) => c.toLowerCase());
  if (commands.length === 1 && GENERIC_VERIFY_COMMANDS.has(normalizeCommand(commands[0] ?? ""))) {
    return [`generic verify command is not swarm-ready: ${commands[0]}`];
  }
  return [];
}

export function storyQualityIssues(opts: {
  title: string;
  description: string;
  implementationPlan: string;
  userStory: string;
  acceptanceTexts: string[];
  acceptanceCountJustification: string;
  swarm: JsonObj;
  concurrentReady?: boolean;
}): string[] {
  const {
    title,
    description,
    implementationPlan,
    userStory,
    acceptanceTexts,
    acceptanceCountJustification,
    swarm,
    concurrentReady = true,
  } = opts;

  const issues: string[] = [];

  if (!USER_STORY_RE.test(userStory ?? "")) {
    issues.push("UserStory must match 'As a <role>, I want <capability>, so that <outcome>.'");
  }
  issues.push(...descriptionIssues(description));
  issues.push(...implementationPlanIssues(implementationPlan));

  if (
    !(acceptanceTexts.length >= 2 && acceptanceTexts.length <= 5) &&
    !acceptanceCountJustification.trim()
  ) {
    issues.push("2-5 acceptance criteria required unless justified");
  }

  const normalizedTitle = normalizeStr(title);
  const normalizedDescription = normalizeStr(description);

  for (const criterion of acceptanceTexts) {
    const lower = criterion.toLowerCase();
    const normalized = normalizeStr(criterion);
    if (PLACEHOLDER_ACCEPTANCE_PATTERNS.some((p) => lower.includes(p))) {
      issues.push("placeholder acceptance criterion");
    }
    if (normalized && (normalized === normalizedTitle || normalized === normalizedDescription)) {
      issues.push("acceptance criterion duplicates title or description");
    }
    if (DOCS_ONLY_ACCEPTANCE_PATTERNS.some((p) => lower.includes(p))) {
      issues.push("vague docs-only acceptance criterion");
    }
    if (wordCount(criterion) < 8 || VAGUE_ACCEPTANCE_PATTERNS.some((p) => lower.includes(p))) {
      issues.push("acceptance criterion must describe specific observable behavior");
    }
    if (!OBSERVABLE_TERMS.some((t) => lower.includes(t))) {
      issues.push("acceptance criterion must describe observable behavior");
    }
  }

  if (concurrentReady) {
    issues.push(...fileScopeIssues(swarm));
    issues.push(...verifyCommandIssues(swarm));
    if (swarm.parallel_safe === false) {
      issues.push(
        "readiness=ready requires parallel_safe=true; use readiness=sequential or needs_refinement for non-concurrent work",
      );
    }
    if (swarm.file_scope_confidence === "low") {
      issues.push("readiness=ready requires file_scope_confidence above low");
    }
  }

  return dedupe(issues);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function vbriefDir(projectRoot: string): string {
  return join(resolve(projectRoot), "vbrief");
}

function relToVbrief(vbriefDirPath: string, path: string): string {
  const resolvedPath = resolve(path);
  const resolvedVbrief = resolve(vbriefDirPath);
  if (resolvedPath.startsWith(`${resolvedVbrief}/`) || resolvedPath === resolvedVbrief) {
    return resolvedPath.slice(resolvedVbrief.length + 1).replace(/\\/g, "/");
  }
  throw new DecompositionError(`${path}: path must be inside ${vbriefDirPath}`);
}

function defaultStatusForFolderName(folderName: string): string {
  const map: Record<string, string> = {
    proposed: "proposed",
    pending: "pending",
    active: "running",
    completed: "completed",
    cancelled: "cancelled",
  };
  return map[folderName] ?? "pending";
}

function normalizeStatus(value: unknown, defaultStatus: string): string {
  if (value === null || value === undefined) return defaultStatus;
  const s = String(value).trim().toLowerCase();
  return s.length > 0 ? s : defaultStatus;
}

function isValidCreationDate(value: string): boolean {
  if (value.length !== 10) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Story extraction helpers
// ---------------------------------------------------------------------------

function storySpecs(draft: JsonObj): JsonObj[] {
  let stories = draft.stories ?? draft.children ?? [];
  if (typeof stories === "object" && stories !== null && !Array.isArray(stories)) {
    stories = Object.values(stories);
  }
  if (!Array.isArray(stories)) {
    throw new DecompositionError("draft must contain a stories array");
  }
  const normalized: JsonObj[] = [];
  for (let i = 0; i < stories.length; i += 1) {
    const story = stories[i];
    if (typeof story !== "object" || story === null || Array.isArray(story)) {
      throw new DecompositionError(`stories[${i + 1}] must be an object`);
    }
    normalized.push(story as JsonObj);
  }
  return normalized;
}

function storyId(story: JsonObj, index: number): string {
  const raw = story.id ?? story.story_id ?? story.key;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  const title = String(story.title ?? `story-${index}`);
  return slugify(title) || `story-${index}`;
}

function swarmMeta(story: JsonObj): JsonObj {
  const metadata =
    typeof story.metadata === "object" && story.metadata !== null && !Array.isArray(story.metadata)
      ? (story.metadata as JsonObj)
      : {};
  let swarm = story.swarm ?? (metadata as JsonObj).swarm ?? {};
  if (typeof swarm !== "object" || swarm === null || Array.isArray(swarm)) swarm = {};
  const swarmObj = swarm as JsonObj;
  for (const key of [
    "readiness",
    "parallel_safe",
    "file_scope",
    "verify_commands",
    "expected_outputs",
    "depends_on",
    "conflict_group",
    "size",
    "file_scope_confidence",
    "model_tier",
    "missing_traces_justification",
  ]) {
    if (key in story && !(key in swarmObj)) {
      swarmObj[key] = story[key];
    }
  }
  return swarmObj;
}

function storyHasTraces(story: JsonObj, items: unknown[], sw: JsonObj): boolean {
  const narratives = story.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const val = (narratives as JsonObj).Traces;
    if (typeof val === "string" && val.trim().length > 0) return true;
  }
  if (asStrList(story.traces).length > 0) return true;
  if (
    items.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        itemHasTraces(item as JsonObj),
    )
  )
    return true;
  if (asStrList(sw.missing_traces_justification).length > 0) return true;
  const refs = story.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
        if ((ref as JsonObj).type === "x-vbrief/spec-section") return true;
      }
    }
  }
  return false;
}

function storyDescription(story: JsonObj): string {
  const narratives = story.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const val = (narratives as JsonObj).Description;
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  for (const key of ["description", "summary"]) {
    const val = story[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return "";
}

function storyImplementationPlan(story: JsonObj): string {
  const narratives = story.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const val = (narratives as JsonObj).ImplementationPlan;
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  for (const key of ["implementation_plan", "ImplementationPlan"]) {
    const values = asStrList(story[key]);
    if (values.length > 0) return values.join("\n");
  }
  return "";
}

function storyUserStory(story: JsonObj): string {
  const narratives = story.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const val = (narratives as JsonObj).UserStory;
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  for (const key of ["user_story", "UserStory"]) {
    const val = story[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return "";
}

function acceptanceCountJustification(story: JsonObj, sw: JsonObj): string {
  for (const val of [
    sw.acceptance_criteria_justification,
    story.acceptance_criteria_justification,
  ]) {
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  const narratives = story.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const val = (narratives as JsonObj).AcceptanceJustification;
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return "";
}

function itemsFromStory(stId: string, story: JsonObj): JsonObj[] {
  const items = story.items;
  if (Array.isArray(items) && items.length > 0) return items as JsonObj[];
  const acceptance = [...asStrList(story.acceptance), ...asStrList(story.acceptance_items)];
  const traces = asStrList(story.traces).join(", ");
  return acceptance.map((criterion, i) => {
    const narrative: JsonObj = { Acceptance: criterion };
    if (traces.length > 0) narrative.Traces = traces;
    return {
      id: `${stId}-a${i + 1}`,
      title: criterion,
      status: "pending",
      narrative,
    };
  });
}

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

function validateDag(storyIds: string[], depsByStory: Record<string, string[]>): void {
  const known = new Set(storyIds);
  for (const [id, deps] of Object.entries(depsByStory)) {
    for (const dep of deps) {
      if (!known.has(dep)) {
        throw new DecompositionError(`${id}: depends_on references unknown story '${dep}'`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...(start >= 0 ? path.slice(start) : path), id].join(" -> ");
      throw new DecompositionError(`dependency cycle detected: ${cycle}`);
    }
    visiting.add(id);
    for (const dep of depsByStory[id] ?? []) {
      visit(dep, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of storyIds) visit(id, []);
}

// ---------------------------------------------------------------------------
// validate_draft
// ---------------------------------------------------------------------------

export function validateDraft(stories: JsonObj[]): string[] {
  const storyIds: string[] = [];
  const depsByStory: Record<string, string[]> = {};
  const seen = new Set<string>();

  for (let i = 0; i < stories.length; i += 1) {
    const story = stories[i]!;
    const id = storyId(story, i + 1);
    if (seen.has(id)) {
      throw new DecompositionError(`duplicate story id '${id}'`);
    }
    seen.add(id);
    storyIds.push(id);
    const sw = swarmMeta(story);
    const deps = asStrList(sw.depends_on ?? story.depends_on);
    depsByStory[id] = deps;

    const items = itemsFromStory(id, story);
    const description = storyDescription(story);
    const implementationPlan = storyImplementationPlan(story);
    const userStory = storyUserStory(story);

    const issues: string[] = [];

    const rawId = story.id ?? story.story_id ?? story.key;
    if (typeof rawId !== "string" || !rawId.trim()) issues.push("id");

    const rawTitle = story.title;
    if (typeof rawTitle !== "string" || !rawTitle.trim()) issues.push("title");

    if (!description) issues.push("plan.narratives.Description");
    if (!implementationPlan) issues.push("plan.narratives.ImplementationPlan");
    if (!userStory) issues.push("plan.narratives.UserStory");

    const readiness = sw.readiness;
    if (!STORY_READINESS_STATES.has(String(readiness ?? ""))) {
      issues.push("plan.metadata.swarm.readiness");
    }
    const parallelSafe = sw.parallel_safe;
    if (parallelSafe !== true && parallelSafe !== false) {
      issues.push("plan.metadata.swarm.parallel_safe");
    }
    if (items.length === 0) issues.push("plan.items");
    if (items.length > 0 && !itemsHaveAcceptance(items)) {
      issues.push("plan.items[].narrative.Acceptance");
    }
    issues.push(...deprecatedSubitemsIssues(items));
    issues.push(...missingRequiredSwarmFields(sw));
    if (!storyHasTraces(story, items, sw)) {
      issues.push("Traces or missing_traces_justification");
    }
    issues.push(
      ...storyQualityIssues({
        title: String(story.title ?? id),
        description,
        implementationPlan,
        userStory,
        acceptanceTexts: acceptanceTextsFromItems(items),
        acceptanceCountJustification: acceptanceCountJustification(story, sw),
        swarm: sw,
        concurrentReady: readiness === READY,
      }),
    );

    if (issues.length > 0) {
      throw new DecompositionError(`${id}: story invalid: ${issues.join(", ")}`);
    }
  }

  validateDag(storyIds, depsByStory);
  return storyIds;
}

// ---------------------------------------------------------------------------
// Reference normalization
// ---------------------------------------------------------------------------

function normalizeReferences(refs: unknown): JsonObj[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .filter((ref) => typeof ref === "object" && ref !== null && !Array.isArray(ref))
    .map((ref) => referenceWithDefaultTrust(ref as JsonObj));
}

function childProvenanceReferences(refs: unknown): JsonObj[] {
  return normalizeReferences(refs).filter(
    (ref) =>
      !String(ref.type ?? "")
        .toLowerCase()
        .includes("acceptance"),
  );
}

function dedupeReferences(refs: JsonObj[]): JsonObj[] {
  const out: JsonObj[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${String(ref.uri ?? ref.url ?? "")}|${String(ref.type ?? "")}|${String(ref.title ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build child vBRIEF
// ---------------------------------------------------------------------------

function storyNarratives(story: JsonObj): Record<string, string> {
  const narratives: Record<string, string> = {};
  const raw = story.narratives;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as JsonObj)) {
      if (typeof v === "string" && v.trim().length > 0) narratives[k] = v.trim();
    }
  }
  for (const [draftKey, narrativeKey] of [
    ["description", "Description"],
    ["summary", "Description"],
    ["implementation_plan", "ImplementationPlan"],
    ["ImplementationPlan", "ImplementationPlan"],
    ["user_story", "UserStory"],
    ["UserStory", "UserStory"],
    ["traces", "Traces"],
  ] as const) {
    if (narrativeKey in narratives) continue;
    const values = asStrList(story[draftKey]);
    if (values.length > 0) {
      const sep = narrativeKey === "ImplementationPlan" ? "\n" : ", ";
      narratives[narrativeKey] = values.join(sep);
    }
  }
  return narratives;
}

function childFilename(story: JsonObj, stId: string, title: string, date: string): string {
  const fn = story.filename;
  if (typeof fn === "string" && fn.endsWith(".vbrief.json")) return fn;
  const sl = slugify(title) || slugify(stId) || "story";
  return `${date}-${sl}.vbrief.json`;
}

function buildChildVbrief(opts: {
  story: JsonObj;
  storyId: string;
  storyIndex: number;
  parent: JsonObj;
  parentRel: string;
  status: string;
}): JsonObj {
  const { story, storyId: stId, storyIndex, parent, parentRel, status } = opts;
  const title = String(story.title ?? stId);
  const sw = swarmMeta(story);
  const items = itemsFromStory(stId, story);
  const metadata: JsonObj =
    typeof story.metadata === "object" && story.metadata !== null && !Array.isArray(story.metadata)
      ? { ...(story.metadata as JsonObj) }
      : {};
  metadata.kind = "story";
  metadata.swarm = sw;

  const parentPlan =
    typeof parent.plan === "object" && parent.plan !== null && !Array.isArray(parent.plan)
      ? (parent.plan as JsonObj)
      : {};
  const parentRefs = childProvenanceReferences(parentPlan.references);
  const storyRefs = normalizeReferences(story.references);

  return {
    vBRIEFInfo: {
      version: EMITTED_VBRIEF_VERSION,
      description: `Story vBRIEF ${storyIndex} decomposed from ${parentRel}`,
    },
    plan: {
      id: stId,
      title,
      status,
      planRef: parentRel,
      narratives: storyNarratives(story),
      items,
      metadata,
      references: dedupeReferences([...parentRefs, ...storyRefs]),
    },
  };
}

// ---------------------------------------------------------------------------
// apply_decomposition
// ---------------------------------------------------------------------------

export interface ApplyDecompositionOptions {
  projectRoot: string;
  parentPath: string;
  draftPath: string;
  checkOnly: boolean;
  date: string;
}

export function applyDecomposition(opts: ApplyDecompositionOptions): string[] {
  const { projectRoot, parentPath, draftPath, checkOnly, date } = opts;
  const vbriefDirPath = vbriefDir(projectRoot);

  const parent = loadJson(parentPath);
  const draft = loadJson(draftPath);
  const stories = storySpecs(draft);
  const stIds = validateDraft(stories);

  let outputDir: string;
  const draftOutputDir = draft.output_dir;
  if (typeof draftOutputDir === "string" && draftOutputDir.trim().length > 0) {
    outputDir = isAbsolute(draftOutputDir.trim())
      ? draftOutputDir.trim()
      : join(projectRoot, draftOutputDir.trim());
  } else {
    outputDir = join(vbriefDirPath, "pending");
  }
  outputDir = resolve(outputDir);

  const outputFolderName = basename(outputDir);
  if (!LIFECYCLE_FOLDERS.has(outputFolderName)) {
    throw new DecompositionError("output_dir must be a vbrief lifecycle folder");
  }
  if (!outputDir.startsWith(`${resolve(vbriefDirPath)}/`) && outputDir !== resolve(vbriefDirPath)) {
    throw new DecompositionError("output_dir must be inside vbrief/");
  }
  if (outputFolderName === "active") {
    throw new DecompositionError(
      "output_dir must not be vbrief/active; write pending stories and use task scope:activate when work begins",
    );
  }

  const status = normalizeStatus(draft.status, defaultStatusForFolderName(outputFolderName));
  if (ACTIVE_DECOMPOSITION_STATUSES.has(status)) {
    throw new DecompositionError(
      "decomposition cannot create active/running child stories; write pending stories and use task scope:activate when work begins",
    );
  }

  const parentRel = relToVbrief(vbriefDirPath, parentPath);
  const actions: string[] = [`VALIDATED ${stories.length} story decomposition draft`];

  const childPaths: Array<{ target: string; storyId: string; title: string }> = [];
  const childDocs: JsonObj[] = [];

  for (let i = 0; i < stories.length; i += 1) {
    const story = stories[i]!;
    const stId = stIds[i]!;
    const title = String(story.title ?? stId);
    const storyStatus = normalizeStatus(story.status, status);
    if (ACTIVE_DECOMPOSITION_STATUSES.has(storyStatus)) {
      throw new DecompositionError(
        `${stId}: decomposition cannot create active/running child stories; write pending stories and use task scope:activate when work begins`,
      );
    }
    const filename = childFilename(story, stId, title, date);
    const target = join(outputDir, filename);
    if (!checkOnly && existsSync(target)) {
      throw new DecompositionError(
        `${target}: child story path already exists; overwriting is not supported`,
      );
    }
    const child = buildChildVbrief({
      story,
      storyId: stId,
      storyIndex: i + 1,
      parent,
      parentRel,
      status: storyStatus,
    });
    childPaths.push({ target, storyId: stId, title });
    childDocs.push(child);
    const verb = checkOnly ? "CHECK" : "CREATE";
    actions.push(`${verb} ${relToVbrief(vbriefDirPath, target)}`);
  }

  if (checkOnly) return actions;

  for (const { target } of childPaths) {
    mkdirSync(dirname(target), { recursive: true });
  }
  for (let i = 0; i < childPaths.length; i += 1) {
    // biome-ignore lint/style/noNonNullAssertion: loop bound ensures these exist
    writeJson(childPaths[i]!.target, childDocs[i]!);
  }

  let parentPlan = parent.plan;
  if (parentPlan === null || parentPlan === undefined) {
    parentPlan = {};
    parent.plan = parentPlan;
  }
  if (typeof parentPlan !== "object" || Array.isArray(parentPlan)) {
    throw new DecompositionError(`${parentPath}: plan must be an object`);
  }
  const planObj = parentPlan as JsonObj;
  let metadata = planObj.metadata;
  if (metadata === null || metadata === undefined) {
    metadata = {};
    planObj.metadata = metadata;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new DecompositionError(`${parentPath}: plan.metadata must be an object`);
  }
  const metaObj = metadata as JsonObj;
  if (!metaObj.kind) metaObj.kind = "epic";

  let references = planObj.references;
  if (references === null || references === undefined) {
    references = [];
    planObj.references = references;
  }
  if (!Array.isArray(references)) {
    throw new DecompositionError(`${parentPath}: plan.references must be an array`);
  }

  for (const { target, title } of childPaths) {
    (references as JsonObj[]).push(
      referenceWithDefaultTrust({
        uri: relToVbrief(vbriefDirPath, target),
        type: "x-vbrief/plan",
        title,
      }),
    );
  }
  planObj.references = dedupeReferences(
    (references as unknown[])
      .filter((r) => typeof r === "object" && r !== null && !Array.isArray(r))
      .map((r) => r as JsonObj),
  );

  writeJson(parentPath, parent);
  actions.push(`UPDATE ${parentRel} references`);
  return actions;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseDecomposeArgs(argv: string[]): {
  parent?: string;
  draft?: string;
  check: boolean;
  date?: string;
  projectRoot: string;
  error?: string;
} {
  let parent: string | undefined;
  let draft: string | undefined;
  let check = false;
  let date: string | undefined;
  let projectRoot = ".";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--draft") {
      draft = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--draft=")) {
      draft = arg.slice("--draft=".length);
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--date") {
      date = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--date=")) {
      date = arg.slice("--date=".length);
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (!arg?.startsWith("-") && parent === undefined) {
      parent = arg;
    } else {
      return { check, projectRoot, error: `unrecognized argument: ${arg}` };
    }
  }
  return { parent, draft, check, date, projectRoot };
}

/** CLI entry for scope-decompose (mirrors scope_decompose.py main()). */
export function decomposeMain(argv: string[]): number {
  const parsed = parseDecomposeArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`ERROR: ${parsed.error}\n`);
    return 2;
  }

  const { parent, draft, check, projectRoot } = parsed;
  const projRoot = resolve(projectRoot);

  if (parent === undefined && draft === undefined) {
    if (check) {
      process.stdout.write("OK no decomposition draft supplied; nothing to apply.\n");
      return 0;
    }
    process.stderr.write("ERROR: parent path and --draft are required\n");
    return 2;
  }
  if (parent === undefined || draft === undefined) {
    process.stderr.write("ERROR: parent path and --draft are required\n");
    return 2;
  }

  const parentPath = isAbsolute(parent) ? parent : join(projRoot, parent);
  const draftPath = isAbsolute(draft) ? draft : join(projRoot, draft);

  if (!existsSync(parentPath)) {
    process.stderr.write(`ERROR: parent vBRIEF not found: ${parentPath}\n`);
    return 2;
  }
  if (!existsSync(draftPath)) {
    process.stderr.write(`ERROR: decomposition draft not found: ${draftPath}\n`);
    return 2;
  }

  const dateStr = parsed.date ?? new Date().toISOString().slice(0, 10);
  if (!isValidCreationDate(dateStr)) {
    process.stderr.write(`ERROR: --date must be YYYY-MM-DD, got '${dateStr}'\n`);
    return 2;
  }

  if (!check) {
    try {
      accessSync(parentPath, constants.W_OK);
    } catch {
      process.stderr.write(`ERROR: parent vBRIEF is not writable: ${parentPath}\n`);
      return 2;
    }
  }

  try {
    const actions = applyDecomposition({
      projectRoot: projRoot,
      parentPath: resolve(parentPath),
      draftPath: resolve(draftPath),
      checkOnly: check,
      date: dateStr,
    });
    for (const action of actions) {
      process.stdout.write(`${action}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof DecompositionError) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`ERROR: ${String(err)}\n`);
    return 1;
  }
}
