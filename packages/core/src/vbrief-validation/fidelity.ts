import {
  CANONICAL_SPEC_KEYS,
  lookupCanonical,
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";
import { splitLines, stripEdgeChars } from "./normalize.js";
import type { JsonObject, MigrationLogEntry, SectionTuple, SpecTask } from "./types.js";

export { CANONICAL_SPEC_KEYS, SPEC_KNOWN_MAPPINGS };

// --- ReDoS-free line-header parsers (CodeQL js/polynomial-redos) -------------
// The original regexes used overlapping ``\s*``/``.+`` quantifiers that CodeQL
// flags as polynomial. These helpers reproduce the exact match semantics with
// linear character scans (``/\s/.test(singleChar)`` is constant time).

/** Skip a run of whitespace; return the index after it. */
function skipWs(s: string, start: number): number {
  let i = start;
  while (i < s.length && /\s/.test(s[i] as string)) {
    i += 1;
  }
  return i;
}

/** Consume up to ``max`` ``*`` characters; return the index after them. */
function skipAsterisks(s: string, start: number, max: number): number {
  let i = start;
  while (i < start + max && s[i] === "*") {
    i += 1;
  }
  return i;
}

/** Case-insensitive literal match of ``lit`` at ``i``. */
function literalAt(s: string, i: number, lit: string): boolean {
  return s.slice(i, i + lit.length).toLowerCase() === lit;
}

/**
 * Equivalent of ``/^\*{0,2}\s*Depends\s*on\s*\*{0,2}\s*:\s*(?<deps>.+)$/i``
 * applied to a trimmed line. Returns the raw deps substring (caller trims) or
 * null when the line is not a "Depends on:" line.
 */
function matchDependsOn(s: string): string | null {
  let i = skipAsterisks(s, 0, 2);
  i = skipWs(s, i);
  if (!literalAt(s, i, "depends")) {
    return null;
  }
  i = skipWs(s, i + 7);
  if (!literalAt(s, i, "on")) {
    return null;
  }
  i = skipWs(s, i + 2);
  i = skipAsterisks(s, i, 2);
  i = skipWs(s, i);
  if (s[i] !== ":") {
    return null;
  }
  i += 1;
  // ``\s*(?<deps>.+)$`` matches iff >=1 char remains after the colon.
  return i < s.length ? s.slice(i) : null;
}

/**
 * Equivalent of ``/^\s*\*{0,2}\s*Traces\s*\*{0,2}\s*:\s*(?<traces>.+)$/i``
 * applied to a trimmed line. Returns the raw traces substring or null.
 */
function matchTraces(s: string): string | null {
  let i = skipWs(s, 0);
  i = skipAsterisks(s, i, 2);
  i = skipWs(s, i);
  if (!literalAt(s, i, "traces")) {
    return null;
  }
  i = skipWs(s, i + 6);
  i = skipAsterisks(s, i, 2);
  i = skipWs(s, i);
  if (s[i] !== ":") {
    return null;
  }
  i += 1;
  return i < s.length ? s.slice(i) : null;
}

/**
 * Equivalent of ``/^\*{0,2}\s*Acceptance(?:\s+criteria)?\*{0,2}\s*:?\s*$/i``
 * applied to a trimmed line.
 */
function isAcceptanceHeading(s: string): boolean {
  let i = skipAsterisks(s, 0, 2);
  i = skipWs(s, i);
  if (!literalAt(s, i, "acceptance")) {
    return false;
  }
  i += 10;
  // optional ``\s+criteria`` (the whitespace is mandatory inside the group)
  const afterWs = skipWs(s, i);
  if (afterWs > i && literalAt(s, afterWs, "criteria")) {
    i = afterWs + 8;
  }
  i = skipAsterisks(s, i, 2);
  i = skipWs(s, i);
  if (s[i] === ":") {
    i += 1;
  }
  i = skipWs(s, i);
  return i === s.length;
}

/** Match a trailing ``[status]`` group: ``\[[a-zA-Z_-]+\]\s*$`` (tail starts at ``[``). */
function matchBracketStatus(tail: string): string | null {
  let i = 1;
  while (i < tail.length && /[a-zA-Z_-]/.test(tail[i] as string)) {
    i += 1;
  }
  if (i === 1 || tail[i] !== "]") {
    return null;
  }
  const status = tail.slice(1, i);
  i = skipWs(tail, i + 1);
  return i === tail.length ? status : null;
}

/**
 * Parse ``(?<title>[^[\n]+?)(?:\s*\[(?<status>[a-zA-Z_-]+)\])?\s*$`` over the
 * region after a task-heading separator. Title is trimmed by the caller.
 */
function parseTitleAndStatus(region: string): { title: string; status: string | null } | null {
  if (region.length === 0) {
    return null;
  }
  const bracket = region.indexOf("[");
  if (bracket === -1) {
    return { title: region.trim(), status: null };
  }
  if (bracket === 0) {
    return null; // title requires >=1 character before the '['
  }
  const status = matchBracketStatus(region.slice(bracket));
  if (status === null) {
    return null; // a '[' that is not a valid trailing status cannot be in the title
  }
  return { title: region.slice(0, bracket).trim(), status };
}

/**
 * Equivalent of TASK_HEADING_RE:
 * ``^(?<hashes>#{3,4})\s+(?:`)?(?<task_id>t[0-9]+(?:\.[0-9]+)+)(?:`)?``
 * ``(?:\s*[-:]+\s*|\s+)(?<title>[^[\n]+?)(?:\s*\[(?<status>[a-zA-Z_-]+)\])?\s*$``
 * implemented as a linear parser to avoid the ReDoS-prone separator/title
 * overlaps. Returns the captured groups or null.
 */
function matchTaskHeading(
  line: string,
): { task_id: string; title: string; status: string | null } | null {
  let i = 0;
  let hashes = 0;
  while (line[i] === "#") {
    hashes += 1;
    i += 1;
  }
  if (hashes < 3 || hashes > 4) {
    return null;
  }
  const afterHashWs = skipWs(line, i);
  if (afterHashWs === i) {
    return null; // \s+ requires >=1 whitespace
  }
  i = afterHashWs;
  if (line[i] === "`") {
    i += 1;
  }
  // task_id: t[0-9]+(?:\.[0-9]+)+
  const idStart = i;
  if (line[i] !== "t") {
    return null;
  }
  i += 1;
  let digits = 0;
  while (i < line.length && line[i] !== undefined && /[0-9]/.test(line[i] as string)) {
    i += 1;
    digits += 1;
  }
  if (digits === 0) {
    return null;
  }
  let groups = 0;
  while (line[i] === ".") {
    let k = i + 1;
    let groupDigits = 0;
    while (k < line.length && /[0-9]/.test(line[k] as string)) {
      k += 1;
      groupDigits += 1;
    }
    if (groupDigits === 0) {
      break;
    }
    i = k;
    groups += 1;
  }
  if (groups === 0) {
    return null;
  }
  const taskId = line.slice(idStart, i);
  if (line[i] === "`") {
    i += 1;
  }
  const tail = line.slice(i);
  // Separator alt1: \s* [-:]+ \s*  (trailing whitespace folds into the title)
  const afterSepWs = skipWs(tail, 0);
  let dashEnd = afterSepWs;
  while (dashEnd < tail.length && (tail[dashEnd] === "-" || tail[dashEnd] === ":")) {
    dashEnd += 1;
  }
  if (dashEnd > afterSepWs) {
    const parsed = parseTitleAndStatus(tail.slice(dashEnd));
    if (parsed) {
      return { task_id: taskId, title: parsed.title, status: parsed.status };
    }
  }
  // Separator alt2: \s+  (mandatory >=1 whitespace; the rest folds into title)
  if (tail.length > 0 && /\s/.test(tail[0] as string)) {
    const parsed = parseTitleAndStatus(tail.slice(1));
    if (parsed) {
      return { task_id: taskId, title: parsed.title, status: parsed.status };
    }
  }
  return null;
}

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
    const cleaned = stripEdgeChars(tok.trim(), "`*,;. ");
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
      const depsRaw = matchDependsOn(stripped);
      if (depsRaw !== null) {
        const deps = depsRaw.trim();
        if (!["none", "n/a", "-"].includes(deps.toLowerCase())) {
          depends.push(...tokenizeDeps(deps));
        }
        inAcceptance = false;
        continue;
      }
      const tracesRaw = matchTraces(stripped);
      if (tracesRaw !== null) {
        TRACE_ID_RE.lastIndex = 0;
        let m = TRACE_ID_RE.exec(tracesRaw);
        while (m !== null) {
          traces.push(m[0].toUpperCase());
          m = TRACE_ID_RE.exec(tracesRaw);
        }
        inAcceptance = false;
        continue;
      }
      if (isAcceptanceHeading(stripped)) {
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
    const heading = matchTaskHeading(line);
    if (heading !== null) {
      flush(lineNo - 1);
      current = {
        task_id: heading.task_id.trim(),
        title: heading.title,
        status: mapSpecStatus(heading.status ?? null),
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
