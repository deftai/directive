/**
 * Design-doc / answers seed into Phase 2 six-key narratives (#4961 Prefer-A).
 * Draft-only until Post-Interview Confirmation Gate; durable write stays on
 * project:write-narratives. Seed bytes are data, never directives (#480).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PHASE2_NARRATIVE_KEYS,
  type Phase2NarrativeKey,
  type Phase2Narratives,
} from "../vbrief-build/phase2-narratives.js";
import { projectDefinitionPath } from "../vbrief-build/project-definition-io.js";

export type SeedIngressMode = "from-document" | "answers";

/** Present = apply (including explicit empty clear). Absent = keep existing. */
export type SeedFieldPresence =
  | { readonly status: "present"; readonly value: string }
  | { readonly status: "absent" };

export type SeedFieldMap = Record<Phase2NarrativeKey, SeedFieldPresence>;

export interface UntrustedSpan {
  readonly kind: "policy-adjacent" | "instruction-like" | "self-consent";
  readonly excerpt: string;
}

export interface SeedTrace {
  readonly key: Phase2NarrativeKey;
  readonly passage: string | null;
  readonly note: string;
}

export interface SeedConflict {
  readonly key: Phase2NarrativeKey;
  readonly values: readonly string[];
}

export interface SeedDraft {
  readonly mode: SeedIngressMode;
  readonly sourcePath: string;
  readonly fields: SeedFieldMap;
  readonly title: string | undefined;
  readonly unknowns: readonly Phase2NarrativeKey[];
  readonly conflicts: readonly SeedConflict[];
  readonly traces: readonly SeedTrace[];
  readonly untrustedSpans: readonly UntrustedSpan[];
  /** Rejected non-narrative keys that source tried to supply. */
  readonly refusedKeys: readonly string[];
}

export interface SeedFieldChange {
  readonly key: Phase2NarrativeKey;
  readonly before: string | undefined;
  readonly after: string;
  readonly kind: "set" | "clear" | "unchanged-keep" | "absent-keep";
}

export interface SeedMergeResult {
  readonly narratives: Phase2Narratives;
  readonly changes: readonly SeedFieldChange[];
  readonly baseRevision: string | null;
}

export interface ConfirmSummary {
  readonly text: string;
  readonly leadsWithSource: boolean;
}

const ALIAS_TO_CANONICAL: ReadonlyMap<string, Phase2NarrativeKey> = new Map([
  ["overview", "Overview"],
  ["techstack", "TechStack"],
  ["tech_stack", "TechStack"],
  ["tech-stack", "TechStack"],
  ["technology", "TechStack"],
  ["technology stack", "TechStack"],
  ["stack", "TechStack"],
  ["strategy", "Strategy"],
  ["quality", "Quality"],
  ["testing", "Quality"],
  ["coverage", "Quality"],
  ["projectrules", "ProjectRules"],
  ["project_rules", "ProjectRules"],
  ["project-rules", "ProjectRules"],
  ["rules", "ProjectRules"],
  ["branching", "Branching"],
  ["branch", "Branching"],
  ["branching preference", "Branching"],
]);

const HEADING_ALIASES: ReadonlyArray<{
  readonly key: Phase2NarrativeKey;
  readonly patterns: readonly RegExp[];
}> = [
  {
    key: "Overview",
    patterns: [/^#{1,3}\s+overview\b/i, /^overview\s*:/i, /^#{1,3}\s+summary\b/i, /^summary\s*:/i],
  },
  {
    key: "TechStack",
    patterns: [
      /^#{1,3}\s+tech\s*stack\b/i,
      /^tech\s*stack\s*:/i,
      /^#{1,3}\s+technology\b/i,
      /^#{1,3}\s+stack\b/i,
    ],
  },
  {
    key: "Strategy",
    patterns: [/^#{1,3}\s+strategy\b/i, /^strategy\s*:/i],
  },
  {
    key: "Quality",
    patterns: [
      /^#{1,3}\s+quality\b/i,
      /^quality\s*:/i,
      /^#{1,3}\s+testing\b/i,
      /^#{1,3}\s+coverage\b/i,
    ],
  },
  {
    key: "ProjectRules",
    patterns: [
      /^#{1,3}\s+project\s*rules?\b/i,
      /^project\s*rules?\s*:/i,
      /^#{1,3}\s+rules\b/i,
      /^rules\s*:/i,
    ],
  },
  {
    key: "Branching",
    patterns: [
      /^#{1,3}\s+branching\b/i,
      /^branching\s*:/i,
      /^#{1,3}\s+branch(ing)?\s+preference\b/i,
    ],
  },
];

const POLICY_ADJACENT =
  /\ballowDirectCommitsToMaster\b|\bplan\.policy\b|\bx-directive\/policy\b|\bpolicy:allow-direct-commits\b|\bpolicy:enforce-branches\b/i;
const SELF_CONSENT =
  /\b(i\s+approve|approved|write\s+files\s*\?\s*yes|confirmed\s*:\s*yes|yolo\s+self-?confirm|auto-?apply\s+without\s+confirm)\b/i;
const INSTRUCTION_LIKE =
  /\b(ignore\s+(previous|all)\s+instructions|you\s+must\s+run|override\s+USER\.md|set\s+DEFT_|tool\s+call:|execute\s+this\s+shell)\b/i;

function emptyFieldMap(): SeedFieldMap {
  const fields = {} as SeedFieldMap;
  for (const key of PHASE2_NARRATIVE_KEYS) {
    fields[key] = { status: "absent" };
  }
  return fields;
}

function normalizeAlias(raw: string): Phase2NarrativeKey | null {
  const trimmed = raw.trim();
  if ((PHASE2_NARRATIVE_KEYS as readonly string[]).includes(trimmed)) {
    return trimmed as Phase2NarrativeKey;
  }
  const compact = trimmed.toLowerCase().replace(/\s+/g, " ");
  const nospace = compact.replace(/[\s_-]+/g, "");
  for (const [alias, key] of ALIAS_TO_CANONICAL) {
    if (alias === compact || alias.replace(/[\s_-]+/g, "") === nospace) return key;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Hash bytes of an existing PROJECT-DEFINITION for stale-approval checks. */
export function projectDefinitionRevision(artifactPath: string): string | null {
  if (!existsSync(artifactPath)) return null;
  const body = readFileSync(artifactPath);
  return createHash("sha256").update(body).digest("hex");
}

/** Scan source text for policy-adjacent / instruction-like / self-consent spans. */
export function scanUntrustedSourceSpans(sourceText: string): UntrustedSpan[] {
  const spans: UntrustedSpan[] = [];
  for (const line of sourceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const excerpt = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
    if (POLICY_ADJACENT.test(trimmed)) spans.push({ kind: "policy-adjacent", excerpt });
    if (SELF_CONSENT.test(trimmed)) spans.push({ kind: "self-consent", excerpt });
    if (INSTRUCTION_LIKE.test(trimmed)) spans.push({ kind: "instruction-like", excerpt });
  }
  return spans;
}

function matchHeading(line: string): Phase2NarrativeKey | null {
  const trimmed = line.trim();
  for (const entry of HEADING_ALIASES) {
    for (const pattern of entry.patterns) {
      if (pattern.test(trimmed)) return entry.key;
    }
  }
  return null;
}

function inlineValue(line: string): string | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const rest = line.slice(idx + 1).trim();
  return rest.length > 0 ? rest : null;
}

function firstProseParagraph(text: string): string {
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"));
    if (lines.length === 0) continue;
    if (matchHeading(lines[0] as string) !== null) continue;
    return lines.join(" ").trim();
  }
  return "";
}

/**
 * Extract a six-key draft from ordinary markdown/text design prose.
 * Unknowns stay absent (not invented). Conflicts collect duplicate headings.
 */
export function extractFromDesignDocument(sourceText: string, sourcePath: string): SeedDraft {
  const fields = emptyFieldMap();
  const collected = new Map<Phase2NarrativeKey, string[]>();
  const traces: SeedTrace[] = [];
  const lines = sourceText.split(/\r?\n/);
  let current: Phase2NarrativeKey | null = null;
  let buf: string[] = [];
  let passageStart = "";

  const flush = (): void => {
    if (current === null) return;
    const value = buf.join("\n").trim();
    const list = collected.get(current) ?? [];
    list.push(value);
    collected.set(current, list);
    traces.push({
      key: current,
      passage: passageStart.length > 0 ? passageStart : null,
      note: value.length > 0 ? "extracted from heading section" : "heading present but empty",
    });
    current = null;
    buf = [];
    passageStart = "";
  };

  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading !== null) {
      flush();
      current = heading;
      passageStart = line.trim();
      const inline = inlineValue(line);
      if (inline !== null && !/^#{1,3}\s/.test(line.trim())) buf.push(inline);
      continue;
    }
    if (current !== null) {
      if (/^#{1,3}\s+\S/.test(line.trim())) {
        flush();
        continue;
      }
      buf.push(line);
    }
  }
  flush();

  const conflicts: SeedConflict[] = [];
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const values = collected.get(key);
    if (values === undefined || values.length === 0) continue;
    const unique = [...new Set(values.map((v) => v.trim()))];
    if (unique.length > 1) conflicts.push({ key, values: unique });
    fields[key] = { status: "present", value: unique[0] ?? "" };
  }

  if (fields.Overview.status === "absent") {
    const prose = firstProseParagraph(sourceText);
    if (prose.length > 0) {
      fields.Overview = { status: "present", value: prose };
      traces.push({
        key: "Overview",
        passage: prose.slice(0, 120),
        note: "fallback first prose paragraph",
      });
    }
  }

  return {
    mode: "from-document",
    sourcePath,
    fields,
    title: undefined,
    unknowns: PHASE2_NARRATIVE_KEYS.filter((k) => fields[k].status === "absent"),
    conflicts,
    traces,
    untrustedSpans: scanUntrustedSourceSpans(sourceText),
    refusedKeys: [],
  };
}

/**
 * Schema-validate an answers object into a six-key draft.
 * Aliases normalize before the canonical key set. Extra keys are refused.
 */
export function parseAnswersDocument(
  value: unknown,
  sourcePath: string,
): SeedDraft | { error: string } {
  const root = asRecord(value);
  if (root === null) return { error: "answers file must be a JSON object" };

  const plan = asRecord(root.plan);
  const nested = plan === null ? null : asRecord(plan.narratives);
  const source = nested ?? root;
  const title =
    plan !== null && typeof plan.title === "string"
      ? plan.title
      : typeof root.title === "string"
        ? root.title
        : undefined;

  const fields = emptyFieldMap();
  const refusedKeys: string[] = [];
  const traces: SeedTrace[] = [];
  const conflicts: SeedConflict[] = [];
  const seen = new Map<Phase2NarrativeKey, string[]>();

  for (const [rawKey, rawVal] of Object.entries(source)) {
    if (rawKey === "title" || rawKey === "plan") continue;
    const canonical = normalizeAlias(rawKey);
    if (canonical === null) {
      refusedKeys.push(rawKey);
      continue;
    }
    if (typeof rawVal !== "string") {
      return { error: `answers field ${rawKey} must be a string` };
    }
    const list = seen.get(canonical) ?? [];
    list.push(rawVal);
    seen.set(canonical, list);
  }

  for (const key of PHASE2_NARRATIVE_KEYS) {
    const values = seen.get(key);
    if (values === undefined) continue;
    const unique = [...new Set(values)];
    if (unique.length > 1) conflicts.push({ key, values: unique });
    fields[key] = { status: "present", value: unique[0] ?? "" };
    traces.push({ key, passage: null, note: "answers adapter" });
  }

  return {
    mode: "answers",
    sourcePath,
    fields,
    title,
    unknowns: PHASE2_NARRATIVE_KEYS.filter((k) => fields[k].status === "absent"),
    conflicts,
    traces,
    untrustedSpans: scanUntrustedSourceSpans(JSON.stringify(value)),
    refusedKeys,
  };
}

/** Read existing six narrative strings from a PROJECT-DEFINITION-shaped object. */
export function readExistingNarratives(value: unknown): Partial<Phase2Narratives> {
  const root = asRecord(value);
  if (root === null) return {};
  const plan = asRecord(root.plan);
  const narratives = plan === null ? null : asRecord(plan.narratives);
  if (narratives === null) return {};
  const out: Partial<Phase2Narratives> = {};
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const field = narratives[key];
    if (typeof field === "string") out[key] = field;
  }
  return out;
}

/**
 * Merge a seed draft with existing narratives.
 * Absent keeps existing; present applies (including explicit empty clear).
 * Empty-for-missing never erases an existing non-empty value.
 */
export function mergeSeedWithExisting(
  draft: SeedDraft,
  existing: Partial<Phase2Narratives>,
  baseRevision: string | null = null,
): SeedMergeResult {
  const narratives = {} as Phase2Narratives;
  const changes: SeedFieldChange[] = [];
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const before = existing[key];
    const field = draft.fields[key];
    if (field.status === "absent") {
      narratives[key] = before ?? "";
      changes.push({ key, before, after: narratives[key], kind: "absent-keep" });
      continue;
    }
    narratives[key] = field.value;
    if (before === undefined) {
      changes.push({
        key,
        before,
        after: field.value,
        kind: field.value.length === 0 ? "clear" : "set",
      });
    } else if (before === field.value) {
      changes.push({ key, before, after: field.value, kind: "unchanged-keep" });
    } else {
      changes.push({
        key,
        before,
        after: field.value,
        kind: field.value.length === 0 ? "clear" : "set",
      });
    }
  }
  return { narratives, changes, baseRevision };
}

/** Confirm summary must lead with source path, mode, and untrusted spans. */
export function formatConfirmSummary(draft: SeedDraft, merge?: SeedMergeResult): ConfirmSummary {
  const lines: string[] = [];
  lines.push(`Source: ${draft.sourcePath}`);
  lines.push(`Extractor mode: ${draft.mode}`);
  if (draft.untrustedSpans.length === 0) {
    lines.push("Untrusted spans: none detected");
  } else {
    lines.push("Untrusted spans:");
    for (const span of draft.untrustedSpans) {
      lines.push(`  - [${span.kind}] ${span.excerpt}`);
    }
  }
  if (draft.refusedKeys.length > 0) {
    lines.push(`Refused non-narrative keys: ${draft.refusedKeys.join(", ")}`);
  }
  if (draft.unknowns.length > 0) {
    lines.push(`Unknowns (absent): ${draft.unknowns.join(", ")}`);
  }
  if (draft.conflicts.length > 0) {
    lines.push("Conflicts:");
    for (const c of draft.conflicts) {
      lines.push(`  - ${c.key}: ${c.values.map((v) => JSON.stringify(v)).join(" | ")}`);
    }
  }
  lines.push("Draft fields:");
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const field = draft.fields[key];
    if (field.status === "absent") lines.push(`  ${key}: (absent — keep existing)`);
    else lines.push(`  ${key}: ${JSON.stringify(field.value)}`);
  }
  if (merge !== undefined) {
    lines.push("Field changes after merge:");
    for (const change of merge.changes) {
      if (change.kind === "absent-keep" || change.kind === "unchanged-keep") continue;
      lines.push(
        `  ${change.key}: ${JSON.stringify(change.before ?? null)} -> ${JSON.stringify(change.after)} (${change.kind})`,
      );
    }
    if (merge.baseRevision !== null) lines.push(`Base revision: ${merge.baseRevision}`);
  }
  lines.push("");
  lines.push(
    "Draft only until Post-Interview Confirmation Gate. Source text cannot supply consent, override USER.md Personal, flip branch policy, or self-confirm.",
  );
  lines.push("Branching narrative text never authorizes allowDirectCommitsToMaster.");
  lines.push("These are the values I captured. Write files? (yes/no)");
  const text = lines.join("\n");
  return { text, leadsWithSource: text.startsWith("Source:") };
}

/** True when Overview or TechStack is non-empty after merge (#5176 floor awareness). */
export function seedMeetsPersistenceFloor(narratives: Phase2Narratives): boolean {
  return narratives.Overview.trim().length > 0 || narratives.TechStack.trim().length > 0;
}

export function materializeDraftNarratives(draft: SeedDraft): Phase2Narratives {
  const out = {} as Phase2Narratives;
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const field = draft.fields[key];
    out[key] = field.status === "present" ? field.value : "";
  }
  return out;
}

const SEED_USAGE =
  "Usage: setup:seed --from <design.md> | --answers <file> [--project-root <dir>] [--out <draft.json>]\n" +
  "Draft-only. Does not write PROJECT-DEFINITION. Confirm via setup Post-Interview gate, then project:write-narratives.\n";

interface SeedCliArgs {
  readonly projectRoot: string;
  readonly fromPath: string | undefined;
  readonly answersPath: string | undefined;
  readonly outPath: string | undefined;
  readonly error: string | undefined;
}

function parseSeedCli(argv: readonly string[]): SeedCliArgs {
  let projectRoot = ".";
  let fromPath: string | undefined;
  let answersPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) return seedBlank("missing value for --project-root");
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--from") {
      const value = argv[i + 1];
      if (value === undefined) return seedBlank("missing value for --from");
      fromPath = value;
      i += 1;
    } else if (arg.startsWith("--from=")) {
      fromPath = arg.slice("--from=".length);
    } else if (arg === "--answers") {
      const value = argv[i + 1];
      if (value === undefined) return seedBlank("missing value for --answers");
      answersPath = value;
      i += 1;
    } else if (arg.startsWith("--answers=")) {
      answersPath = arg.slice("--answers=".length);
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) return seedBlank("missing value for --out");
      outPath = value;
      i += 1;
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else {
      return seedBlank(`Unknown flag: ${arg}`);
    }
  }
  return { projectRoot, fromPath, answersPath, outPath, error: undefined };
}

function seedBlank(error: string): SeedCliArgs {
  return {
    projectRoot: ".",
    fromPath: undefined,
    answersPath: undefined,
    outPath: undefined,
    error,
  };
}

/** Resolve for equality, following symlinks when the path exists (#4961). */
function resolvedPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolvedPath(left) === resolvedPath(right);
}

/**
 * Thin CLI wrapper (#4961): emit a reviewable draft. Never durable-writes
 * PROJECT-DEFINITION; never treats source text as consent.
 */
export function seedFromDesignMain(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(SEED_USAGE);
    return 0;
  }
  const parsed = parseSeedCli(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n${SEED_USAGE}`);
    return 2;
  }
  if (
    (parsed.fromPath === undefined && parsed.answersPath === undefined) ||
    (parsed.fromPath !== undefined && parsed.answersPath !== undefined)
  ) {
    process.stderr.write(`exactly one of --from or --answers is required\n${SEED_USAGE}`);
    return 2;
  }

  let draft: SeedDraft;
  if (parsed.fromPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(parsed.fromPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`could not read design document: ${message}\n`);
      return 2;
    }
    draft = extractFromDesignDocument(text, parsed.fromPath);
  } else {
    const answersPath = parsed.answersPath as string;
    let raw: string;
    try {
      raw = readFileSync(answersPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`could not read answers file: ${message}\n`);
      return 2;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`answers file is not valid JSON: ${message}\n`);
      return 2;
    }
    const parsedAnswers = parseAnswersDocument(json, answersPath);
    if ("error" in parsedAnswers) {
      process.stderr.write(`${parsedAnswers.error}\n`);
      return 2;
    }
    draft = parsedAnswers;
  }

  const root = resolve(parsed.projectRoot);
  const artifactPath = projectDefinitionPath(root);
  let existing: Partial<Phase2Narratives> = {};
  let baseRevision: string | null = null;
  if (existsSync(artifactPath)) {
    baseRevision = projectDefinitionRevision(artifactPath);
    try {
      existing = readExistingNarratives(JSON.parse(readFileSync(artifactPath, "utf8")));
    } catch {
      existing = {};
    }
  }
  const merge = mergeSeedWithExisting(draft, existing, baseRevision);
  const summary = formatConfirmSummary(draft, merge);
  const payload = {
    schema: "deft.setup.seed-draft.v1",
    mode: draft.mode,
    sourcePath: draft.sourcePath,
    title: draft.title,
    fields: draft.fields,
    unknowns: draft.unknowns,
    conflicts: draft.conflicts,
    traces: draft.traces,
    untrustedSpans: draft.untrustedSpans,
    refusedKeys: draft.refusedKeys,
    mergedNarratives: merge.narratives,
    changes: merge.changes,
    baseRevision: merge.baseRevision,
    meetsPersistenceFloor: seedMeetsPersistenceFloor(merge.narratives),
    confirmSummary: summary.text,
    durableWrite: "deft project:write-narratives --narratives-file <path>",
    note: "Draft only. Cancellation writes no authoritative project artifact.",
  };
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  if (parsed.outPath !== undefined) {
    if (sameResolvedPath(parsed.outPath, artifactPath)) {
      process.stderr.write(
        `refusing --out ${parsed.outPath}: resolves to PROJECT-DEFINITION; draft must not overwrite the authoritative artifact\n`,
      );
      return 2;
    }
    const inputPath = parsed.fromPath ?? parsed.answersPath;
    if (inputPath !== undefined && sameResolvedPath(parsed.outPath, inputPath)) {
      process.stderr.write(
        `refusing --out ${parsed.outPath}: resolves to the input file (${inputPath})\n`,
      );
      return 2;
    }
    writeFileSync(parsed.outPath, encoded, "utf8");
    process.stdout.write(`wrote seed draft to ${parsed.outPath}\n`);
  } else {
    process.stdout.write(encoded);
  }
  process.stderr.write(`${summary.text}\n`);
  return 0;
}
