import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { call } from "../scm/call.js";
import { extractIssueRef } from "../triage/reconcile/parse-uri.js";
import type { Child, ReconcileUmbrellasOutcome, UmbrellaChange, UmbrellaClient } from "./types.js";

export const OPEN_FOLDERS = ["proposed", "pending", "active"] as const;
export const CLOSED_FOLDERS = ["completed", "cancelled"] as const;
export const LIFECYCLE_FOLDERS = [...OPEN_FOLDERS, ...CLOSED_FOLDERS] as const;
export const CHILD_REF_TYPE = "x-vbrief/plan";
const SCM_SOURCE = "github-issue";

const HEADER_RE = /^## Current shape \(as of pass-(\d+)\)/m;
// ReDoS-hardened (#1782 s4 / CodeQL js/polynomial-redos): the original
// `\s*(.*)$` let `\s*` and `.*` both match horizontal whitespace (overlapping
// repetitions). Replacing the capture with `(\S.*|)` makes `\s*`'s successor
// disjoint (starts with a non-whitespace char) while the empty alternation
// preserves the exact `""`-not-undefined capture of an all-whitespace tail.
// Captured language is byte-identical to the frozen Python oracle
// (`r"^...:\s*(.*)$"`, re.MULTILINE) for every input.
const HISTORY_RE = /^Child-count history:\s*(\S.*|)$/m;
const LAST_UPDATED_RE = /^Last updated:\s*(\S.*|)$/m;
const LAST_PASS_TYPE_RE = /^Last pass type:\s*(\S.*|)$/m;
const HISTORY_TOKEN_RE = /^\s*pass-(\d+):\s*(\d+)\s*$/;

const READING_ORDER =
  "1. Read the umbrella issue body.\n" +
  "2. Read this current-shape comment.\n" +
  "3. Read the amendment comments in chronological order for the full audit trail.";

export class UmbrellaScmError extends Error {
  override name = "UmbrellaScmError";
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function childFromData(
  data: Record<string, unknown>,
  folder: string,
  fallbackId: string,
): Child {
  const plan =
    typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
      ? (data.plan as Record<string, unknown>)
      : {};
  const metadata =
    typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
      ? (plan.metadata as Record<string, unknown>)
      : {};
  const swarm =
    typeof metadata.swarm === "object" && metadata.swarm !== null && !Array.isArray(metadata.swarm)
      ? (metadata.swarm as Record<string, unknown>)
      : {};
  const rawDeps = swarm.depends_on;
  const dependsOn = Array.isArray(rawDeps) ? rawDeps.map((d) => String(d)) : [];
  return {
    story_id: String(plan.id ?? fallbackId),
    title: String(plan.title ?? plan.id ?? fallbackId),
    kind: String(metadata.kind ?? "story"),
    folder,
    depends_on: dependsOn,
  };
}

export function buildChildIndex(vbriefDir: string): Record<string, Child> {
  const index: Record<string, Child> = {};
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => f.endsWith(".vbrief.json"))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = readJson(path);
      if (!data) continue;
      const fallbackId = file.slice(0, -".vbrief.json".length);
      index[file] = childFromData(data, folder, fallbackId);
    }
  }
  return index;
}

export function computeChildren(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
): Child[] {
  const plan =
    typeof epicData.plan === "object" && epicData.plan !== null && !Array.isArray(epicData.plan)
      ? (epicData.plan as Record<string, unknown>)
      : {};
  const refs = plan.references;
  const children: Child[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(refs)) return children;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    if (rec.type !== CHILD_REF_TYPE) continue;
    const name = basename(String(rec.uri ?? ""));
    const child = index[name];
    if (!child || seen.has(child.story_id)) continue;
    seen.add(child.story_id);
    children.push(child);
  }
  return children;
}

export function computeWaves(children: readonly Child[]): string[][] {
  const ids = new Set(children.map((c) => c.story_id));
  const deps: Record<string, string[]> = {};
  for (const c of children) {
    deps[c.story_id] = c.depends_on.filter((d) => ids.has(d));
  }
  const resolved = new Set<string>();
  const remaining = new Set(ids);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((r) => (deps[r] ?? []).every((d) => resolved.has(d)))
      .sort();
    if (layer.length === 0) {
      waves.push([...remaining].sort());
      break;
    }
    waves.push(layer);
    for (const id of layer) {
      resolved.add(id);
      remaining.delete(id);
    }
  }
  return waves;
}

function bulletBlock(lines: readonly string[]): string {
  return lines.length > 0 ? lines.join("\n") : "- none";
}

export function renderBody(options: {
  passN: number;
  lastPassType: string;
  lastUpdated: string;
  openChildren: readonly Child[];
  closedChildren: readonly Child[];
  waves: readonly (readonly string[])[];
  history: readonly (readonly [number, number])[];
}): string {
  const total = options.openChildren.length + options.closedChildren.length;
  const historyStr = options.history.map(([n, count]) => `pass-${n}: ${count}`).join(", ");
  const openLines = options.openChildren.map((c) => `- ${c.story_id}: ${c.title} (${c.kind})`);
  const closedLines = options.closedChildren.map(
    (c) => `- ${c.story_id}: ${c.title} (${c.folder})`,
  );
  const waveLines = options.waves.map((layer, i) => `- Wave ${i + 1}: ${layer.join(", ")}`);
  return (
    `## Current shape (as of pass-${options.passN})\n` +
    "\n" +
    `Last updated: ${options.lastUpdated}\n` +
    `Last pass type: ${options.lastPassType}\n` +
    `Child count: ${total} (${options.openChildren.length}/${options.closedChildren.length})\n` +
    `Child-count history: ${historyStr}\n` +
    "\n" +
    "### Open children\n" +
    "\n" +
    `${bulletBlock(openLines)}\n` +
    "\n" +
    "### Closed children\n" +
    "\n" +
    `${bulletBlock(closedLines)}\n` +
    "\n" +
    "### Wave order\n" +
    "\n" +
    `${bulletBlock(waveLines)}\n` +
    "\n" +
    "### Open questions\n" +
    "\n" +
    "- none\n" +
    "\n" +
    "### Reading order for fresh contributors\n" +
    "\n" +
    READING_ORDER
  );
}

export interface ParsedShape {
  passN: number | null;
  history: Array<[number, number]>;
  lastUpdated: string | null;
  lastPassType: string | null;
}

function parseHistory(raw: string): Array<[number, number]> {
  const history: Array<[number, number]> = [];
  for (const token of raw.split(",")) {
    const match = HISTORY_TOKEN_RE.exec(token);
    if (match?.[1] && match[2]) history.push([Number(match[1]), Number(match[2])]);
  }
  return history;
}

export function parseCurrentShape(body: string): ParsedShape {
  const header = HEADER_RE.exec(body);
  if (!header?.[1]) return { passN: null, history: [], lastUpdated: null, lastPassType: null };
  const historyMatch = HISTORY_RE.exec(body);
  const updatedMatch = LAST_UPDATED_RE.exec(body);
  const passTypeMatch = LAST_PASS_TYPE_RE.exec(body);
  return {
    passN: Number(header[1]),
    history: historyMatch?.[1] ? parseHistory(historyMatch[1]) : [],
    lastUpdated: updatedMatch?.[1]?.trim() ?? null,
    lastPassType: passTypeMatch?.[1]?.trim() ?? null,
  };
}

export function classifyPassType(prevTotal: number | null, total: number): string {
  if (prevTotal === null) return "refactor";
  if (total > prevTotal) return "additive";
  if (total < prevTotal) return "subtractive";
  return "refactor";
}

function hasCurrentShape(body: string): boolean {
  return HEADER_RE.test(body);
}

export class ScmUmbrellaClient implements UmbrellaClient {
  fetchComments(repo: string, issueNumber: number): Array<{ id: number; body: string }> {
    const proc = call(SCM_SOURCE, "api", [
      `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
    ]);
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `list comments #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(proc.stdout || "[]");
    } catch (exc) {
      throw new UmbrellaScmError(
        `list comments #${issueNumber} (${repo}) returned non-JSON: ${String(exc)}`,
      );
    }
    if (!Array.isArray(data)) return [];
    const comments: Array<{ id: number; body: string }> = [];
    for (const entry of data) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === "number" &&
        typeof (entry as Record<string, unknown>).body === "string"
      ) {
        const rec = entry as Record<string, unknown>;
        comments.push({ id: rec.id as number, body: rec.body as string });
      }
    }
    return comments;
  }

  editComment(repo: string, commentId: number, body: string): void {
    const proc = call(
      SCM_SOURCE,
      "api",
      ["-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "--input", "-"],
      { input: JSON.stringify({ body }) },
    );
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `edit comment ${commentId} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number | null {
    const proc = call(
      SCM_SOURCE,
      "api",
      ["-X", "POST", `repos/${repo}/issues/${issueNumber}/comments`, "--input", "-"],
      { input: JSON.stringify({ body }) },
    );
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `create comment #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    try {
      const data = JSON.parse(proc.stdout || "{}") as Record<string, unknown>;
      return typeof data.id === "number" ? data.id : null;
    } catch {
      return null;
    }
  }
}

function planShape(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
): [Child[], Child[], string[][]] {
  const children = computeChildren(epicData, index);
  const openChildren = children
    .filter((c) => (OPEN_FOLDERS as readonly string[]).includes(c.folder))
    .sort((a, b) => a.story_id.localeCompare(b.story_id));
  const closedChildren = children
    .filter((c) => !(OPEN_FOLDERS as readonly string[]).includes(c.folder))
    .sort((a, b) => a.story_id.localeCompare(b.story_id));
  const waves = computeWaves(children);
  return [openChildren, closedChildren, waves];
}

function reconcileOneEpic(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
  options: {
    storyId: string;
    repo: string;
    number: number;
    client: UmbrellaClient;
    dryRun: boolean;
    now: string;
  },
): UmbrellaChange {
  const [openChildren, closedChildren, waves] = planShape(epicData, index);
  const total = openChildren.length + closedChildren.length;

  const comments = options.client.fetchComments(options.repo, options.number);
  const existing = comments.find((c) => hasCurrentShape(c.body));

  if (!existing) {
    const body = renderBody({
      passN: 1,
      lastPassType: "additive",
      lastUpdated: options.now,
      openChildren,
      closedChildren,
      waves,
      history: [[1, total]],
    });
    if (!options.dryRun) options.client.createComment(options.repo, options.number, body);
    return {
      story_id: options.storyId,
      repo: options.repo,
      issue_number: options.number,
      action: "created",
      pass_n: 1,
      body,
    };
  }

  const parsed = parseCurrentShape(existing.body);
  const prevPass = parsed.passN ?? 1;
  const prevTotal =
    parsed.history.length > 0 ? (parsed.history[parsed.history.length - 1]?.[1] ?? null) : null;

  const candidate = renderBody({
    passN: prevPass,
    lastPassType: parsed.lastPassType ?? "refactor",
    lastUpdated: parsed.lastUpdated ?? options.now,
    openChildren,
    closedChildren,
    waves,
    history: parsed.history.length > 0 ? parsed.history : [[prevPass, total]],
  });

  if (candidate === existing.body) {
    return {
      story_id: options.storyId,
      repo: options.repo,
      issue_number: options.number,
      action: "unchanged",
      pass_n: prevPass,
      body: candidate,
    };
  }

  const passN = prevPass + 1;
  const body = renderBody({
    passN,
    lastPassType: classifyPassType(prevTotal, total),
    lastUpdated: options.now,
    openChildren,
    closedChildren,
    waves,
    history: [...parsed.history, [passN, total]],
  });
  if (!options.dryRun) options.client.editComment(options.repo, existing.id, body);
  return {
    story_id: options.storyId,
    repo: options.repo,
    issue_number: options.number,
    action: "edited",
    pass_n: passN,
    body,
  };
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface ReconcileUmbrellasOptions {
  readonly repo?: string | null;
  readonly dryRun?: boolean;
  readonly client?: UmbrellaClient;
  readonly now?: string;
}

export function reconcileUmbrellas(
  projectRoot: string,
  options: ReconcileUmbrellasOptions = {},
): [number, ReconcileUmbrellasOutcome] {
  const root = resolve(projectRoot);
  const vbriefDir = join(root, "vbrief");
  if (!existsSync(vbriefDir)) {
    return [
      2,
      {
        changed: [],
        unchanged: [],
        skipped_no_ref: [],
        errors: [],
        dry_run: options.dryRun ?? false,
      },
    ];
  }

  const client = options.client ?? new ScmUmbrellaClient();
  const now = options.now ?? nowIso();
  const index = buildChildIndex(vbriefDir);
  const outcome: ReconcileUmbrellasOutcome = {
    changed: [],
    unchanged: [],
    skipped_no_ref: [],
    errors: [],
    dry_run: options.dryRun ?? false,
  };
  const seenIssues = new Set<string>();

  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => f.endsWith(".vbrief.json"))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = readJson(path);
      if (!data) continue;
      const plan =
        typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
          ? (data.plan as Record<string, unknown>)
          : {};
      const metadata =
        typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
          ? (plan.metadata as Record<string, unknown>)
          : {};
      if (metadata.kind !== "epic") continue;
      const storyId = String(plan.id ?? file.slice(0, -".vbrief.json".length));

      const [refRepo, number] = extractIssueRef(data);
      const effectiveRepo = refRepo ?? options.repo ?? null;
      if (number === null || effectiveRepo === null) {
        outcome.skipped_no_ref.push(storyId);
        continue;
      }
      const key = `${effectiveRepo}:${number}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);

      try {
        const change = reconcileOneEpic(data, index, {
          storyId,
          repo: effectiveRepo,
          number,
          client,
          dryRun: options.dryRun ?? false,
          now,
        });
        if (change.action === "unchanged") outcome.unchanged.push(change);
        else outcome.changed.push(change);
      } catch (exc) {
        outcome.errors.push({ story_id: storyId, message: String(exc) });
      }
    }
  }

  return [outcome.errors.length > 0 ? 1 : 0, outcome];
}

export function renderUmbrellasReport(outcome: ReconcileUmbrellasOutcome): string {
  const lines: string[] = ["vBRIEF reconcile umbrellas", ""];
  const suffix = outcome.dry_run ? " (dry-run)" : "";

  lines.push(`Changed${suffix}:`);
  if (outcome.changed.length > 0) {
    for (const c of outcome.changed) {
      lines.push(
        `- #${c.issue_number} (${c.repo}) [${c.story_id}]: ${c.action} -> pass-${c.pass_n}`,
      );
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Unchanged:");
  if (outcome.unchanged.length > 0) {
    for (const c of outcome.unchanged) {
      lines.push(`- #${c.issue_number} (${c.repo}) [${c.story_id}]: pass-${c.pass_n}`);
    }
  } else {
    lines.push("- none");
  }

  if (outcome.skipped_no_ref.length > 0) {
    lines.push("");
    lines.push("Skipped (no github-issue reference / repo):");
    for (const sid of outcome.skipped_no_ref) lines.push(`- ${sid}`);
  }

  if (outcome.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of outcome.errors) lines.push(`- ${err.story_id}: ${err.message}`);
  }

  return lines.join("\n");
}

export function umbrellasOutcomeToJson(
  outcome: ReconcileUmbrellasOutcome,
): Record<string, unknown> {
  const toChange = (c: UmbrellaChange) => ({
    story_id: c.story_id,
    repo: c.repo,
    issue_number: c.issue_number,
    action: c.action,
    pass_n: c.pass_n,
  });
  return {
    changed: outcome.changed.map(toChange),
    unchanged: outcome.unchanged.map(toChange),
    skipped_no_ref: [...outcome.skipped_no_ref],
    errors: outcome.errors.map((e) => ({ story_id: e.story_id, message: e.message })),
    dry_run: outcome.dry_run,
  };
}
