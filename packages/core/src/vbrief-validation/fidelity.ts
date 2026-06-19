import {
  CANONICAL_SPEC_KEYS,
  lookupCanonical,
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";
import { splitLines } from "./normalize.js";
import type { JsonObject, MigrationLogEntry, SectionTuple, SpecTask } from "./types.js";

export { CANONICAL_SPEC_KEYS, SPEC_KNOWN_MAPPINGS };

const TASK_HEADING_RE =
  /^(?<hashes>#{3,4})\s+(?:`)?(?<task_id>t[0-9]+(?:\.[0-9]+)+)(?:`)?(?:\s*[-:]+\s*|\s+)(?<title>[^[\n]+?)(?:\s*\[(?<status>[a-zA-Z_-]+)\])?\s*$/;

const DEPENDS_ON_RE = /^\*{0,2}\s*Depends\s*on\s*\*{0,2}\s*:\s*(?<deps>.+)$/i;

const TRACES_RE = /^\s*\*{0,2}\s*Traces\s*\*{0,2}\s*:\s*(?<traces>.+)$/i;

const REQ_DEF_RE =
  /^\s*(?:[-*]\s+)?\*{0,2}\s*(?<id>(?:FR|NFR)-\d+)\s*\*{0,2}\s*[:-]+\s*(?<desc>.+?)\s*$/i;

const TRACE_ID_RE = /(?:FR|NFR)-\d+/gi;

const SPEC_STATUS_TO_VBRIEF: Readonly<Record<string, string>> = {
  done: "completed",
  completed: "completed",
  complete: "completed",
  pending: "pending",
  running: "running",
  "in-progress": "running",
  in_progress: "running",
  blocked: "blocked",
  cancelled: "cancelled",
  canceled: "cancelled",
  draft: "draft",
  proposed: "proposed",
  approved: "approved",
};

const ID_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

/** Map a SPECIFICATION.md status token to a vBRIEF status (D2 vocabulary). */
export function mapSpecStatus(raw: string | null | undefined): string {
  if (!raw) {
    return "pending";
  }
  return SPEC_STATUS_TO_VBRIEF[raw.trim().toLowerCase()] ?? "pending";
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^[-*]\s+/, "");
}

function tokenizeDeps(raw: string): string[] {
  const out: string[] = [];
  for (const tok of raw.split(/[,\s]+/)) {
    const cleaned = tok.trim().replace(/^[`*,;. ]+|[`*,;. ]+$/g, "");
    if (cleaned) {
      out.push(cleaned);
    }
  }
  return out;
}

/** Parse ``tX.Y.Z`` task sections out of SPECIFICATION.md. */
export function parseSpecTasks(content: string): SpecTask[] {
  if (!content) {
    return [];
  }
  const lines = splitLines(content);
  const tasks: SpecTask[] = [];
  let current: Partial<SpecTask> | null = null;
  let currentStart = 0;
  let currentBodyLines: string[] = [];

  const flush = (endLine: number): void => {
    if (current === null) {
      return;
    }
    const bodyLines = [...currentBodyLines];
    const depends: string[] = [];
    const traces: string[] = [];
    const acceptance: string[] = [];
    const descriptionLines: string[] = [];
    let inAcceptance = false;
    for (const raw of bodyLines) {
      const stripped = raw.trim();
      const depMatch = DEPENDS_ON_RE.exec(stripped);
      if (depMatch?.groups?.deps !== undefined) {
        const depsRaw = depMatch.groups.deps.trim();
        if (!["none", "n/a", "-"].includes(depsRaw.toLowerCase())) {
          depends.push(...tokenizeDeps(depsRaw));
        }
        inAcceptance = false;
        continue;
      }
      const traceMatch = TRACES_RE.exec(stripped);
      if (traceMatch?.groups?.traces !== undefined) {
        TRACE_ID_RE.lastIndex = 0;
        let m = TRACE_ID_RE.exec(traceMatch.groups.traces);
        while (m !== null) {
          traces.push(m[0].toUpperCase());
          m = TRACE_ID_RE.exec(traceMatch.groups.traces);
        }
        inAcceptance = false;
        continue;
      }
      if (/^\*{0,2}\s*Acceptance(?:\s+criteria)?\*{0,2}\s*:?\s*$/i.test(stripped)) {
        inAcceptance = true;
        continue;
      }
      if (!stripped) {
        if (!inAcceptance) {
          descriptionLines.push(raw);
        }
        continue;
      }
      if ((stripped.startsWith("-") || stripped.startsWith("*")) && inAcceptance) {
        acceptance.push(stripBulletPrefix(stripped));
        continue;
      }
      if (
        (stripped.startsWith("-") || stripped.startsWith("*")) &&
        !inAcceptance &&
        descriptionLines.length === 0
      ) {
        acceptance.push(stripBulletPrefix(stripped));
        continue;
      }
      if ((stripped.startsWith("-") || stripped.startsWith("*")) && !inAcceptance) {
        descriptionLines.push(raw);
        continue;
      }
      if (!stripped) {
        descriptionLines.push(raw);
        continue;
      }
      descriptionLines.push(raw);
      inAcceptance = false;
    }
    const body = descriptionLines.join("\n").trim();
    tasks.push({
      task_id: String(current.task_id ?? ""),
      title: String(current.title ?? ""),
      status: String(current.status ?? "pending"),
      body,
      depends_on: depends,
      traces,
      acceptance,
      start_line: currentStart,
      end_line: endLine,
    });
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;
    const heading = TASK_HEADING_RE.exec(line);
    if (heading?.groups?.task_id !== undefined) {
      flush(lineNo - 1);
      current = {
        task_id: heading.groups.task_id.trim(),
        title: heading.groups.title?.trim() ?? "",
        status: mapSpecStatus(heading.groups.status ?? null),
      };
      currentStart = lineNo;
      currentBodyLines = [];
      continue;
    }
    if (/^##\s+/.test(line) && current !== null) {
      flush(lineNo - 1);
      current = null;
      currentBodyLines = [];
      continue;
    }
    if (current !== null) {
      currentBodyLines.push(line);
    }
  }
  flush(lines.length);
  return tasks;
}

/** Parse FR-N / NFR-N definitions from SPECIFICATION.md. */
export function parseRequirementDefinitions(content: string): Record<string, string> {
  if (!content) {
    return {};
  }
  const sections = parseTopLevelSections(content);
  const requirements: Record<string, string> = {};
  for (const [title, body] of sections) {
    const canonical = lookupCanonical(title, SPEC_KNOWN_MAPPINGS);
    if (canonical !== "Requirements" && canonical !== "NonFunctionalRequirements") {
      continue;
    }
    for (const line of body.split("\n")) {
      const match = REQ_DEF_RE.exec(line);
      if (!match?.groups?.id || !match.groups.desc) {
        continue;
      }
      const reqId = match.groups.id.toUpperCase();
      let desc = match.groups.desc.trim();
      desc = desc.replace(/\s*\*+\s*$/, "").trim();
      if (reqId && desc && !(reqId in requirements)) {
        requirements[reqId] = desc;
      }
    }
  }
  return requirements;
}

/** Render FR/NFR definitions as a Requirements narrative string. */
export function buildRequirementsNarrative(requirements: Readonly<Record<string, string>>): string {
  if (Object.keys(requirements).length === 0) {
    return "";
  }
  const sortKey = (item: readonly [string, string]): [number, number] => {
    const [rid] = item;
    const kind = rid.startsWith("FR-") ? 0 : 1;
    const dash = rid.indexOf("-");
    const num = dash >= 0 ? Number.parseInt(rid.slice(dash + 1), 10) : 0;
    return [kind, Number.isNaN(num) ? 0 : num];
  };
  const sortedItems = Object.entries(requirements).sort((a, b) => {
    const [ak, an] = sortKey(a);
    const [bk, bn] = sortKey(b);
    return ak !== bk ? ak - bk : an - bn;
  });
  return sortedItems.map(([rid, desc]) => `${rid}: ${desc}`).join("\n");
}

/** Build ``plan.edges[]`` from per-task ``depends_on`` lists. */
export function buildEdgesFromTasks(tasks: Iterable<SpecTask | JsonObject>): JsonObject[] {
  const edges: JsonObject[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const tgt = String(task.task_id ?? "").trim();
    if (!tgt || !ID_PATTERN.test(tgt)) {
      continue;
    }
    const deps = task.depends_on;
    const depList = Array.isArray(deps) ? deps : [];
    for (const dep of depList) {
      const src = String(dep ?? "")
        .trim()
        .replace(/^`|`$/g, "");
      if (!src || src === tgt || !ID_PATTERN.test(src)) {
        continue;
      }
      const key = `${src}\0${tgt}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ from: src, to: tgt, type: "blocks" });
    }
  }
  return edges;
}

/** Reduce a narratives dict to the #506 D3 canonical spec shape. */
export function alignSpecNarratives(narratives: unknown): Record<string, string> {
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(narratives as Record<string, unknown>)) {
    if (typeof value !== "string") {
      continue;
    }
    const canonical = lookupCanonical(key, SPEC_KNOWN_MAPPINGS);
    const target = canonical ?? key;
    if (target in result) {
      result[target] = `${result[target]?.replace(/\s+$/, "")}\n\n${value.trim()}`;
    } else {
      result[target] = value.trim();
    }
  }
  return result;
}

/** Split SPECIFICATION.md into canonical narratives + legacy sections. */
export function ingestSpecNarratives(
  specContent: string,
  sourceFile = "SPECIFICATION.md",
): readonly [Record<string, string>, MigrationLogEntry[], SectionTuple[]] {
  const sections = parseTopLevelSections(specContent ?? "");
  const [canonical, legacy] = partitionSections(sections, SPEC_KNOWN_MAPPINGS);
  const logEntries: MigrationLogEntry[] = [];
  for (const [title, _body, start, end] of sections) {
    const canonicalKey = lookupCanonical(title, SPEC_KNOWN_MAPPINGS);
    const targetFile = "specification.vbrief.json";
    const targetKey = canonicalKey ?? "LegacyArtifacts";
    logEntries.push({
      source: sourceFile,
      section_title: title,
      line_range: end > start ? `${start}-${end}` : `${start}`,
      target_key: targetKey,
      target_file: targetFile,
    });
  }
  return [canonical, logEntries, legacy];
}

/** Format a routing-decision dict as a single migrator log line. */
export function formatMigrationLogEntry(entry: MigrationLogEntry | JsonObject): string {
  const src = String(entry.source ?? "?");
  const rng = String(entry.line_range ?? "?");
  const key = String(entry.target_key ?? "?");
  const dst = String(entry.target_file ?? "?");
  return `ROUTE  ${src}:${rng} -> ${key} -> ${dst}`;
}

/** Build the per-task scope-vBRIEF narrative dict. */
export function taskScopeNarratives(task: SpecTask | JsonObject): Record<string, string> {
  const narratives: Record<string, string> = {};
  const body = String(task.body ?? "").trim();
  if (body) {
    narratives.Description = body;
  }
  const depends = task.depends_on;
  if (Array.isArray(depends) && depends.length > 0) {
    narratives.DependsOn = depends.map((d) => String(d)).join(", ");
  }
  const acceptance = task.acceptance;
  if (Array.isArray(acceptance) && acceptance.length > 0) {
    narratives.AcceptanceCriteria = acceptance.map((item) => `- ${String(item)}`).join("\n");
  }
  const traces = task.traces;
  if (Array.isArray(traces) && traces.length > 0) {
    narratives.Traces = traces.map((t) => String(t)).join(", ");
  }
  return narratives;
}
