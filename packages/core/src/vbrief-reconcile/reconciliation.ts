import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pyRepr } from "./py-repr.js";
import type {
  ConflictEntry,
  ReconciledItem,
  ReconciliationReport,
  SpecTaskEntry,
} from "./types.js";

const DONE_MARKERS = ["[done]", "[x]", "[X]", "\u2713", "\u2705"] as const;
const WIP_MARKERS = ["[wip]", "[in progress]", "[in-progress]", "[running]", "[active]"] as const;
const BLOCKED_MARKERS = ["[blocked]"] as const;
const CANCELLED_MARKERS = ["[cancelled]", "[canceled]"] as const;

export const OVERRIDES_FILENAME = "migration-overrides.yaml";

const GITHUB_ISSUE_REF_TYPES = new Set(["github-issue", "x-vbrief/github-issue"]);
const GITHUB_ISSUE_URI_RE = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/;

const PHASE_TITLE_RE = /^(Phase\s+\d|IP[-\s]\d|Milestone\s+\d)/i;

const STATUS_TO_FOLDER: Record<string, string> = {
  draft: "proposed",
  proposed: "proposed",
  approved: "pending",
  pending: "pending",
  running: "active",
  blocked: "active",
  completed: "completed",
  cancelled: "cancelled",
};

export function detectStatusMarker(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (CANCELLED_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return "cancelled";
  if (BLOCKED_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return "blocked";
  if (DONE_MARKERS.some((m) => text.includes(m) || lower.includes(m.toLowerCase())))
    return "completed";
  if (WIP_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return "running";
  return null;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "'" || v[0] === '"')) {
    return v.slice(1, -1);
  }
  return v;
}

function coerceScalar(value: string): unknown {
  const v = stripQuotes(value);
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  if (lower === "null" || lower === "none" || lower === "~" || lower === "") return null;
  return v;
}

export function parseOverridesYaml(text: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentTask: string | null = null;
  let currentTaskIndent = 0;
  let inOverrides = false;

  for (const rawLine of text.split("\n")) {
    // ReDoS-hardened (#1782 s4 / CodeQL js/polynomial-redos): replace the
    // `/\s+$/` trailing-strip with String.prototype.trimEnd(), which removes
    // exactly the JS `\s` set (WhiteSpace + LineTerminator) and so is
    // byte-identical to the prior regex while being linear-time. Mirrors the
    // Python oracle's `raw_line.rstrip()`.
    const line = rawLine.trimEnd();
    const stripped = line.trimStart();
    if (!stripped || stripped.startsWith("#")) continue;

    const indent = line.length - stripped.length;

    if (indent === 0) {
      const key = stripped.split(":", 1)[0]?.trim() ?? "";
      inOverrides = key === "overrides";
      currentTask = null;
      currentTaskIndent = 0;
      continue;
    }

    if (!inOverrides) continue;

    if (stripped.endsWith(":") && !stripped.slice(0, -1).includes(":") && indent >= 2) {
      currentTask = stripped.slice(0, -1).trim();
      currentTaskIndent = indent;
      if (!result[currentTask]) result[currentTask] = {};
      continue;
    }

    if (currentTask !== null && stripped.includes(":") && indent > currentTaskIndent) {
      const colonIdx = stripped.indexOf(":");
      const key = stripped.slice(0, colonIdx).trim();
      const value = stripped.slice(colonIdx + 1);
      const bucket = result[currentTask];
      if (bucket) bucket[key] = coerceScalar(value);
    }
  }

  return result;
}

export function loadOverrides(vbriefDir: string): Record<string, Record<string, unknown>> {
  const path = join(vbriefDir, OVERRIDES_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return parseOverridesYaml(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function normalizeTaskId(taskId: string): string {
  if (!taskId) return "";
  const s = taskId.trim();
  if (s.length >= 2 && (s[0] === "t" || s[0] === "T") && (/\d/.test(s[1] ?? "") || s[1] === ".")) {
    return s
      .slice(1)
      .replace(/^[-.]+/, "")
      .trim();
  }
  return s;
}

function collectIssueNumbers(item: Record<string, unknown>): string[] {
  const numbers: string[] = [];
  const refs = item.references;
  if (!Array.isArray(refs)) return numbers;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    if (!GITHUB_ISSUE_REF_TYPES.has(String(rec.type ?? ""))) continue;
    const uri = rec.uri;
    if (typeof uri === "string" && uri) {
      const match = GITHUB_ISSUE_URI_RE.exec(uri);
      if (match?.[1]) {
        numbers.push(match[1]);
        continue;
      }
    }
    const rid = String(rec.id ?? "").replace(/^#/, "");
    if (rid) numbers.push(rid);
  }
  return numbers;
}

export function buildSpecTaskIndex(
  specVbrief: Record<string, unknown> | null,
): Record<string, SpecTaskEntry> {
  const index: Record<string, SpecTaskEntry> = {};
  if (!specVbrief || typeof specVbrief !== "object") return index;
  const plan = specVbrief.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return index;

  const walk = (items: unknown, parentPhase: string): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const title = String(rec.title ?? "");
      const childPhase = PHASE_TITLE_RE.test(title) ? title : parentPhase;
      const itemId = String(rec.id ?? "");
      const entry: SpecTaskEntry = { item: rec, specPhase: parentPhase };
      if (itemId) {
        if (!index[itemId]) index[itemId] = entry;
        const normalised = normalizeTaskId(itemId);
        if (normalised && normalised !== itemId && !index[normalised]) index[normalised] = entry;
      }
      for (const num of collectIssueNumbers(rec)) {
        if (!index[num]) index[num] = entry;
        if (!index[`#${num}`]) index[`#${num}`] = entry;
      }
      walk(rec.subItems, childPhase);
    }
  };

  walk((plan as Record<string, unknown>).items, "");
  return index;
}

function pickNarrative(item: Record<string, unknown>, ...keys: string[]): string {
  const narrative = item.narrative;
  if (typeof narrative !== "object" || narrative === null || Array.isArray(narrative)) return "";
  const narr = narrative as Record<string, unknown>;
  for (const key of keys) {
    const value = narr[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function specBody(item: Record<string, unknown>, defaultVal: string): string {
  const body = pickNarrative(item, "Description", "Summary", "Body", "Overview");
  if (body) return body;
  return String(item.title ?? "").trim() || defaultVal;
}

export function hasDisagreement(report: ReconciliationReport): boolean {
  return Boolean(
    report.conflicts.length || report.orphans.length || report.overridesTriggered.length,
  );
}

function statusFromSpec(entry: SpecTaskEntry | null): string | null {
  if (!entry) return null;
  const status = entry.item.status;
  const valid = new Set([
    "draft",
    "proposed",
    "approved",
    "pending",
    "running",
    "completed",
    "blocked",
    "cancelled",
  ]);
  if (typeof status === "string" && valid.has(status)) return status;
  return detectStatusMarker(String(entry.item.title ?? ""));
}

function roadmapStatus(roadmapItem: Record<string, unknown>, completed: boolean): string | null {
  if (completed) return "completed";
  return detectStatusMarker(String(roadmapItem.title ?? ""));
}

function chooseStatus(
  specEntry: SpecTaskEntry | null,
  roadmapStat: string | null,
  overrideStatus: string | null,
): [string, string, string | null] {
  if (overrideStatus) return [overrideStatus, "migration-overrides.yaml", null];
  const specStatus = statusFromSpec(specEntry);
  if (roadmapStat) {
    if (specStatus && specStatus !== roadmapStat) {
      const conflict =
        `SPEC status = ${pyRepr(specStatus)}; ` +
        `ROADMAP status = ${pyRepr(roadmapStat)}; ` +
        "ROADMAP wins (D3 role policy).";
      return [roadmapStat, "ROADMAP.md", conflict];
    }
    return [roadmapStat, "ROADMAP.md", null];
  }
  if (specStatus) return [specStatus, "SPECIFICATION.md (tiebreaker)", null];
  return ["pending", "default", null];
}

function titleConflict(
  specEntry: SpecTaskEntry | null,
  roadmapTitle: string,
): [string, string, string | null, string] {
  const rt = (roadmapTitle || "").trim();
  if (!specEntry) return [rt, "ROADMAP.md", null, ""];
  const specTitle = String(specEntry.item.title ?? "").trim();
  if (!specTitle) return [rt, "ROADMAP.md", null, ""];
  if (specTitle === rt) return [specTitle, "SPECIFICATION.md", null, ""];
  const conflict =
    `SPEC title = ${pyRepr(specTitle)}; ROADMAP title = ${pyRepr(rt)}; ` +
    "SPEC wins; ROADMAP preserved in narrative.RoadmapSummary.";
  return [specTitle, "SPECIFICATION.md", conflict, rt];
}

function description(
  specEntry: SpecTaskEntry | null,
  roadmapTitle: string,
  bodySourceOverride: string | null,
): [string, string] {
  if (bodySourceOverride === "roadmap")
    return [(roadmapTitle || "").trim(), "ROADMAP.md (override)"];
  if (bodySourceOverride === "spec") {
    if (specEntry) return [specBody(specEntry.item, roadmapTitle), "SPECIFICATION.md (override)"];
    return [(roadmapTitle || "").trim(), "ROADMAP.md (override fallback: no SPEC match)"];
  }
  if (specEntry) return [specBody(specEntry.item, roadmapTitle), "SPECIFICATION.md"];
  return [(roadmapTitle || "").trim(), "ROADMAP.md"];
}

function overrideStatus(override: Record<string, unknown> | null): string | null {
  if (!override) return null;
  const status = override.status;
  return typeof status === "string" && status ? status : null;
}

function overrideBodySource(override: Record<string, unknown> | null): string | null {
  if (!override) return null;
  const bodySource = override.body_source;
  if (bodySource === "spec" || bodySource === "roadmap") return bodySource;
  return null;
}

function overrideDrop(override: Record<string, unknown> | null): boolean {
  return Boolean(override?.drop);
}

function taskIdForItem(item: Record<string, unknown>, isCompleted: boolean): string {
  const number = item.number;
  if (number) return `#${number}`;
  const taskId = item.task_id;
  if (taskId) return String(taskId);
  const synthetic = item.synthetic_id;
  if (synthetic) return String(synthetic);
  const suffix = isCompleted ? "completed" : "active";
  return `${suffix}:${item.title ?? "untitled"}`;
}

function lookupOverride(
  item: Record<string, unknown>,
  canonicalKey: string,
  overrides: Record<string, Record<string, unknown>>,
): [Record<string, unknown> | null, string | null] {
  if (!overrides || Object.keys(overrides).length === 0) return [null, null];
  const candidates: string[] = [canonicalKey];
  const taskId = String(item.task_id ?? "");
  if (taskId) {
    const normalised = normalizeTaskId(taskId);
    candidates.push(taskId, normalised, `t${taskId}`, `t${normalised}`);
  }
  const number = String(item.number ?? "");
  if (number) candidates.push(number, `#${number}`);
  const synthetic = String(item.synthetic_id ?? "");
  if (synthetic) candidates.push(synthetic);
  for (const key of candidates) {
    if (key && overrides[key]) return [overrides[key], key];
  }
  return [null, null];
}

function matchSpecEntry(
  item: Record<string, unknown>,
  specIndex: Record<string, SpecTaskEntry>,
): SpecTaskEntry | null {
  if (!specIndex || Object.keys(specIndex).length === 0) return null;
  const number = String(item.number ?? "");
  if (number) {
    for (const key of [number, `#${number}`]) {
      if (specIndex[key]) return specIndex[key];
    }
  }
  const taskId = String(item.task_id ?? "");
  if (taskId) {
    for (const key of [taskId, normalizeTaskId(taskId), `t${taskId}`]) {
      if (specIndex[key]) return specIndex[key];
    }
  }
  return null;
}

export function folderFromStatus(status: string): string {
  return STATUS_TO_FOLDER[status] ?? "pending";
}

export interface ReconcileScopeOptions {
  readonly roadmapActive: ReadonlyArray<Record<string, unknown>>;
  readonly roadmapCompleted: ReadonlyArray<Record<string, unknown>>;
  readonly specVbrief: Record<string, unknown> | null;
  readonly phaseDescriptions?: Record<string, string>;
  readonly overrides?: Record<string, Record<string, unknown>>;
}

export function reconcileScopeItems(
  options: ReconcileScopeOptions,
): [ReconciledItem[], ReconciliationReport] {
  const overrides = options.overrides ?? {};
  const phaseDescriptions = options.phaseDescriptions ?? {};
  const specIndex = buildSpecTaskIndex(options.specVbrief);
  const specHasItems = Object.keys(specIndex).length > 0;

  const reconciled: ReconciledItem[] = [];
  const conflicts: ConflictEntry[] = [];
  const orphans: Array<{ task_id: string; title: string }> = [];
  const overridesTriggered: Array<Record<string, string>> = [];
  const overridesUnused: string[] = [];
  const usedOverrideKeys = new Set<string>();

  const handle = (item: Record<string, unknown>, isCompleted: boolean): void => {
    const taskKey = taskIdForItem(item, isCompleted);
    const [override, matchedKey] = lookupOverride(item, taskKey, overrides);
    if (override !== null && matchedKey !== null) usedOverrideKeys.add(matchedKey);

    if (overrideDrop(override)) {
      overridesTriggered.push({
        task_id: taskKey,
        title: String(item.title ?? ""),
        action: "dropped from migration",
      });
      return;
    }

    const specEntry = matchSpecEntry(item, specIndex);
    const [title, titleSource, titleConflictNote, roadmapSummary] = titleConflict(
      specEntry,
      String(item.title ?? ""),
    );
    const [desc, descriptionSource] = description(
      specEntry,
      String(item.title ?? ""),
      overrideBodySource(override),
    );
    const roadmapStat = roadmapStatus(item, isCompleted);
    let [status, statusSource, statusConflict] = chooseStatus(
      specEntry,
      roadmapStat,
      overrideStatus(override),
    );

    let sourceConflict = "";
    let folder: string;
    if (specHasItems && specEntry === null) {
      sourceConflict = "missing-from-spec";
      if (isCompleted) {
        folder = "completed";
        status = "completed";
        statusSource = "orphan: ROADMAP Completed section (#593)";
      } else {
        folder = "proposed";
        status = "proposed";
        statusSource = "orphan: proposed default";
      }
      orphans.push({ task_id: taskKey, title: title || String(item.title ?? "") });
    } else {
      folder = folderFromStatus(status);
    }

    const phase = String(item.phase ?? "");
    const tier = String(item.tier ?? "");
    const phaseDesc = phase ? (phaseDescriptions[phase] ?? "") : "";
    const specPhase = specEntry?.specPhase ?? "";
    const sourceSection = isCompleted ? "ROADMAP Completed section" : "ROADMAP active phase";

    reconciled.push({
      task_id: taskKey,
      number: String(item.number ?? ""),
      title,
      title_source: titleConflictNote ? titleSource : "",
      description: desc,
      description_source: descriptionSource,
      status,
      status_source: statusSource,
      folder,
      phase,
      phase_description: phaseDesc,
      tier,
      spec_phase: specPhase !== phase ? specPhase : "",
      roadmap_summary: roadmapSummary,
      source_conflict: sourceConflict,
      source_section: sourceSection,
      is_completed: isCompleted,
      override_applied: override !== null,
      synthetic_id: String(item.synthetic_id ?? ""),
      original_task_id: String(item.task_id ?? ""),
    });

    const dims: ConflictEntry["dimensions"][number][] = [];
    if (titleConflictNote) {
      dims.push({
        dimension: "TITLE drift",
        spec: specEntry ? String(specEntry.item.title ?? "") : "",
        roadmap: String(item.title ?? ""),
        resolution: titleConflictNote,
      });
    }
    if (statusConflict) {
      dims.push({
        dimension: "STATUS conflict",
        spec: specEntry ? statusFromSpec(specEntry) || "(none)" : "(no match)",
        roadmap: roadmapStat || "(none)",
        resolution: statusConflict,
      });
    }

    const triggeredFields: string[] = [];
    if (override !== null) {
      for (const key of ["status", "body_source"] as const) {
        if (key in override) triggeredFields.push(key);
      }
      if (override.drop) triggeredFields.push("drop");
      if (triggeredFields.length > 0) {
        overridesTriggered.push({
          task_id: taskKey,
          title,
          fields: triggeredFields.join(", "),
        });
      }
    }

    if (dims.length > 0 || triggeredFields.length > 0) {
      conflicts.push({
        taskId: taskKey,
        title: title || String(item.title ?? ""),
        dimensions: dims,
        overridesApplied: triggeredFields,
      });
    }
  };

  for (const item of options.roadmapActive) handle(item, false);
  for (const item of options.roadmapCompleted) handle(item, true);

  for (const key of Object.keys(overrides)) {
    if (!usedOverrideKeys.has(key)) overridesUnused.push(key);
  }

  return [reconciled, { conflicts, orphans, overridesTriggered, overridesUnused }];
}

function formatConflictEntry(entry: ConflictEntry): string {
  const lines: string[] = [`## ${entry.taskId} -- ${entry.title}`, ""];
  for (const dim of entry.dimensions) {
    lines.push(`- ${dim.dimension}`);
    if (dim.spec) lines.push(`  - SPEC: ${dim.spec}`);
    if (dim.roadmap) lines.push(`  - ROADMAP: ${dim.roadmap}`);
    lines.push(`  - Resolution: ${dim.resolution}`);
  }
  if (entry.overridesApplied.length > 0) {
    lines.push(
      `- Overrides applied: ${entry.overridesApplied.join(", ")} (migration-overrides.yaml)`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function formatReconciliationMarkdown(
  report: ReconciliationReport,
  now: Date = new Date(),
): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const parts: string[] = [
    "# Migration reconciliation report",
    "",
    `Generated: ${timestamp}`,
    "",
    "Per #496 this file is emitted whenever SPECIFICATION.md and ROADMAP.md " +
      "disagreed on any dimension during `task migrate:vbrief`, or when any " +
      "override from `vbrief/migration-overrides.yaml` triggered.",
    "",
  ];

  parts.push("## Per-task conflicts", "");
  if (report.conflicts.length > 0) {
    for (const entry of report.conflicts) parts.push(formatConflictEntry(entry));
  } else {
    parts.push("(none)", "");
  }

  parts.push("## Orphans in ROADMAP (no matching SPEC task)", "");
  if (report.orphans.length > 0) {
    for (const orph of report.orphans) {
      parts.push(
        `- \`${orph.task_id}\` -- ${orph.title}`,
        '  - Resolution: emitted to vbrief/proposed/ with narrative.SourceConflict = "missing-from-spec".',
      );
    }
  } else {
    parts.push("(none)");
  }
  parts.push("");

  parts.push("## Overrides applied (vbrief/migration-overrides.yaml)", "");
  if (report.overridesTriggered.length > 0) {
    for (const ov of report.overridesTriggered) {
      const fields = ov.fields ?? ov.action ?? "";
      parts.push(`- \`${ov.task_id}\` -- ${ov.title ?? ""}: ${fields}`);
    }
  } else {
    parts.push("(none)");
  }
  parts.push("");

  if (report.overridesUnused.length > 0) {
    parts.push("## Overrides defined but not triggered", "");
    for (const key of report.overridesUnused) parts.push(`- \`${key}\``);
    parts.push("");
  }

  return `${parts.join("\n").trimEnd()}\n`;
}

export function writeReconciliationReport(
  report: ReconciliationReport,
  vbriefDir: string,
  now?: Date,
): string | null {
  if (!hasDisagreement(report)) return null;
  const targetDir = join(vbriefDir, "migration");
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, "RECONCILIATION.md");
  writeFileSync(target, formatReconciliationMarkdown(report, now), "utf8");
  return target;
}
