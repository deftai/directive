import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import {
  createIssueComment,
  editIssueBody,
  editIssueCommentBody,
  fetchIssueBody,
  GitHubBodyError,
} from "../intake/github-body.js";
import { fetchIssueStates, IssueState } from "../intake/reconcile-issues.js";
import { hasArtifactSuffix, resolveLifecycleRoot, stripArtifactSuffix } from "../layout/resolve.js";
import { call } from "../scm/call.js";
import { extractIssueRef, parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";
import { isRepoMutationAllowed } from "./repo-guard.js";
import type {
  Child,
  ForgeIssueState,
  ReconcileUmbrellasOutcome,
  UmbrellaChange,
  UmbrellaClient,
} from "./types.js";

export const OPEN_FOLDERS = ["proposed", "pending", "active"] as const;
export const CLOSED_FOLDERS = ["completed", "cancelled"] as const;
export const LIFECYCLE_FOLDERS = [...OPEN_FOLDERS, ...CLOSED_FOLDERS] as const;
export const CHILD_REF_TYPE = "x-xbrief/plan";
/** Synthetic lifecycle folder for issue-only children with no local xBRIEF (#1649). */
export const UNKNOWN_FOLDER = "unknown" as const;
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
/**
 * Issue-body checklist line with a `#N` child ref (#1649).
 * Captures leading marker, checkbox state, and the remainder after `]`.
 * Linear-time: no nested quantifiers on overlapping classes.
 */
const CHECKLIST_ISSUE_LINE_RE = /^([ \t]*[-*+][ \t]+)\[([ xX])\]([ \t]*#[0-9]+\b.*)$/;

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
  const [, issueNumber] = extractIssueRef(data);
  return {
    story_id: String(plan.id ?? fallbackId),
    title: String(plan.title ?? plan.id ?? fallbackId),
    kind: String(metadata.kind ?? "story"),
    folder,
    depends_on: dependsOn,
    issue_number: issueNumber,
  };
}

export function buildChildIndex(vbriefDir: string): Record<string, Child> {
  const index: Record<string, Child> = {};
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = readJson(path);
      if (!data) continue;
      const fallbackId = stripArtifactSuffix(file);
      index[file] = childFromData(data, folder, fallbackId);
    }
  }
  return index;
}

/** Index children by forge issue number for github-issue ref resolution (#1649). */
export function indexChildrenByIssueNumber(index: Record<string, Child>): Map<number, Child> {
  const byIssue = new Map<number, Child>();
  for (const child of Object.values(index)) {
    if (typeof child.issue_number === "number" && !byIssue.has(child.issue_number)) {
      byIssue.set(child.issue_number, child);
    }
  }
  return byIssue;
}

/**
 * Resolve epic children from plan refs AND github-issue refs (#1649 defect 2).
 * The epic's own github-issue ref is skipped when `epicIssueNumber` is provided.
 * Issue-only children (no local xBRIEF) are synthesized with folder `unknown`.
 */
export function computeChildren(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
  options: { epicIssueNumber?: number | null } = {},
): Child[] {
  const plan =
    typeof epicData.plan === "object" && epicData.plan !== null && !Array.isArray(epicData.plan)
      ? (epicData.plan as Record<string, unknown>)
      : {};
  const refs = plan.references;
  const children: Child[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(refs)) return children;
  const byIssue = indexChildrenByIssueNumber(index);
  const epicIssue = options.epicIssueNumber ?? null;

  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    const refType = String(rec.type ?? "");

    if (referenceTypeMatches(refType, "plan")) {
      const name = basename(String(rec.uri ?? ""));
      const child = index[name];
      if (!child || seen.has(child.story_id)) continue;
      seen.add(child.story_id);
      children.push(child);
      continue;
    }

    if (referenceTypeMatches(refType, "github-issue")) {
      const [, number] = parseGithubIssueUri(rec.uri);
      if (number === null) continue;
      if (epicIssue !== null && number === epicIssue) continue;
      const fromIndex = byIssue.get(number);
      if (fromIndex) {
        if (seen.has(fromIndex.story_id)) continue;
        seen.add(fromIndex.story_id);
        children.push(fromIndex);
        continue;
      }
      // Synthetic child: hand-filed / issue:emit epic with issue-only child links.
      const syntheticId = `#${number}`;
      if (seen.has(syntheticId)) continue;
      seen.add(syntheticId);
      const title =
        typeof rec.title === "string" && rec.title.trim().length > 0
          ? rec.title.trim()
          : syntheticId;
      children.push({
        story_id: syntheticId,
        title,
        kind: "story",
        folder: UNKNOWN_FOLDER,
        depends_on: [],
        issue_number: number,
      });
    }
  }
  return children;
}

/**
 * Whether a child counts as open for current-shape + checklist (#1649 defect 3).
 * Prefer forge issue state when present; fall back to lifecycle folder.
 * `unknown` (issue-only, no local xBRIEF) counts open without forge confirmation.
 */
export function isChildOpen(
  child: Child,
  forgeStates?: ReadonlyMap<number, ForgeIssueState> | null,
): boolean {
  if (
    typeof child.issue_number === "number" &&
    forgeStates != null &&
    forgeStates.has(child.issue_number)
  ) {
    return forgeStates.get(child.issue_number) === "open";
  }
  if ((CLOSED_FOLDERS as readonly string[]).includes(child.folder)) return false;
  // proposed/pending/active/unknown (and any unexpected folder) → open
  return true;
}

/**
 * Reconcile umbrella issue-body checkboxes `- [ ] #N` / `- [x] #N` to child state (#1649).
 * Only lines that mention a known child issue number are rewritten; other checkboxes untouched.
 * Idempotent: returns `changed: false` when already correct.
 */
export function reconcileBodyChecklist(
  body: string,
  closedIssueNumbers: ReadonlySet<number>,
  knownIssueNumbers: ReadonlySet<number>,
): { body: string; changed: boolean } {
  if (knownIssueNumbers.size === 0) return { body, changed: false };
  const lines = body.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const match = CHECKLIST_ISSUE_LINE_RE.exec(line);
    if (!match) return line;
    const issueMatch = /#(\d+)\b/.exec(match[3] ?? "");
    if (!issueMatch?.[1]) return line;
    const issueNum = Number(issueMatch[1]);
    if (!knownIssueNumbers.has(issueNum)) return line;
    const wantChecked = closedIssueNumbers.has(issueNum);
    const isChecked = (match[2] ?? " ").toLowerCase() === "x";
    if (isChecked === wantChecked) return line;
    changed = true;
    const marker = wantChecked ? "x" : " ";
    return `${match[1]}[${marker}]${match[3]}`;
  });
  return { body: out.join("\n"), changed };
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
    try {
      editIssueCommentBody(repo, commentId, { body });
    } catch (exc) {
      const message = exc instanceof GitHubBodyError ? exc.message : String(exc);
      throw new UmbrellaScmError(`edit comment ${commentId} (${repo}) failed: ${message}`);
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number | null {
    try {
      const created = createIssueComment(repo, issueNumber, { body });
      return typeof created.id === "number" ? created.id : null;
    } catch (exc) {
      const message = exc instanceof GitHubBodyError ? exc.message : String(exc);
      throw new UmbrellaScmError(`create comment #${issueNumber} (${repo}) failed: ${message}`);
    }
  }

  fetchIssueStates(
    repo: string,
    issueNumbers: readonly number[],
  ): ReadonlyMap<number, ForgeIssueState> {
    const result = new Map<number, ForgeIssueState>();
    if (issueNumbers.length === 0) return result;
    const states = fetchIssueStates(repo, new Set(issueNumbers));
    if (states === null) {
      throw new UmbrellaScmError(`fetch issue states (${repo}) failed`);
    }
    for (const [num, state] of states) {
      if (!(state instanceof IssueState)) continue;
      const value = state.value.toUpperCase();
      if (value === "OPEN") result.set(num, "open");
      else if (value === "CLOSED") result.set(num, "closed");
      // NOT_FOUND / other → omit so folder fallback applies
    }
    return result;
  }

  fetchIssueBody(repo: string, issueNumber: number): string {
    try {
      return fetchIssueBody(repo, issueNumber);
    } catch (exc) {
      const message = exc instanceof GitHubBodyError ? exc.message : String(exc);
      throw new UmbrellaScmError(`fetch issue body #${issueNumber} (${repo}) failed: ${message}`);
    }
  }

  editIssueBody(repo: string, issueNumber: number, body: string): void {
    try {
      editIssueBody(repo, issueNumber, { body });
    } catch (exc) {
      const message = exc instanceof GitHubBodyError ? exc.message : String(exc);
      throw new UmbrellaScmError(`edit issue body #${issueNumber} (${repo}) failed: ${message}`);
    }
  }
}

function planShape(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
  options: {
    epicIssueNumber?: number | null;
    forgeStates?: ReadonlyMap<number, ForgeIssueState> | null;
  } = {},
): [Child[], Child[], string[][]] {
  const children = computeChildren(epicData, index, {
    epicIssueNumber: options.epicIssueNumber,
  });
  const openChildren = children
    .filter((c) => isChildOpen(c, options.forgeStates))
    .sort((a, b) => a.story_id.localeCompare(b.story_id));
  const closedChildren = children
    .filter((c) => !isChildOpen(c, options.forgeStates))
    .sort((a, b) => a.story_id.localeCompare(b.story_id));
  const waves = computeWaves(children);
  return [openChildren, closedChildren, waves];
}

function resolveForgeStates(
  client: UmbrellaClient,
  repo: string,
  children: readonly Child[],
): ReadonlyMap<number, ForgeIssueState> | null {
  if (typeof client.fetchIssueStates !== "function") return null;
  const numbers = children
    .map((c) => c.issue_number)
    .filter((n): n is number => typeof n === "number");
  if (numbers.length === 0) return null;
  return client.fetchIssueStates(repo, numbers);
}

function reconcileChecklistForEpic(
  client: UmbrellaClient,
  repo: string,
  issueNumber: number,
  closedChildren: readonly Child[],
  allChildren: readonly Child[],
  dryRun: boolean,
): "edited" | "unchanged" | "skipped" {
  if (typeof client.fetchIssueBody !== "function" || typeof client.editIssueBody !== "function") {
    return "skipped";
  }
  const known = new Set<number>();
  for (const c of allChildren) {
    if (typeof c.issue_number === "number") known.add(c.issue_number);
  }
  if (known.size === 0) return "skipped";
  const closed = new Set<number>();
  for (const c of closedChildren) {
    if (typeof c.issue_number === "number") closed.add(c.issue_number);
  }
  const currentBody = client.fetchIssueBody(repo, issueNumber);
  const { body: nextBody, changed } = reconcileBodyChecklist(currentBody, closed, known);
  if (!changed) return "unchanged";
  if (!dryRun) client.editIssueBody(repo, issueNumber, nextBody);
  return "edited";
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
    projectRoot: string;
    allowCrossRepo: boolean;
    repoAllowlist?: readonly string[];
    explicitRepo?: string | null;
  },
): UmbrellaChange {
  const mutateGate = isRepoMutationAllowed(options.repo, options.projectRoot, {
    allowCrossRepo: options.allowCrossRepo,
    allowlist: options.repoAllowlist,
    explicitRepo: options.explicitRepo ?? null,
  });
  if (!mutateGate.allowed) {
    throw new Error(mutateGate.reason ?? `refusing cross-repo mutation on ${options.repo}`);
  }

  // Resolve children once without forge state to know which issue numbers to fetch.
  const childrenProbe = computeChildren(epicData, index, {
    epicIssueNumber: options.number,
  });
  const forgeStates = resolveForgeStates(options.client, options.repo, childrenProbe);
  const [openChildren, closedChildren, waves] = planShape(epicData, index, {
    epicIssueNumber: options.number,
    forgeStates,
  });
  const allChildren = [...openChildren, ...closedChildren];
  const total = allChildren.length;

  const comments = options.client.fetchComments(options.repo, options.number);
  const existing = comments.find((c) => hasCurrentShape(c.body));

  let checklistAction: "edited" | "unchanged" | "skipped" = "skipped";
  try {
    checklistAction = reconcileChecklistForEpic(
      options.client,
      options.repo,
      options.number,
      closedChildren,
      allChildren,
      options.dryRun,
    );
  } catch (exc) {
    // Checklist is best-effort relative to comment path: surface as throw so
    // callers see the failure (body drift is the #1649 user-visible bug).
    throw new UmbrellaScmError(
      exc instanceof Error ? exc.message : `checklist reconcile failed: ${String(exc)}`,
    );
  }

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
      checklist_action: checklistAction,
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
    // Comment unchanged; still report edited when checklist flipped (#1649).
    const action = checklistAction === "edited" ? "edited" : "unchanged";
    return {
      story_id: options.storyId,
      repo: options.repo,
      issue_number: options.number,
      action,
      pass_n: prevPass,
      body: candidate,
      checklist_action: checklistAction,
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
    checklist_action: checklistAction,
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
  /** Opt in to mutating comments on issues outside the resolved project repo (#2601). */
  readonly allowCrossRepo?: boolean;
  readonly repoAllowlist?: readonly string[];
}

export function reconcileUmbrellas(
  projectRoot: string,
  options: ReconcileUmbrellasOptions = {},
): [number, ReconcileUmbrellasOutcome] {
  const root = resolve(projectRoot);
  let vbriefDir: string;
  try {
    vbriefDir = resolveLifecycleRoot(root);
  } catch {
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
      .filter((f) => hasArtifactSuffix(f))
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
      const storyId = String(plan.id ?? stripArtifactSuffix(file));

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
          projectRoot: root,
          allowCrossRepo: options.allowCrossRepo ?? false,
          repoAllowlist: options.repoAllowlist,
          explicitRepo: options.repo ?? null,
        });
        if (change.action === "unchanged") outcome.unchanged.push(change);
        else outcome.changed.push(change);
      } catch (exc) {
        outcome.errors.push({
          story_id: storyId,
          message: exc instanceof Error ? exc.message : String(exc),
        });
      }
    }
  }

  return [outcome.errors.length > 0 ? 1 : 0, outcome];
}

function formatChecklistSuffix(action: UmbrellaChange["checklist_action"]): string {
  if (action === undefined || action === "skipped") return "";
  return `; checklist=${action}`;
}

export function renderUmbrellasReport(outcome: ReconcileUmbrellasOutcome): string {
  const lines: string[] = ["vBRIEF reconcile umbrellas", ""];
  const suffix = outcome.dry_run ? " (dry-run)" : "";

  lines.push(`Changed${suffix}:`);
  if (outcome.changed.length > 0) {
    for (const c of outcome.changed) {
      lines.push(
        `- #${c.issue_number} (${c.repo}) [${c.story_id}]: ${c.action} -> pass-${c.pass_n}` +
          formatChecklistSuffix(c.checklist_action),
      );
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Unchanged:");
  if (outcome.unchanged.length > 0) {
    for (const c of outcome.unchanged) {
      lines.push(
        `- #${c.issue_number} (${c.repo}) [${c.story_id}]: pass-${c.pass_n}` +
          formatChecklistSuffix(c.checklist_action),
      );
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
    checklist_action: c.checklist_action ?? "skipped",
  });
  return {
    changed: outcome.changed.map(toChange),
    unchanged: outcome.unchanged.map(toChange),
    skipped_no_ref: [...outcome.skipped_no_ref],
    errors: outcome.errors.map((e) => ({ story_id: e.story_id, message: e.message })),
    dry_run: outcome.dry_run,
  };
}
