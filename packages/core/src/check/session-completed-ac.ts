/**
 * Check composition: verify:ac must not soft-skip after a same-session complete (#3357).
 *
 * "No story ever active this session" remains a legitimate skip.
 * "A story completed this session" targets xbrief/completed (most recent).
 * One remediation string when that target cannot be used.
 *
 * #5477: same-session rapid check may skip just-completed targeting when every
 * changed path is in the published lifecycle-maintenance set and the walk
 * target is not added or renamed. Unresolved change-set collection keeps
 * today's targeting. Membership is positive and literal (engine-constant).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { readRitualState } from "../session/ritual-sentinel.js";
import { parseTimestamp } from "../session/time.js";

/** One remediation when check cannot target the just-completed brief (#3357). */
export const SESSION_COMPLETED_AC_REMEDIATION =
  "Run task verify:ac -- xbrief/completed/<just-completed>.xbrief.json (a story completed this session; check must not soft-skip) (#3357)";

/** Project-relative marker written by scope:complete for this session (#3357). */
export const SESSION_COMPLETED_MARKER_REL = [".deft", "cache", "last-completed.json"] as const;

/**
 * Exact paths in the published lifecycle-maintenance set (#5477 Bound).
 * Engine-constant at this pin; a same-change-set policy rewrite cannot widen it.
 */
export const LIFECYCLE_MAINTENANCE_EXACT_PATHS = [
  "CHANGELOG.md",
  ".deft/plan-sequence.json",
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "xbrief/specification.xbrief.json",
  "xbrief/plan.xbrief.json",
  "vbrief/PROJECT-DEFINITION.vbrief.json",
  "vbrief/specification.vbrief.json",
  "vbrief/plan.vbrief.json",
] as const;

/** Directory prefixes in the published lifecycle-maintenance set (#5477 Bound). */
export const LIFECYCLE_MAINTENANCE_DIR_PREFIXES = [
  "xbrief/proposed/",
  "xbrief/pending/",
  "xbrief/active/",
  "xbrief/completed/",
  "xbrief/cancelled/",
  "vbrief/proposed/",
  "vbrief/pending/",
  "vbrief/active/",
  "vbrief/completed/",
  "vbrief/cancelled/",
] as const;

export interface SessionCompletedMarker {
  readonly path: string;
  readonly sessionId: string;
  readonly completedAt: string;
}

export type SessionCompletedAcTarget =
  | { readonly kind: "none" }
  | { readonly kind: "target"; readonly path: string }
  | { readonly kind: "cannot"; readonly message: string };

export interface ChangeSetPathFlags {
  readonly addedOrRenamed: boolean;
  readonly addedOrModified: boolean;
}

export type CollectedChangeSet =
  | {
      readonly ok: true;
      readonly paths: readonly string[];
      readonly flagsByPath: ReadonlyMap<string, ChangeSetPathFlags>;
    }
  | { readonly ok: false; readonly reason: string };

export interface ResolveSessionCompletedAcInput {
  readonly projectRoot: string;
  readonly sessionId?: string | null;
  readonly sessionStartedAt?: Date | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected change set (tests). Live path collects merge-base + local changes. */
  readonly changeSet?: CollectedChangeSet | null;
  readonly runGit?: GitRunner;
  readonly baseRef?: string | null;
}

interface CompletedBriefCandidate {
  readonly path: string;
  readonly completedAtMs: number;
  readonly sessionId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function sessionCompletedMarkerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...SESSION_COMPLETED_MARKER_REL);
}

/** Persist the just-completed brief so check can fail closed if that file is unreadable. */
export function writeSessionCompletedMarker(
  projectRoot: string,
  marker: SessionCompletedMarker,
): void {
  const root = resolve(projectRoot);
  const target = sessionCompletedMarkerPath(root);
  containedWrite({
    root,
    target,
    data: `${JSON.stringify(marker, null, 2)}\n`,
    mode: "replace",
    mkdir: true,
  });
}

function readSessionCompletedMarker(
  projectRoot: string,
): SessionCompletedMarker | "invalid" | null {
  const path = sessionCompletedMarkerPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const rec = asRecord(parsed);
    const briefPath = typeof rec?.path === "string" ? rec.path.trim() : "";
    const sessionId = typeof rec?.sessionId === "string" ? rec.sessionId.trim() : "";
    const completedAt = typeof rec?.completedAt === "string" ? rec.completedAt.trim() : "";
    if (briefPath.length === 0 || sessionId.length === 0) {
      return "invalid";
    }
    return { path: briefPath, sessionId, completedAt };
  } catch {
    return "invalid";
  }
}

function resolveSession(input: ResolveSessionCompletedAcInput): {
  readonly sessionId: string | null;
  readonly startedAt: Date | null;
} {
  const env = input.env ?? process.env;
  const injected = input.sessionId?.trim() ?? "";
  if (injected.length > 0) {
    return { sessionId: injected, startedAt: input.sessionStartedAt ?? null };
  }
  const fromEnv = typeof env.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "";
  const [state] = readRitualState(resolve(input.projectRoot));
  const ritualId = state?.sessionId.trim() ?? "";
  const sessionId = fromEnv.length > 0 ? fromEnv : ritualId;
  // Do not pair DEFT_SESSION_ID with a different ritual-state startedAt.
  const ritualStartedAt =
    ritualId.length > 0 && ritualId === sessionId ? (state?.startedAt ?? null) : null;
  return {
    sessionId: sessionId.length > 0 ? sessionId : null,
    startedAt: input.sessionStartedAt ?? ritualStartedAt,
  };
}

function listCompletedBriefPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  for (const dirName of ["xbrief", "vbrief"]) {
    const completed = join(projectRoot, dirName, "completed");
    if (!existsSync(completed)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(completed)
        .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      paths.push(join(completed, name));
    }
  }
  return paths;
}

function readCompletedCandidate(path: string): CompletedBriefCandidate | "unreadable" {
  if (!existsSync(path)) {
    return "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "unreadable";
  }
  const data = asRecord(parsed);
  const plan = asRecord(data?.plan);
  if (plan === null) {
    return "unreadable";
  }
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    // Historical completed briefs (pre-#3357) often have no plan.metadata.
    // That is not an unreadable this-session target (#3375).
    return { path, completedAtMs: 0, sessionId: null };
  }
  const sessionRaw =
    typeof meta.completedSessionId === "string" ? meta.completedSessionId.trim() : "";
  const completedAt = parseTimestamp(meta.completedAt);
  return {
    path,
    completedAtMs: completedAt?.getTime() ?? 0,
    sessionId: sessionRaw.length > 0 ? sessionRaw : null,
  };
}

function isSameSession(
  candidate: CompletedBriefCandidate,
  sessionId: string | null,
  startedAt: Date | null,
): boolean {
  if (sessionId !== null && candidate.sessionId === sessionId) {
    return true;
  }
  // Timestamp fallback only for pre-#3357 briefs that never stamped a session id.
  // A brief stamped for a different session must not replace this session's target.
  if (
    candidate.sessionId === null &&
    startedAt !== null &&
    candidate.completedAtMs >= startedAt.getTime()
  ) {
    return true;
  }
  return false;
}

/** Normalize a repo-relative path for membership and change-set compares (#5477). */
export function normalizeLifecycleRelPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

/** True when path is a positive literal member of the published set (#5477). */
export function isLifecycleMaintenancePath(relPath: string): boolean {
  const norm = normalizeLifecycleRelPath(relPath);
  if (norm.length === 0) return false;
  if ((LIFECYCLE_MAINTENANCE_EXACT_PATHS as readonly string[]).includes(norm)) {
    return true;
  }
  return (LIFECYCLE_MAINTENANCE_DIR_PREFIXES as readonly string[]).some(
    (prefix) => norm.startsWith(prefix) && norm.length > prefix.length,
  );
}

/** True when a walk target sits under xbrief/completed or vbrief/completed. */
export function isCompletedLifecycleWalkTarget(relOrAbsPath: string, projectRoot?: string): boolean {
  const rel =
    projectRoot !== undefined
      ? toProjectRelPath(projectRoot, relOrAbsPath)
      : normalizeLifecycleRelPath(relOrAbsPath);
  return (
    (rel.startsWith("xbrief/completed/") || rel.startsWith("vbrief/completed/")) &&
    (rel.endsWith(".xbrief.json") || rel.endsWith(".vbrief.json"))
  );
}

export function toProjectRelPath(projectRoot: string, path: string): string {
  const root = resolve(projectRoot);
  const abs = resolve(path);
  if (abs === root || abs.startsWith(root + sep) || abs.startsWith(`${root}/`)) {
    return normalizeLifecycleRelPath(relative(root, abs));
  }
  return normalizeLifecycleRelPath(path);
}

function decodeGitPath(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\([abtnvfr"\\])/g, (_m, ch: string) => {
        const map: Record<string, string> = {
          a: "\u0007",
          b: "\b",
          t: "\t",
          n: "\n",
          v: "\v",
          f: "\f",
          r: "\r",
          '"': '"',
          "\\": "\\",
        };
        return map[ch] ?? ch;
      })
      .replace(/\\([0-7]{1,3})/g, (_m, oct: string) =>
        String.fromCharCode(Number.parseInt(oct, 8)),
      );
  }
  return t;
}

function splitNulPaths(stdout: string): string[] {
  return stdout
    .split("\0")
    .map((entry) => Buffer.from(entry, "latin1").toString("utf8"))
    .filter((entry) => entry.length > 0);
}

interface MutableFlags {
  addedOrRenamed: boolean;
  addedOrModified: boolean;
}

function ensureFlags(map: Map<string, MutableFlags>, path: string): MutableFlags {
  const existing = map.get(path);
  if (existing !== undefined) return existing;
  const created = { addedOrRenamed: false, addedOrModified: false };
  map.set(path, created);
  return created;
}

function applyNameStatusToken(
  paths: Set<string>,
  flags: Map<string, MutableFlags>,
  status: string,
  pathA: string,
  pathB: string | null,
): void {
  const code = status.trim();
  if (code.length === 0) return;
  if (code.startsWith("R") || code.startsWith("C")) {
    const oldPath = normalizeLifecycleRelPath(pathA);
    const newPath = normalizeLifecycleRelPath(pathB ?? "");
    if (oldPath.length > 0) {
      paths.add(oldPath);
      const f = ensureFlags(flags, oldPath);
      f.addedOrRenamed = true;
    }
    if (newPath.length > 0) {
      paths.add(newPath);
      const f = ensureFlags(flags, newPath);
      f.addedOrRenamed = true;
      f.addedOrModified = true;
    }
    return;
  }
  const path = normalizeLifecycleRelPath(pathA);
  if (path.length === 0) return;
  paths.add(path);
  const f = ensureFlags(flags, path);
  if (code.startsWith("A")) {
    f.addedOrRenamed = true;
    f.addedOrModified = true;
  } else if (code.startsWith("M")) {
    f.addedOrModified = true;
  }
}

function ingestNameStatusZ(
  stdout: string,
  paths: Set<string>,
  flags: Map<string, MutableFlags>,
): void {
  const tokens = splitNulPaths(stdout);
  let i = 0;
  while (i < tokens.length) {
    const status = (tokens[i] ?? "").trim();
    if (status.length === 0) {
      i += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      applyNameStatusToken(paths, flags, status, tokens[i + 1] ?? "", tokens[i + 2] ?? null);
      i += 3;
      continue;
    }
    applyNameStatusToken(paths, flags, status, tokens[i + 1] ?? "", null);
    i += 2;
  }
}

function resolveMergeBaseRef(
  projectRoot: string,
  runGit: GitRunner,
  override?: string | null,
): string | null {
  const envCandidates = [
    override,
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    const ran = runGit(projectRoot, ["rev-parse", "--verify", "-q", `${cand}^{commit}`]);
    if (ran.code === 0) return cand;
  }
  return null;
}

/**
 * Collect merge-base + local (committed/staged/unstaged/untracked) paths.
 * Rename rows keep both endpoints. Fail-closed when git cannot answer (#5477).
 */
export function collectLifecycleChangeSet(input: {
  readonly projectRoot: string;
  readonly runGit?: GitRunner;
  readonly baseRef?: string | null;
}): CollectedChangeSet {
  const projectRoot = resolve(input.projectRoot);
  const runGit = input.runGit ?? defaultGitRunner;
  const inside = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, reason: "not a git working tree" };
  }
  const baseRef = resolveMergeBaseRef(projectRoot, runGit, input.baseRef);
  if (baseRef === null) {
    return { ok: false, reason: "no merge-base ref" };
  }

  const paths = new Set<string>();
  const flags = new Map<string, MutableFlags>();

  const committed = runGit(projectRoot, [
    "diff",
    "-z",
    "--name-status",
    "--find-renames",
    `${baseRef}...HEAD`,
  ]);
  if (committed.code !== 0) {
    return { ok: false, reason: `git diff name-status ${baseRef}...HEAD failed` };
  }
  ingestNameStatusZ(committed.stdout, paths, flags);

  const vsHead = runGit(projectRoot, ["diff", "-z", "--name-status", "--find-renames", "HEAD"]);
  if (vsHead.code !== 0) {
    return { ok: false, reason: "git diff name-status HEAD failed" };
  }
  ingestNameStatusZ(vsHead.stdout, paths, flags);

  const cached = runGit(projectRoot, [
    "diff",
    "-z",
    "--cached",
    "--name-status",
    "--find-renames",
  ]);
  if (cached.code !== 0) {
    return { ok: false, reason: "git diff --cached name-status failed" };
  }
  ingestNameStatusZ(cached.stdout, paths, flags);

  const untracked = runGit(projectRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (untracked.code !== 0) {
    return { ok: false, reason: "git ls-files --others failed" };
  }
  for (const raw of splitNulPaths(untracked.stdout)) {
    const path = normalizeLifecycleRelPath(decodeGitPath(raw));
    if (path.length === 0) continue;
    paths.add(path);
    const f = ensureFlags(flags, path);
    f.addedOrRenamed = true;
    f.addedOrModified = true;
  }

  const flagsByPath = new Map<string, ChangeSetPathFlags>();
  for (const [path, f] of flags) {
    flagsByPath.set(path, {
      addedOrRenamed: f.addedOrRenamed,
      addedOrModified: f.addedOrModified,
    });
  }
  return { ok: true, paths: [...paths], flagsByPath };
}

export type LifecycleMaintenanceEligibility =
  | { readonly kind: "skip-targeting" }
  | { readonly kind: "in-diff-completed-overlay"; readonly walkTargetRel: string }
  | { readonly kind: "keep-targeting"; readonly reason: string };

/**
 * Decide #5477 item-2 skip vs item-3 overlay vs keep targeting.
 * Unmatched paths and failed collection keep targeting.
 */
export function evaluateLifecycleMaintenanceEligibility(input: {
  readonly walkTargetAbsOrRel: string;
  readonly projectRoot: string;
  readonly changeSet: CollectedChangeSet;
}): LifecycleMaintenanceEligibility {
  if (!input.changeSet.ok) {
    return { kind: "keep-targeting", reason: input.changeSet.reason };
  }
  const walkRel = toProjectRelPath(input.projectRoot, input.walkTargetAbsOrRel);
  if (walkRel.length === 0) {
    return { kind: "keep-targeting", reason: "empty walk target" };
  }
  for (const path of input.changeSet.paths) {
    if (!isLifecycleMaintenancePath(path)) {
      return { kind: "keep-targeting", reason: `unmatched path ${path}` };
    }
  }
  const flags = input.changeSet.flagsByPath.get(walkRel);
  const addedOrRenamed = flags?.addedOrRenamed === true;
  const addedOrModified = flags?.addedOrModified === true;
  if (!addedOrRenamed) {
    return { kind: "skip-targeting" };
  }
  if (isCompletedLifecycleWalkTarget(walkRel) && addedOrModified) {
    return { kind: "in-diff-completed-overlay", walkTargetRel: walkRel };
  }
  return { kind: "keep-targeting", reason: "walk target added or renamed" };
}

function maybeSkipLifecycleOnlyTarget(
  projectRoot: string,
  targetAbs: string,
  input: ResolveSessionCompletedAcInput,
): SessionCompletedAcTarget {
  const changeSet =
    input.changeSet !== undefined && input.changeSet !== null
      ? input.changeSet
      : collectLifecycleChangeSet({
          projectRoot,
          runGit: input.runGit,
          baseRef: input.baseRef,
        });
  const decision = evaluateLifecycleMaintenanceEligibility({
    walkTargetAbsOrRel: targetAbs,
    projectRoot,
    changeSet,
  });
  if (decision.kind === "skip-targeting") {
    return { kind: "none" };
  }
  return { kind: "target", path: targetAbs };
}

/**
 * Resolve the just-completed brief for this session, if check must target it.
 */
export function resolveSessionCompletedVerifyAcTarget(
  input: ResolveSessionCompletedAcInput,
): SessionCompletedAcTarget {
  const projectRoot = resolve(input.projectRoot);
  const { sessionId, startedAt } = resolveSession(input);
  const marker = readSessionCompletedMarker(projectRoot);
  if (marker === "invalid" && sessionId !== null) {
    return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
  }
  if (
    marker !== null &&
    marker !== "invalid" &&
    sessionId !== null &&
    marker.sessionId === sessionId
  ) {
    const candidate = readCompletedCandidate(marker.path);
    if (candidate === "unreadable") {
      return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
    }
    return maybeSkipLifecycleOnlyTarget(projectRoot, candidate.path, input);
  }
  const paths = listCompletedBriefPaths(projectRoot);
  if (paths.length === 0 || (sessionId === null && startedAt === null)) {
    return { kind: "none" };
  }

  const matched: CompletedBriefCandidate[] = [];
  let unreadableCount = 0;
  for (const path of paths) {
    const candidate = readCompletedCandidate(path);
    if (candidate === "unreadable") {
      unreadableCount += 1;
      continue;
    }
    if (isSameSession(candidate, sessionId, startedAt)) {
      matched.push(candidate);
    }
  }

  if (matched.length === 0) {
    // Any unreadable completed brief may be this session's target.
    if (unreadableCount > 0) {
      return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
    }
    return { kind: "none" };
  }

  matched.sort((a, b) => {
    if (a.completedAtMs !== b.completedAtMs) {
      return b.completedAtMs - a.completedAtMs;
    }
    return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
  });
  const latest = matched[0];
  if (latest === undefined) {
    return { kind: "none" };
  }
  const verified = readCompletedCandidate(latest.path);
  if (verified === "unreadable") {
    return { kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION };
  }
  return maybeSkipLifecycleOnlyTarget(projectRoot, verified.path, input);
}
