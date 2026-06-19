import type { JsonObject } from "./types.js";

export const BROAD_FILE_SCOPE_ROOTS = new Set(["backend", "frontend", "docs", "vbrief"]);

export const CODE_PATH_TERMS = [
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
] as const;

export const VERIFY_EVIDENCE_TERMS = [
  "assert",
  "evidence",
  "fixture",
  "report",
  "spec",
  "test",
  "tests/",
  "verify",
] as const;

export const GENERIC_VERIFY_COMMANDS = new Set([
  "cargo test",
  "go test ./...",
  "npm run test",
  "npm test",
  "pytest",
  "task check",
]);

export const PLACEHOLDER_ACCEPTANCE_PATTERNS = [
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
] as const;

export const DOCS_ONLY_ACCEPTANCE_PATTERNS = [
  "docs updated",
  "documentation updated",
  "readme updated",
  "update docs",
  "update documentation",
  "update readme",
] as const;

export const GENERIC_IMPLEMENTATION_PATTERNS = [
  "add tests so it works",
  "change the code",
  "implement the feature",
  "make it work",
  "update the code",
  "works as expected",
] as const;

export const VAGUE_ACCEPTANCE_PATTERNS = [
  "displays a message",
  "handles errors",
  "is implemented",
  "is updated",
  "passes tests",
  "shows a message",
  "the system displays a message",
  "updates the ui",
  "works as expected",
] as const;

export const OBSERVABLE_TERMS = [
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
] as const;

const USER_STORY_RE = /^\s*As\s+a[n]?\s+[^,]+,\s*I\s+want\s+.+,\s*so\s+that\s+.+\.\s*$/is;

export function asStrList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  return [];
}

export function acceptanceTextsFromItems(items: unknown): string[] {
  const texts: string[] = [];
  if (!Array.isArray(items)) {
    return texts;
  }
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const obj = item as JsonObject;
    const narrative = obj.narrative;
    if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
      const acceptance = (narrative as JsonObject).Acceptance;
      if (typeof acceptance === "string" && acceptance.trim()) {
        texts.push(acceptance.trim());
      }
    }
    for (const childKey of ["items", "subItems"] as const) {
      texts.push(...acceptanceTextsFromItems(obj[childKey]));
    }
  }
  return texts;
}

export function itemHasAcceptance(item: JsonObject): boolean {
  const narrative = item.narrative;
  if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
    const value = (narrative as JsonObject).Acceptance;
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }
  for (const childKey of ["items", "subItems"] as const) {
    const children = item[childKey];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === "object" && child !== null && itemHasAcceptance(child as JsonObject)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function itemsHaveAcceptance(items: unknown): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  return items.some(
    (item) => typeof item === "object" && item !== null && itemHasAcceptance(item as JsonObject),
  );
}

export function itemHasTraces(item: JsonObject): boolean {
  const narrative = item.narrative;
  if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
    const value = (narrative as JsonObject).Traces;
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }
  for (const childKey of ["items", "subItems"] as const) {
    const children = item[childKey];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === "object" && child !== null && itemHasTraces(child as JsonObject)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function missingRequiredSwarmFields(swarm: JsonObject): string[] {
  const missing: string[] = [];
  for (const key of ["file_scope", "verify_commands", "expected_outputs"] as const) {
    if (asStrList(swarm[key]).length === 0) {
      missing.push(`plan.metadata.swarm.${key}`);
    }
  }
  if (!("depends_on" in swarm)) {
    missing.push("plan.metadata.swarm.depends_on");
  }
  for (const key of ["conflict_group", "size", "file_scope_confidence", "model_tier"] as const) {
    const value = swarm[key];
    if (typeof value !== "string" || !value.trim()) {
      missing.push(`plan.metadata.swarm.${key}`);
    }
  }
  return missing;
}

export function deprecatedSubitemsIssues(items: unknown, prefix = "plan.items"): string[] {
  const issues: string[] = [];
  const visit = (children: unknown, path: string): void => {
    if (!Array.isArray(children)) {
      return;
    }
    for (let index = 0; index < children.length; index += 1) {
      const item = children[index];
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const obj = item as JsonObject;
      const itemPath = `${path}[${index}]`;
      if ("subItems" in obj) {
        issues.push(`${itemPath}.subItems is deprecated; use items`);
      }
      visit(obj.items, `${itemPath}.items`);
      visit(obj.subItems, `${itemPath}.subItems`);
    }
  };
  visit(items, prefix);
  return issues;
}

export interface StoryQualityParams {
  readonly title: string;
  readonly description: string;
  readonly implementationPlan: string;
  readonly userStory: string;
  readonly acceptanceTexts: readonly string[];
  readonly acceptanceCountJustification: string;
  readonly swarm: JsonObject;
  readonly concurrentReady?: boolean;
}

export function storyQualityIssues(params: StoryQualityParams): string[] {
  const issues: string[] = [];
  const concurrentReady = params.concurrentReady ?? true;
  if (!USER_STORY_RE.test(params.userStory ?? "")) {
    issues.push("UserStory must match 'As a <role>, I want <capability>, so that <outcome>.'");
  }
  issues.push(...descriptionIssues(params.description));
  issues.push(...implementationPlanIssues(params.implementationPlan));
  if (
    !(params.acceptanceTexts.length >= 2 && params.acceptanceTexts.length <= 5) &&
    !params.acceptanceCountJustification.trim()
  ) {
    issues.push("2-5 acceptance criteria required unless justified");
  }
  const normalizedTitle = normalize(params.title);
  const normalizedDescription = normalize(params.description);
  for (const criterion of params.acceptanceTexts) {
    const normalized = normalize(criterion);
    const lower = criterion.toLowerCase();
    if (PLACEHOLDER_ACCEPTANCE_PATTERNS.some((pattern) => lower.includes(pattern))) {
      issues.push("placeholder acceptance criterion");
    }
    if (normalized && (normalized === normalizedTitle || normalized === normalizedDescription)) {
      issues.push("acceptance criterion duplicates title or description");
    }
    if (DOCS_ONLY_ACCEPTANCE_PATTERNS.some((pattern) => lower.includes(pattern))) {
      issues.push("vague docs-only acceptance criterion");
    }
    if (
      wordCount(criterion) < 8 ||
      VAGUE_ACCEPTANCE_PATTERNS.some((pattern) => lower.includes(pattern))
    ) {
      issues.push("acceptance criterion must describe specific observable behavior");
    }
    if (!looksObservable(lower)) {
      issues.push("acceptance criterion must describe observable behavior");
    }
  }
  if (concurrentReady) {
    issues.push(...fileScopeIssues(params.swarm));
    issues.push(...verifyCommandIssues(params.swarm));
    if (params.swarm.parallel_safe === false) {
      issues.push(
        "readiness=ready requires parallel_safe=true; use readiness=sequential or needs_refinement for non-concurrent work",
      );
    }
    if (params.swarm.file_scope_confidence === "low") {
      issues.push("readiness=ready requires file_scope_confidence above low");
    }
  }
  return dedupe(issues);
}

function fileScopeIssues(swarm: JsonObject): string[] {
  const issues: string[] = [];
  for (const filePath of asStrList(swarm.file_scope)) {
    const normalized = filePath.trim().replace(/^\/+|\/+$/g, "");
    const root = normalized.split("/", 1)[0] ?? "";
    if (
      /[*?[]/.test(normalized) ||
      BROAD_FILE_SCOPE_ROOTS.has(normalized) ||
      BROAD_FILE_SCOPE_ROOTS.has(filePath.replace(/\/+$/, "")) ||
      (BROAD_FILE_SCOPE_ROOTS.has(root) && (normalized === root || normalized === `${root}/*`))
    ) {
      issues.push(`broad file_scope is not swarm-ready: ${filePath}`);
    }
  }
  return issues;
}

function verifyCommandIssues(swarm: JsonObject): string[] {
  const commands = asStrList(swarm.verify_commands).map((command) => command.toLowerCase());
  if (commands.length === 1 && GENERIC_VERIFY_COMMANDS.has(normalizeCommand(commands[0] ?? ""))) {
    return [`generic verify command is not swarm-ready: ${commands[0]}`];
  }
  return [];
}

function descriptionIssues(description: string): string[] {
  if (!description.trim()) {
    return ["plan.narratives.Description is required"];
  }
  if (sentenceCount(description) < 2 || wordCount(description) < 20) {
    return ["plan.narratives.Description must contain at least two concrete sentences"];
  }
  return [];
}

function implementationPlanIssues(implementationPlan: string): string[] {
  if (!implementationPlan.trim()) {
    return ["plan.narratives.ImplementationPlan is required"];
  }
  const issues: string[] = [];
  if (stepCount(implementationPlan) < 2 || wordCount(implementationPlan) < 20) {
    issues.push("plan.narratives.ImplementationPlan must contain at least two concrete steps");
  }
  const lower = implementationPlan.toLowerCase();
  if (PLACEHOLDER_ACCEPTANCE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    issues.push("plan.narratives.ImplementationPlan must not be placeholder text");
  }
  if (
    GENERIC_IMPLEMENTATION_PATTERNS.some((pattern) => lower.includes(pattern)) ||
    !(
      CODE_PATH_TERMS.some((term) => lower.includes(term)) &&
      VERIFY_EVIDENCE_TERMS.some((term) => lower.includes(term))
    )
  ) {
    issues.push(
      "plan.narratives.ImplementationPlan must identify concrete code paths and verification evidence",
    );
  }
  return issues;
}

function looksObservable(lower: string): boolean {
  return OBSERVABLE_TERMS.some((term) => lower.includes(term));
}

function sentenceCount(value: string): number {
  return value
    .trim()
    .split(/[.!?]+(?:\s+|$)/)
    .filter((part) => part.trim().length > 0).length;
}

function stepCount(value: string): number {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletLines = lines.filter((line) => /^([-*]|\d+[.)])\s+/.test(line));
  if (bulletLines.length >= 2) {
    return bulletLines.length;
  }
  return sentenceCount(value);
}

function wordCount(value: string): number {
  const matches = value.match(/\b\w+\b/g);
  return matches?.length ?? 0;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
