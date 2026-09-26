/**
 * Refuse newly added completed/ blobs that bypass runTransition (#3679),
 * and refuse a source D or rename-from of active/ with no paired stamped
 * destination (#3766). Leftover park of still-open work pairs active/ to
 * proposed/ when plan.status is proposed or draft, there is no cancel
 * stamp, and no origin GitHub issue is closed. Parking an open issue off
 * origin/master active/ is proposed/, not cancelled/. A closed origin
 * issue refuses that park when current forge state confirms closure, or when
 * a failed live lookup leaves a cached closure as the safest available state.
 * A successful live lookup overrides cache state after an issue is reopened.
 *
 * A modification of an existing completed/ file can pair an active deletion
 * when the net tree against the merge base differs on that path, the plan
 * carries a complete lifecycleWrite, pairingKey and planIdentity match, and
 * transitionWriteFitsFolder accepts completed (#4906). Merge-base presence
 * alone does not. A committed edit the worktree restores to the merge-base
 * blob does not. A D or R of that completed path does not.
 *
 * Historical corpus is advisory (doctor). New work in the change set is hard
 * (verify:completed-write-guard). Does not read completionProvenance and does
 * not change verify:completed-tracked.
 *
 * Disk reads are capped at COMPLETED_WRITE_GUARD_MAX_BYTES so a huge
 * contributor-controlled completed/ blob fails through the guard instead of
 * exhausting memory on the required gate path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import {
  hasTransitionWrite,
  LEFTOVER_LAND_PR_REMEDIATION,
  transitionWriteFitsFolder,
} from "../scope/lifecycle-write.js";
import { resolveDefaultBaseRef, unquoteGitPath } from "../scope-provenance/evaluate.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";

export type CompletedWriteGuardCode = 0 | 1 | 2;

export interface CompletedWriteGuardFinding {
  readonly relPath: string;
  readonly detail: string;
}

export interface CompletedWriteGuardResult {
  readonly code: CompletedWriteGuardCode;
  readonly message: string;
  readonly findings: readonly CompletedWriteGuardFinding[];
}

export interface CompletedWriteGuardOptions {
  readonly baseRef?: string;
  /** Inject added repo-relative POSIX paths (skips git). Synthesized as A records. */
  readonly addedFiles?: readonly string[];
  /**
   * Inject git `--name-status` stdout (skips git). Same parser as discovery.
   * Takes precedence over `addedFiles` when both are set.
   */
  readonly nameStatus?: string;
  /** Inject payloads: relPath -> raw JSON. */
  readonly payloads?: ReadonlyMap<string, string>;
  /**
   * Inject origin GitHub issue state keyed by lowercase URI.
   * Overrides the on-disk github-issue cache for the same URI.
   */
  readonly issueStates?: ReadonlyMap<string, "open" | "closed">;
  /** Resolve current issue state from the forge. Live state overrides cached state. */
  readonly runGh?: (args: readonly string[]) => {
    readonly returncode: number;
    readonly stdout: string;
  };
}

/**
 * In-repo completed xBRIEFs average ~5.5 KiB and peak near 44 KiB.
 * 1 MiB is ~23× that peak and still refuses a multi-hundred-MB add
 * before the bytes are loaded.
 */
export const COMPLETED_WRITE_GUARD_MAX_BYTES = 1_048_576;

const COMPLETED_REL_RE = /^(?:xbrief|vbrief)\/completed\/[^/]+$/;
const ACTIVE_REL_RE = /^(?:xbrief|vbrief)\/active\/[^/]+$/;
const CANCELLED_REL_RE = /^(?:xbrief|vbrief)\/cancelled\/[^/]+$/;
const PROPOSED_REL_RE = /^(?:xbrief|vbrief)\/proposed\/[^/]+$/;

/** Halt copy for a true unpaired active/ D or rename-from (#3766). */
export const UNPAIRED_ACTIVE_DELETE_REMEDIATION =
  "Halt: run `task scope:complete` or `task scope:cancel` so the destination is stamped, " +
  "park still-open leftover to proposed/ with plan.status proposed, or leave the brief untracked. " +
  "Lone-D untracking cleanup is not an authorization token (#3766).";

/**
 * Halt when a same-basename completed twin survives, but this diff is not the
 * admitted restamp (#4906). Does not send scope:complete at the leftover active path.
 */
export const ACTIVE_TWIN_RESTAMP_REMEDIATION =
  "Halt: restamp the existing completed/ twin in this same change and delete the leftover active file together. " +
  "The admitted cleanup is that modification plus the deletion. " +
  "Do not point scope:complete at the leftover active file. " +
  "Lone-D untracking cleanup is not an authorization token (#3766).";

/**
 * Halt when leftover park would move a closed issue's active brief to
 * proposed/. Closed work needs completed/ or cancelled/ plus evidence.
 */
export const CLOSED_ISSUE_PARK_REMEDIATION =
  "Halt: a closed GitHub issue cannot park to proposed/. " +
  "Move the brief to completed/ or cancelled/ with a runTransition stamp and evidence. " +
  "Open-issue leftover park remains allowed.";

interface NameStatusRecord {
  readonly status: "A" | "D" | "M" | "R";
  readonly src: string;
  readonly dest: string;
}

function normalizeRepoRelPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function lastPathSegment(relPath: string): string {
  const n = normalizeRepoRelPath(relPath);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

function sanitizeDetail(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

function isCompletedArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!COMPLETED_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function isActiveArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!ACTIVE_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function isCancelledArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!CANCELLED_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

function isProposedArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!PROPOSED_REL_RE.test(n)) {
    return false;
  }
  return hasArtifactSuffix(lastPathSegment(n));
}

/** Leftover park of still-open work: proposed/ dest, non-terminal, no cancel stamp. */
function leftoverParkFitsProposed(plan: Record<string, unknown>): boolean {
  const status = String(plan.status ?? "");
  if (status !== "proposed" && status !== "draft") {
    return false;
  }
  const meta = plan.metadata;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return true;
  }
  const stamp = (meta as Record<string, unknown>).lifecycleWrite;
  if (typeof stamp !== "object" || stamp === null || Array.isArray(stamp)) {
    return true;
  }
  return (stamp as Record<string, unknown>).action !== "cancel";
}

function originIssueUris(plan: Record<string, unknown>): string[] {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return [];
  }
  const issues: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
    const type = String(rec.type ?? "");
    const uri = String(rec.uri ?? "")
      .trim()
      .toLowerCase();
    if (type.includes("github-issue") && uri.length > 0) {
      issues.push(uri);
    }
  }
  return issues.sort();
}

function originIssueKey(plan: Record<string, unknown>): string {
  return originIssueUris(plan).join("|");
}

function readCachedGithubIssueState(projectRoot: string, uri: string): "open" | "closed" | null {
  const [repo, number] = parseGithubIssueUri(uri);
  if (repo === null || number === null) {
    return null;
  }
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    return null;
  }
  const rawPath = join(
    projectRoot,
    CACHE_DIR_NAME,
    CACHE_SOURCE_GITHUB_ISSUE,
    owner,
    name,
    String(number),
    "raw.json",
  );
  try {
    const parsed: unknown = JSON.parse(readFileSync(rawPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const requestedHost = githubIssueHostname(uri);
    if (requestedHost !== null && requestedHost !== "github.com") {
      const cachedUrl = String(record.html_url ?? "");
      let cachedHost: string | null = null;
      try {
        cachedHost = new URL(cachedUrl).host.toLowerCase();
      } catch {
        // Enterprise cache entries must carry a URL that binds them to the host.
      }
      if (cachedHost !== requestedHost) {
        return null;
      }
    }
    const state = String(record.state ?? "").toLowerCase();
    return state === "open" || state === "closed" ? state : null;
  } catch {
    return null;
  }
}

function githubIssueHostname(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host.length > 0) {
      return parsed.host.toLowerCase();
    }
  } catch {
    // Non-URL reference forms have no explicit Enterprise host.
  }
  return null;
}

function resolveOriginIssueState(
  uri: string,
  projectRoot: string,
  options: CompletedWriteGuardOptions,
): "open" | "closed" | "unknown" {
  const key = uri.trim().toLowerCase();
  const injected = options.issueStates?.get(key);
  if (injected === "open" || injected === "closed") {
    return injected;
  }
  const [repo, number] = parseGithubIssueUri(key);
  if (options.runGh !== undefined && repo !== null && number !== null) {
    const hostname = githubIssueHostname(key);
    const hostArgs = hostname !== null && hostname !== "github.com" ? ["--hostname", hostname] : [];
    const live = options.runGh(["gh", "api", ...hostArgs, `repos/${repo}/issues/${number}`]);
    if (live.returncode === 0) {
      try {
        const parsed: unknown = JSON.parse(live.stdout);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const state = String((parsed as Record<string, unknown>).state ?? "").toLowerCase();
          if (state === "open" || state === "closed") {
            return state;
          }
        }
      } catch {
        // Fall back to cache below. A successful live lookup is the only way
        // to override a cached closure after an issue is reopened.
      }
    }
  }
  const cached = readCachedGithubIssueState(projectRoot, key);
  return cached ?? "unknown";
}

function leftoverParkBlockedByClosedIssue(
  plan: Record<string, unknown>,
  projectRoot: string,
  options: CompletedWriteGuardOptions,
): boolean {
  for (const uri of originIssueUris(plan)) {
    if (resolveOriginIssueState(uri, projectRoot, options) === "closed") {
      return true;
    }
  }
  return false;
}

function planIdentity(plan: Record<string, unknown>): string {
  const title = String(plan.title ?? "").trim();
  const origin = originIssueKey(plan);
  return [title, origin].filter((part) => part.length > 0).join("\n");
}

function pairingKey(relPath: string): string | null {
  const n = normalizeRepoRelPath(relPath);
  const family = n.startsWith("xbrief/") ? "xbrief" : n.startsWith("vbrief/") ? "vbrief" : null;
  const base = lastPathSegment(n);
  if (family === null || base.length === 0) {
    return null;
  }
  return `${family}/${base}`;
}

function completedTwinRel(activeRel: string): string | null {
  const n = normalizeRepoRelPath(activeRel);
  const base = lastPathSegment(n);
  if (base.length === 0) {
    return null;
  }
  if (n.startsWith("xbrief/active/")) {
    return `xbrief/completed/${base}`;
  }
  if (n.startsWith("vbrief/active/")) {
    return `vbrief/completed/${base}`;
  }
  return null;
}

/** Complete action stamp. Legacy completedAt and fail stamps are not this token (#4906). */
function hasCompleteLifecycleWrite(plan: Record<string, unknown>): boolean {
  const meta = plan.metadata;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return false;
  }
  const stamp = (meta as Record<string, unknown>).lifecycleWrite;
  if (typeof stamp !== "object" || stamp === null || Array.isArray(stamp)) {
    return false;
  }
  const rec = stamp as Record<string, unknown>;
  const writtenAt = rec.writtenAt;
  return rec.action === "complete" && typeof writtenAt === "string" && writtenAt.trim().length > 0;
}

function parsePlan(raw: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const plan = (data as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return null;
    }
    return plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  return env;
}

function git(args: string[], projectRoot: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(projectRoot),
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args.join(" ")} failed: ${String(e.message)}`);
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw new GitCommandError(`git ${args.join(" ")} killed by signal ${String(result.signal)}`);
  }
  const status = result.status ?? 1;
  const stderr = String(result.stderr ?? "").trim();
  if (status !== 0 && stderr.length > 0) {
    return { status, stdout: `${result.stdout ?? ""}\n${stderr}` };
  }
  return { status, stdout: result.stdout ?? "" };
}

function parseNameStatusRecords(stdout: string): NameStatusRecord[] {
  const out: NameStatusRecord[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (t.length === 0) {
      continue;
    }
    const parts = t.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("A")) {
      const path = parts[1];
      if (path !== undefined) {
        const n = normalizeRepoRelPath(unquoteGitPath(path));
        out.push({ status: "A", src: n, dest: n });
      }
    } else if (status.startsWith("D")) {
      const path = parts[1];
      if (path !== undefined) {
        const n = normalizeRepoRelPath(unquoteGitPath(path));
        out.push({ status: "D", src: n, dest: n });
      }
    } else if (status.startsWith("M")) {
      const path = parts[1];
      if (path !== undefined) {
        const n = normalizeRepoRelPath(unquoteGitPath(path));
        out.push({ status: "M", src: n, dest: n });
      }
    } else if (status.startsWith("R")) {
      const srcRaw = parts[1];
      const destRaw = parts[2] ?? parts[1];
      if (srcRaw !== undefined && destRaw !== undefined) {
        out.push({
          status: "R",
          src: normalizeRepoRelPath(unquoteGitPath(srcRaw)),
          dest: normalizeRepoRelPath(unquoteGitPath(destRaw)),
        });
      }
    }
  }
  return out;
}

function discoverNameStatusRecords(projectRoot: string, baseRef: string): NameStatusRecord[] {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveDefaultBaseRef(projectRoot);
    if (upgraded === null) {
      throw new GitCommandError(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF)",
      );
    }
    resolved = upgraded;
  }
  const hasBase = git(["rev-parse", "--verify", "-q", resolved], projectRoot).status === 0;
  if (!hasBase) {
    throw new GitCommandError(`base ref '${resolved}' not found; pass --base-ref`);
  }
  const records: NameStatusRecord[] = [];
  // Net worktree against the merge base. Gluing `base...HEAD` to `git diff HEAD`
  // keeps an M after the worktree has restored the merge-base blob (#4906).
  let left = resolved;
  let right = "HEAD";
  if (resolved.includes("...")) {
    const parts = resolved.split("...");
    const rawLeft = (parts[0] ?? "").trim();
    const rawRight = (parts[1] ?? "").trim();
    left = rawLeft.length > 0 ? rawLeft : "HEAD";
    right = rawRight.length > 0 ? rawRight : "HEAD";
  }
  const mergeBase = git(["merge-base", left, right], projectRoot);
  // `range` keeps this throw's statement text on the prior site. Command
  // failure and an empty sha both use it. A second throw is a new fact.
  const range = resolved;
  const baseSha = mergeBase.status === 0 ? mergeBase.stdout.trim() : "";
  if (baseSha.length === 0) {
    const detail =
      mergeBase.status !== 0
        ? mergeBase.stdout.trim() || `git merge-base exited ${String(mergeBase.status)}`
        : "empty merge-base";
    throw new GitCommandError(
      `committed change-set unavailable for '${range}': ${detail}. ` +
        "Pass --base-ref to a merge-base ancestor of HEAD.",
    );
  }
  const net = git(["diff", "-M", "--name-status", "--diff-filter=ARDM", baseSha], projectRoot);
  if (net.status !== 0) {
    const detail = net.stdout.trim() || `git diff ${baseSha} exited ${String(net.status)}`;
    throw new GitCommandError(`working-tree change-set unavailable: ${detail}`);
  }
  records.push(...parseNameStatusRecords(net.stdout));
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status !== 0) {
    const detail = untracked.stdout.trim() || `git ls-files exited ${String(untracked.status)}`;
    throw new GitCommandError(`untracked change-set unavailable: ${detail}`);
  }
  const untrackedAsAdds: string[] = [];
  for (const line of untracked.stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (t.length > 0) {
      untrackedAsAdds.push(`A\t${t}`);
    }
  }
  records.push(...parseNameStatusRecords(untrackedAsAdds.join("\n")));
  return records;
}

type PayloadRead =
  | { readonly kind: "ok"; readonly raw: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly detail: string };

function readPayload(
  projectRoot: string,
  relPath: string,
  payloads: ReadonlyMap<string, string> | undefined,
): PayloadRead {
  const n = normalizeRepoRelPath(relPath);
  const injected = payloads?.get(n);
  if (injected !== undefined) {
    if (injected.length > COMPLETED_WRITE_GUARD_MAX_BYTES) {
      return {
        kind: "unsafe",
        detail:
          `${n}: completed/ artifact is ${String(injected.length)} bytes; ` +
          `exceeds the ${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
      };
    }
    return { kind: "ok", raw: injected };
  }
  const parts = n.split("/").filter((part) => part.length > 0 && part !== ".");
  let abs = resolve(projectRoot);
  let st: Stats | undefined;
  for (const part of parts) {
    if (part === "..") {
      return {
        kind: "unsafe",
        detail: `${n}: completed/ path escapes project root; refuse without following`,
      };
    }
    abs = join(abs, part);
    try {
      st = lstatSync(abs);
    } catch {
      return { kind: "missing" };
    }
    if (st.isSymbolicLink()) {
      return {
        kind: "unsafe",
        detail: `${n}: completed/ path contains a symlink; refuse without following`,
      };
    }
  }
  if (st === undefined || !st.isFile()) {
    return {
      kind: "unsafe",
      detail: `${n}: completed/ add is not a regular file; refuse without reading`,
    };
  }
  if (st.size > COMPLETED_WRITE_GUARD_MAX_BYTES) {
    return {
      kind: "unsafe",
      detail:
        `${n}: completed/ artifact is ${String(st.size)} bytes; ` +
        `exceeds the ${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
    };
  }
  try {
    return { kind: "ok", raw: readFileSync(abs, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Hard check: newly added completed/ artifacts must show runTransition evidence,
 * and active/ D or rename-from must pair with a stamped terminal destination.
 */
export function evaluateCompletedWriteGuard(
  projectRoot: string,
  options: CompletedWriteGuardOptions = {},
): CompletedWriteGuardResult {
  const root = resolve(projectRoot);
  let records: readonly NameStatusRecord[];
  let pairingBaseRef = options.baseRef ?? "";
  try {
    if (options.nameStatus !== undefined) {
      records = parseNameStatusRecords(options.nameStatus);
    } else if (options.addedFiles !== undefined) {
      records = parseNameStatusRecords(
        options.addedFiles.map((rel) => `A\t${normalizeRepoRelPath(rel)}`).join("\n"),
      );
    } else {
      const inside = git(["rev-parse", "--is-inside-work-tree"], root);
      if (inside.status !== 0 || inside.stdout.trim() !== "true") {
        return {
          code: 0,
          findings: [],
          message: "verify_completed_write_guard: skipped -- not a git working tree.",
        };
      }
      let baseRef = options.baseRef ?? "";
      if (baseRef.length === 0 || baseRef === "HEAD") {
        const resolved = resolveDefaultBaseRef(root);
        if (resolved === null) {
          return {
            code: 2,
            findings: [],
            message:
              "verify_completed_write_guard: no merge-base ref found " +
              "(origin/master|main, DEFT_BASE_REF, or GITHUB_BASE_REF). " +
              "Pass --base-ref. Unguarded completed/ adds cannot be skipped.",
          };
        }
        baseRef = resolved;
      }
      records = discoverNameStatusRecords(root, baseRef);
      pairingBaseRef = baseRef;
    }
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return {
        code: 2,
        findings: [],
        message:
          "verify_completed_write_guard: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      };
    }
    if (err instanceof GitCommandError) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          code: 0,
          findings: [],
          message: `verify_completed_write_guard: skipped -- not a git working tree (${err.message}).`,
        };
      }
      return {
        code: 2,
        findings: [],
        message: `verify_completed_write_guard: git failed -- ${err.message}`,
      };
    }
    throw err;
  }

  const added = [
    ...new Set(
      records.filter((rec) => rec.status === "A" || rec.status === "R").map((rec) => rec.dest),
    ),
  ];

  const findings: CompletedWriteGuardFinding[] = [];
  // Pairing: stamped completed/ or cancelled/ dest (#3766 / #4784), or leftover
  // park to proposed/ (plan.status proposed|draft, no cancel stamp, origin
  // GitHub issue not closed). Cancel stamps lifecycleWrite action=cancel.
  // Status-only cancelled dests do not pair. Closed origin issues refuse
  // proposed/ pairing when live forge state confirms closure, or a failed
  // live lookup leaves cached closure as the safest available state. A
  // successful live lookup overrides cache after an issue is reopened.
  // R dests are git-bound to src. D+A also requires pairingKey plus dest
  // plan.title and origin issue refs to match the recovered source so a copied
  // stamp cannot authorize an unrelated deletion. Item titles and narratives
  // are not pairing identity (#4784).
  // An M of completed/ is a dest only with a complete lifecycleWrite plus the
  // same folder stamp check (#4906). A D or R of that path is not a surviving twin.
  interface AuthDest {
    readonly rel: string;
    readonly key: string;
    readonly identity: string;
  }
  const authorizedDests: AuthDest[] = [];
  const closedParkIdentities = new Set<string>();

  const removedSrc = new Set(
    records.filter((rec) => rec.status === "D" || rec.status === "R").map((rec) => rec.src),
  );

  const rememberDest = (rel: string, plan: Record<string, unknown>): void => {
    if (removedSrc.has(rel)) {
      return;
    }
    const key = pairingKey(rel);
    const identity = planIdentity(plan);
    if (key !== null && identity.length > 0) {
      authorizedDests.push({ rel, key, identity });
    }
  };

  for (const rel of added) {
    if (isProposedArtifactRel(rel)) {
      const payload = readPayload(root, rel, options.payloads);
      if (payload.kind !== "ok") {
        continue;
      }
      const plan = parsePlan(payload.raw);
      if (plan !== null && leftoverParkFitsProposed(plan)) {
        if (leftoverParkBlockedByClosedIssue(plan, root, options)) {
          const identity = planIdentity(plan);
          if (identity.length > 0) {
            closedParkIdentities.add(identity);
          }
        } else {
          rememberDest(rel, plan);
        }
      }
      continue;
    }
    if (isCancelledArtifactRel(rel)) {
      const payload = readPayload(root, rel, options.payloads);
      if (payload.kind !== "ok") {
        continue;
      }
      const plan = parsePlan(payload.raw);
      if (plan !== null && transitionWriteFitsFolder(plan, "cancelled")) {
        rememberDest(rel, plan);
      }
      continue;
    }
    if (!isCompletedArtifactRel(rel)) {
      continue;
    }
    const payload = readPayload(root, rel, options.payloads);
    if (payload.kind === "missing") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ but unreadable`),
      });
      continue;
    }
    if (payload.kind === "unsafe") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(payload.detail),
      });
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ with unreadable plan`),
      });
      continue;
    }
    if (!transitionWriteFitsFolder(plan, "completed")) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: added under completed/ without a runTransition write`),
      });
      continue;
    }
    rememberDest(rel, plan);
  }

  const activePairKeys = new Set(
    records
      .filter((rec) => (rec.status === "D" || rec.status === "R") && isActiveArtifactRel(rec.src))
      .map((rec) => pairingKey(rec.src))
      .filter((key): key is string => key !== null),
  );
  for (const rec of records) {
    if (rec.status !== "M" || !isCompletedArtifactRel(rec.src)) {
      continue;
    }
    const rel = rec.src;
    const key = pairingKey(rel);
    // Same capped read and completed-folder stamp check as an added dest (#4906).
    if (key === null || !activePairKeys.has(key) || removedSrc.has(rel)) {
      continue;
    }
    const payload = readPayload(root, rel, options.payloads);
    if (payload.kind === "missing") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: modified under completed/ but unreadable`),
      });
      continue;
    }
    if (payload.kind === "unsafe") {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(payload.detail),
      });
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: modified under completed/ with unreadable plan`),
      });
      continue;
    }
    if (!transitionWriteFitsFolder(plan, "completed")) {
      findings.push({
        relPath: rel,
        detail: sanitizeDetail(`${rel}: modified under completed/ without a runTransition write`),
      });
      continue;
    }
    if (!hasCompleteLifecycleWrite(plan)) {
      continue;
    }
    rememberDest(rel, plan);
  }

  const sourceIdentity = (src: string): string => {
    const payload = readPayload(root, src, options.payloads);
    if (payload.kind === "ok") {
      const plan = parsePlan(payload.raw);
      return plan === null ? "" : planIdentity(plan);
    }
    if (options.nameStatus !== undefined) {
      return "";
    }
    const specs: string[] = [`HEAD:${src}`];
    const deletedAt = git(["log", "-1", "--diff-filter=D", "--format=%H", "--", src], root);
    const deletedSha = deletedAt.stdout.trim();
    if (deletedAt.status === 0 && deletedSha.length > 0) {
      specs.push(`${deletedSha}^:${src}`);
    }
    specs.push(`HEAD^:${src}`);
    if (pairingBaseRef.length > 0) {
      specs.push(`${pairingBaseRef}:${src}`);
    }
    for (const spec of specs) {
      const shown = git(["show", spec], root);
      if (shown.status !== 0) {
        continue;
      }
      const plan = parsePlan(shown.stdout);
      if (plan === null) {
        continue;
      }
      const identity = planIdentity(plan);
      if (identity.length > 0) {
        return identity;
      }
    }
    return "";
  };

  const seenActive = new Set<string>();
  const twinHalts = new Set<string>();
  const closedParkHalts = new Set<string>();
  const survivingCompletedTwin = (activeSrc: string): boolean => {
    const twin = completedTwinRel(activeSrc);
    if (twin === null || removedSrc.has(twin)) {
      return false;
    }
    const freshDest = records.some(
      (rec) => (rec.status === "A" || rec.status === "R") && rec.dest === twin,
    );
    if (freshDest) {
      return false;
    }
    if (records.some((rec) => rec.status === "M" && rec.src === twin)) {
      return true;
    }
    if (options.nameStatus !== undefined) {
      return false;
    }
    const payload = readPayload(root, twin, options.payloads);
    return payload.kind === "ok";
  };
  for (const rec of records) {
    if (rec.status !== "D" && rec.status !== "R") {
      continue;
    }
    if (!isActiveArtifactRel(rec.src)) {
      continue;
    }
    let paired = false;
    const srcId = sourceIdentity(rec.src);
    if (rec.status === "R") {
      const dest = authorizedDests.find((d) => d.rel === rec.dest);
      paired = dest !== undefined && srcId.length > 0 && dest.identity === srcId;
    } else {
      const srcKey = pairingKey(rec.src);
      if (srcKey !== null && srcId.length > 0) {
        paired = authorizedDests.some((d) => d.key === srcKey && d.identity === srcId);
      }
    }
    if (paired) {
      continue;
    }
    if (seenActive.has(rec.src)) {
      continue;
    }
    seenActive.add(rec.src);
    if (survivingCompletedTwin(rec.src)) {
      twinHalts.add(rec.src);
    }
    const closedPark = srcId.length > 0 && closedParkIdentities.has(srcId);
    if (closedPark) {
      closedParkHalts.add(rec.src);
    }
    const verb = rec.status === "R" ? "renamed away from" : "deleted from";
    findings.push({
      relPath: rec.src,
      detail: sanitizeDetail(
        closedPark
          ? `${rec.src}: ${verb} active/ toward proposed/ but the origin GitHub issue is closed`
          : `${rec.src}: ${verb} active/ with no paired stamped destination`,
      ),
    });
  }

  if (findings.length === 0) {
    return {
      code: 0,
      findings: [],
      message: "verify_completed_write_guard: clean -- no unguarded completed/ adds",
    };
  }

  const destFindings = findings.filter((f) => isCompletedArtifactRel(f.relPath));
  const deleteFindings = findings.filter((f) => isActiveArtifactRel(f.relPath));
  if (deleteFindings.length === 0) {
    return {
      code: 1,
      findings,
      message:
        `verify_completed_write_guard: ${findings.length} unguarded completed/ add(s) (#3679).\n` +
        findings.map((f) => `  - ${f.detail}`).join("\n") +
        `\n${LEFTOVER_LAND_PR_REMEDIATION}`,
    };
  }

  const parts = [
    `verify_completed_write_guard: ${String(findings.length)} finding(s) (#3679 / #3766).`,
    ...findings.map((f) => `  - ${f.detail}`),
  ];
  if (destFindings.length > 0) {
    parts.push(LEFTOVER_LAND_PR_REMEDIATION);
  }
  if (deleteFindings.some((finding) => !twinHalts.has(finding.relPath))) {
    parts.push(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
  }
  if (deleteFindings.some((finding) => twinHalts.has(finding.relPath))) {
    parts.push(ACTIVE_TWIN_RESTAMP_REMEDIATION);
  }
  if (deleteFindings.some((finding) => closedParkHalts.has(finding.relPath))) {
    parts.push(CLOSED_ISSUE_PARK_REMEDIATION);
  }
  return {
    code: 1,
    findings,
    message: parts.join("\n"),
  };
}

export interface CompletedWriteCorpusResult {
  readonly findings: readonly CompletedWriteGuardFinding[];
  readonly scanned: number;
}

function listCompletedArtifactRels(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dirName of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    const completedDir = join(projectRoot, dirName, "completed");
    if (!existsSync(completedDir)) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(completedDir).filter((n) => hasArtifactSuffix(n));
    } catch {
      continue;
    }
    for (const name of names) {
      out.push(`${dirName}/completed/${name}`);
    }
  }
  return out.sort();
}

/**
 * Corpus scan for doctor: artifacts without transition evidence.
 * Caller marks these advisory so historical pre-stamp files do not red doctor.
 */
export function scanCompletedWriteCorpus(projectRoot: string): CompletedWriteCorpusResult {
  const findings: CompletedWriteGuardFinding[] = [];
  const rels = listCompletedArtifactRels(projectRoot);
  for (const rel of rels) {
    const payload = readPayload(resolve(projectRoot), rel, undefined);
    if (payload.kind !== "ok") {
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      continue;
    }
    if (!hasTransitionWrite(plan)) {
      findings.push({
        relPath: rel,
        detail: `${rel}: completed/ artifact has no runTransition write (historical advisory)`,
      });
    }
  }
  return { findings, scanned: rels.length };
}
