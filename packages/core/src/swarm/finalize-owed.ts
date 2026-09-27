/**
 * swarm:finalize-owed (#4919): discover and finish ownerless Tracking stories.
 *
 * Tip-scanned mark (productPullRequest) over TIP_NONTERMINAL + completed;
 * twin checks use pairingKey/planIdentity; claim refs share finalizeClaimRef.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractIssueRef } from "../capacity/backfill.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { TIP_NONTERMINAL_FOLDERS } from "../lifecycle/completed-tracked-on-delivery.js";
import {
  briefPairingKey,
  briefPlanIdentity,
  completedTwinRelPath,
  productPullRequestFromPlan,
} from "../orphan-active/running-briefs.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { defaultGitRunner, type GitRunner, timedGitRunner } from "../session/git.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_INCOMPLETE, EXIT_OK } from "./constants.js";
import { type FinalizeCohortResult, finalizeClaimRef, finalizeCohort } from "./finalize-cohort.js";

export const FINALIZE_OWED_LABEL = "finalize-owed";

/** Age bound before a claim ref with no open PR is stale (#4919). */
export const FINALIZE_CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

export type FinalizeOwedState =
  | "owed"
  | "close-owed"
  | "stale"
  | "in-flight"
  | "unverified"
  | "backlog"
  | "unknown";

export interface FinalizeOwedStory {
  readonly issue: number;
  readonly productPr: number;
  readonly relPath: string;
  readonly state: FinalizeOwedState;
  readonly claimRef: string;
  readonly pairingKey: string | null;
  readonly planIdentity: string;
  readonly detail: string;
  readonly blocks: boolean;
}

export interface FinalizeOwedInventory {
  readonly deliveryBranch: string;
  readonly tip: string | null;
  readonly stories: readonly FinalizeOwedStory[];
  readonly fetchError: string | null;
}

export interface FinalizeOwedArgs {
  readonly projectRoot?: string;
  readonly repo?: string | null;
  readonly deliveryBranch?: string | null;
  readonly dryRun?: boolean;
  readonly emitJson?: boolean;
  /** Discover only; do not claim or finalize. */
  readonly inventoryOnly?: boolean;
  /** Hand off open leftover (default) vs wait-through-land. */
  readonly waitThroughLand?: boolean;
  readonly runGh?: RunGhFn;
  readonly runGit?: GitRunner;
  readonly now?: () => number;
  /** Test seam: skip live finalizeCohort. */
  readonly runFinalize?: (args: {
    issue: number;
    productPr: number;
    claimRef: string;
    projectRoot: string;
  }) => {
    exitCode: number;
    result: FinalizeCohortResult;
    stdout: string;
  };
}

export interface FinalizeOwedResult {
  readonly delivery_branch: string;
  readonly tip: string | null;
  readonly stories: readonly FinalizeOwedStory[];
  readonly finalized: readonly number[];
  readonly skipped: readonly number[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly fetch_error: string | null;
  readonly ok: boolean;
}

const NONTERMINAL_PREFIXES: string[] = (() => {
  const out: string[] = [];
  for (const root of ["xbrief", "vbrief"]) {
    for (const folder of TIP_NONTERMINAL_FOLDERS) {
      out.push(`${root}/${folder}`);
    }
  }
  return out;
})();

const COMPLETED_PREFIXES = ["xbrief/completed", "vbrief/completed"] as const;

function parseRepo(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash >= repo.length - 1) {
    return null;
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

function listTipPaths(
  projectRoot: string,
  tip: string,
  prefixes: readonly string[],
  runGit: GitRunner,
): string[] {
  if (prefixes.length === 0) {
    return [];
  }
  const result = runGit(projectRoot, ["ls-tree", "-r", "--name-only", tip, "--", ...prefixes]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && hasArtifactSuffix(line));
}

function readTipPlan(
  projectRoot: string,
  tip: string,
  relPath: string,
  runGit: GitRunner,
): Record<string, unknown> | null {
  const shown = runGit(projectRoot, ["show", `${tip}:${relPath}`]);
  if (shown.code !== 0) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(shown.stdout);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const plan = (raw as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return null;
    }
    return plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

function issueFromPlan(plan: Record<string, unknown>, expectedRepo: string | null): number | null {
  const [repo, number] = extractIssueRef(plan);
  if (number === null || !Number.isInteger(number) || number <= 0) {
    return null;
  }
  if (expectedRepo !== null && repo !== null && repo.toLowerCase() !== expectedRepo.toLowerCase()) {
    return null;
  }
  if (expectedRepo !== null && repo === null) {
    return null;
  }
  return number;
}

function tipHasTwin(
  projectRoot: string,
  tip: string,
  relPath: string,
  plan: Record<string, unknown>,
  completedPaths: ReadonlySet<string>,
  runGit: GitRunner,
): boolean {
  const twinRel = completedTwinRelPath(relPath);
  const key = briefPairingKey(relPath);
  const identity = briefPlanIdentity(plan);
  if (twinRel !== null && completedPaths.has(twinRel)) {
    const twinPlan = readTipPlan(projectRoot, tip, twinRel, runGit);
    if (twinPlan !== null) {
      const twinKey = briefPairingKey(twinRel);
      if (key !== null && twinKey === key && briefPlanIdentity(twinPlan) === identity) {
        return true;
      }
    }
  }
  // Multi-brief-N: only pairingKey+planIdentity match counts as twin.
  for (const completed of completedPaths) {
    const cKey = briefPairingKey(completed);
    if (key === null || cKey !== key) {
      continue;
    }
    const twinPlan = readTipPlan(projectRoot, tip, completed, runGit);
    if (twinPlan !== null && briefPlanIdentity(twinPlan) === identity) {
      return true;
    }
  }
  return false;
}

function fetchIssueState(
  issue: number,
  repo: string,
  runGh: RunGhFn,
): { state: "open" | "closed" | null; protectedUmbrella: boolean; error: string | null } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { state: null, protectedUmbrella: false, error: `invalid repo: ${repo}` };
  }
  const result = runGh([
    "gh",
    "api",
    `repos/${parsed.owner}/${parsed.name}/issues/${String(issue)}`,
  ]);
  if (result.returncode !== 0) {
    return {
      state: null,
      protectedUmbrella: false,
      error: result.stderr.trim() || result.stdout.trim(),
    };
  }
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { state: null, protectedUmbrella: false, error: "issue payload malformed" };
    }
    const rec = payload as Record<string, unknown>;
    const stateRaw = String(rec.state ?? "").toLowerCase();
    const state = stateRaw === "open" || stateRaw === "closed" ? stateRaw : null;
    let protectedUmbrella = false;
    const labels = rec.labels;
    if (Array.isArray(labels)) {
      for (const label of labels) {
        const name =
          typeof label === "string"
            ? label
            : typeof label === "object" && label !== null
              ? String((label as Record<string, unknown>).name ?? "")
              : "";
        const lower = name.toLowerCase();
        if (lower.includes("umbrella") || lower === "status:protected" || lower === "protected") {
          protectedUmbrella = true;
        }
      }
    }
    return { state, protectedUmbrella, error: null };
  } catch (err: unknown) {
    return {
      state: null,
      protectedUmbrella: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function listOpenFinalizePrs(
  repo: string,
  runGh: RunGhFn,
): { headRefs: Set<string>; error: string | null } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { headRefs: new Set(), error: `invalid repo: ${repo}` };
  }
  const path = `repos/${parsed.owner}/${parsed.name}/pulls?state=open&per_page=100&head=${parsed.owner}:swarm/finalize`;
  // GitHub head filter needs owner:branch; list and filter client-side for prefix.
  const listed = runGh([
    "gh",
    "api",
    `repos/${parsed.owner}/${parsed.name}/pulls?state=open&per_page=100`,
  ]);
  if (listed.returncode !== 0) {
    return {
      headRefs: new Set(),
      error: listed.stderr.trim() || listed.stdout.trim(),
    };
  }
  const headRefs = new Set<string>();
  try {
    const payload: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(payload)) {
      return { headRefs, error: "pulls payload not an array" };
    }
    for (const item of payload) {
      if (typeof item !== "object" || item === null) continue;
      const head = (item as Record<string, unknown>).head;
      if (typeof head !== "object" || head === null) continue;
      const ref = String((head as Record<string, unknown>).ref ?? "");
      if (ref.startsWith("swarm/finalize/")) {
        headRefs.add(ref);
      }
    }
  } catch (err: unknown) {
    return {
      headRefs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  void path;
  return { headRefs, error: null };
}

/** Transient network/auth failures must not mark a live claim stale (#4919). */
export function isTransientClaimFetchFailure(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return /could not resolve host|name or service not known|temporary failure in name resolution|connection (reset|refused|timed out)|operation timed out|timed out|unable to access|authentication failed|could not read username|http\s*(401|403|429|500|502|503)|ssl|tls|network is unreachable|could not read from remote|the remote end hung up|early eof|rpc failed|gnutls|curl\s*\d+|failed to connect/.test(
    text,
  );
}

/**
 * Only missing-object / gone-ref fetch failures authorize reclaim after ls-remote
 * found the claim. Unknown failures stay live (#4919).
 */
export function isReclaimableClaimFetchFailure(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return /missing objects?|bad object|not our ref|couldn't find remote ref|could not find remote ref|remote ref .+ not found|does not allow request for unadvertised object|remote did not send all necessary objects|upload-pack: not our ref/.test(
    text,
  );
}

function remoteClaimMeta(
  projectRoot: string,
  claimRef: string,
  runGit: GitRunner,
  nowMs: number,
): { exists: boolean; stale: boolean; ageMs: number | null } {
  const ls = runGit(projectRoot, ["ls-remote", "--heads", "origin", claimRef]);
  if (ls.code !== 0 || ls.stdout.trim().length === 0) {
    return { exists: false, stale: false, ageMs: null };
  }
  const sha = ls.stdout.trim().split(/\s+/)[0] ?? "";
  if (sha.length === 0) {
    return { exists: false, stale: false, ageMs: null };
  }
  // Privately fetch the claim tip; ls-remote alone leaves objects missing locally.
  const privateRef = `refs/deft/finalize-owed-claim/${claimRef.replace(/\//g, "-")}`;
  const fetch = runGit(projectRoot, [
    "fetch",
    "origin",
    `refs/heads/${claimRef}:${privateRef}`,
    "--force",
  ]);
  if (fetch.code !== 0) {
    if (isReclaimableClaimFetchFailure(fetch.stderr, fetch.stdout)) {
      // Missing object / remote ref gone after ls-remote → reclaimable.
      return { exists: true, stale: true, ageMs: null };
    }
    // Transient network/auth or unknown fetch failure: keep live (#4919).
    return { exists: true, stale: false, ageMs: null };
  }
  // Claim marker commit uses committer time (not delivery-tip author age).
  const committer = runGit(projectRoot, ["log", "-1", "--format=%ct", privateRef]);
  if (committer.code !== 0) {
    return { exists: true, stale: true, ageMs: null };
  }
  const ts = Number.parseInt(committer.stdout.trim(), 10);
  if (!Number.isFinite(ts)) {
    return { exists: true, stale: true, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - ts * 1000);
  return { exists: true, stale: ageMs >= FINALIZE_CLAIM_STALE_MS, ageMs };
}

function snapshotAccepts(
  productPr: number,
  repo: string,
  deliveryBranch: string,
  projectRoot: string,
  tipSha: string,
  runGh: RunGhFn,
  runGit: GitRunner,
): { ok: boolean; detail: string } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { ok: false, detail: "invalid repo" };
  }
  const result = runGh([
    "gh",
    "api",
    `repos/${parsed.owner}/${parsed.name}/pulls/${String(productPr)}`,
  ]);
  if (result.returncode !== 0) {
    return { ok: false, detail: "product PR fetch failed" };
  }
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (payload === null || typeof payload !== "object") {
      return { ok: false, detail: "product PR payload malformed" };
    }
    const rec = payload as Record<string, unknown>;
    const mergedAt = rec.merged_at;
    if (typeof mergedAt !== "string" || mergedAt.length === 0) {
      return { ok: false, detail: "product PR not merged" };
    }
    const base = rec.base;
    const baseRef =
      typeof base === "object" && base !== null
        ? String((base as Record<string, unknown>).ref ?? "")
        : "";
    if (baseRef !== deliveryBranch) {
      return { ok: false, detail: `product PR base ${baseRef} != ${deliveryBranch}` };
    }
    const mergeSha = typeof rec.merge_commit_sha === "string" ? rec.merge_commit_sha : "";
    if (mergeSha.length === 0) {
      return { ok: false, detail: "product PR missing merge_commit_sha" };
    }
    // Ancestry against the privately fetched tip, not a stale origin/<branch> (#4919).
    const ancestor = runGit(projectRoot, ["merge-base", "--is-ancestor", mergeSha, tipSha]);
    if (ancestor.code !== 0) {
      return { ok: false, detail: "merge commit not ancestor of delivery tip" };
    }
    return { ok: true, detail: "snapshot accepted" };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bounded private fetch of delivery tip without allowOptionalNetwork (#4919).
 * Writes to refs/deft/finalize-owed/<branch> so shared origin/<branch> is untouched.
 */
export function fetchDeliveryTipPrivate(
  projectRoot: string,
  deliveryBranch: string,
  runGit: GitRunner,
  timeoutMs = 30_000,
): { tip: string | null; error: string | null } {
  const privateRef = `refs/deft/finalize-owed/${deliveryBranch}`;
  // Prefer injected runner (tests); otherwise bound the live fetch.
  const fetcher = runGit === defaultGitRunner ? timedGitRunner(timeoutMs) : runGit;
  const fetch = fetcher(projectRoot, [
    "fetch",
    "origin",
    `refs/heads/${deliveryBranch}:${privateRef}`,
    "--force",
  ]);
  if (fetch.code !== 0) {
    return {
      tip: null,
      error: fetch.stderr.trim() || fetch.stdout.trim() || "git fetch failed",
    };
  }
  const rev = runGit(projectRoot, ["rev-parse", privateRef]);
  if (rev.code !== 0 || rev.stdout.trim().length === 0) {
    return { tip: null, error: `rev-parse ${privateRef} failed` };
  }
  return { tip: rev.stdout.trim(), error: null };
}

export function discoverFinalizeOwed(
  projectRoot: string,
  options: {
    readonly repo: string;
    readonly deliveryBranch: string;
    readonly tip: string;
    readonly runGh?: RunGhFn;
    readonly runGit?: GitRunner;
    readonly now?: () => number;
  },
): FinalizeOwedInventory {
  const runGh = options.runGh ?? defaultRunGh;
  const runGit = options.runGit ?? defaultGitRunner;
  const nowMs = (options.now ?? Date.now)();
  const openPrs = listOpenFinalizePrs(options.repo, runGh);
  const nonterminal = listTipPaths(projectRoot, options.tip, NONTERMINAL_PREFIXES, runGit);
  const completed = listTipPaths(projectRoot, options.tip, COMPLETED_PREFIXES, runGit);
  const completedSet = new Set(completed);
  const stories: FinalizeOwedStory[] = [];

  for (const relPath of nonterminal) {
    const plan = readTipPlan(projectRoot, options.tip, relPath, runGit);
    if (plan === null) {
      continue;
    }
    const productPr = productPullRequestFromPlan(plan);
    const issue = issueFromPlan(plan, options.repo);
    if (productPr === null) {
      // Unmarked non-delivered → backlog (ignored).
      continue;
    }
    if (issue === null) {
      stories.push({
        issue: 0,
        productPr,
        relPath,
        state: "unverified",
        claimRef: finalizeClaimRef(null, [productPr], []),
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: "mark present but issue ref missing or foreign repo",
        blocks: false,
      });
      continue;
    }
    const claimRef = finalizeClaimRef(null, [productPr], [String(issue)]);
    const snap = snapshotAccepts(
      productPr,
      options.repo,
      options.deliveryBranch,
      projectRoot,
      options.tip,
      runGh,
      runGit,
    );
    if (!snap.ok) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "unverified",
        claimRef,
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: snap.detail,
        blocks: false,
      });
      continue;
    }
    if (tipHasTwin(projectRoot, options.tip, relPath, plan, completedSet, runGit)) {
      // Active+completed twin anomaly: list, do not touch (#4863).
      stories.push({
        issue,
        productPr,
        relPath,
        state: "unverified",
        claimRef,
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: "completed twin present beside nonterminal brief",
        blocks: false,
      });
      continue;
    }
    if (openPrs.headRefs.has(claimRef) || [...openPrs.headRefs].some((r) => r === claimRef)) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "in-flight",
        claimRef,
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: "open finalize leftover PR",
        blocks: false,
      });
      continue;
    }
    const claim = remoteClaimMeta(projectRoot, claimRef, runGit, nowMs);
    if (claim.exists && !claim.stale) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "in-flight",
        claimRef,
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: "live claim ref (age within bound)",
        blocks: false,
      });
      continue;
    }
    const issueState = fetchIssueState(issue, options.repo, runGh);
    if (issueState.error !== null || issueState.state === null) {
      // Already-stale claims keep blocking even when origin issue fetch fails (#4919).
      if (claim.exists && claim.stale) {
        stories.push({
          issue,
          productPr,
          relPath,
          state: "stale",
          claimRef,
          pairingKey: briefPairingKey(relPath),
          planIdentity: briefPlanIdentity(plan),
          detail: `stale claim ageMs=${String(claim.ageMs)}; issue verify failed: ${issueState.error ?? "issue state unknown"}`,
          blocks: true,
        });
      } else {
        stories.push({
          issue,
          productPr,
          relPath,
          state: "unverified",
          claimRef,
          pairingKey: briefPairingKey(relPath),
          planIdentity: briefPlanIdentity(plan),
          detail: issueState.error ?? "issue state unknown",
          blocks: false,
        });
      }
      continue;
    }
    // Closed origin: do not reclaim/delete a finalize branch for finished work (#4919).
    if (issueState.state === "closed" || issueState.protectedUmbrella) {
      continue;
    }
    if (claim.exists && claim.stale) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "stale",
        claimRef,
        pairingKey: briefPairingKey(relPath),
        planIdentity: briefPlanIdentity(plan),
        detail: `stale claim ageMs=${String(claim.ageMs)}`,
        blocks: true,
      });
      continue;
    }
    stories.push({
      issue,
      productPr,
      relPath,
      state: "owed",
      claimRef,
      pairingKey: briefPairingKey(relPath),
      planIdentity: briefPlanIdentity(plan),
      detail: "marked nonterminal; snapshot accepted; no twin",
      blocks: true,
    });
  }

  for (const relPath of completed) {
    const plan = readTipPlan(projectRoot, options.tip, relPath, runGit);
    if (plan === null) {
      continue;
    }
    const productPr = productPullRequestFromPlan(plan);
    if (productPr === null) {
      continue;
    }
    const issue = issueFromPlan(plan, options.repo);
    if (issue === null) {
      continue;
    }
    // Skip if a nonterminal twin already classified this identity.
    const identity = briefPlanIdentity(plan);
    const key = briefPairingKey(relPath);
    const already = stories.some(
      (s) =>
        s.issue === issue &&
        s.pairingKey === key &&
        s.planIdentity === identity &&
        (s.state === "owed" || s.state === "in-flight" || s.state === "stale"),
    );
    if (already) {
      continue;
    }
    const claimRef = finalizeClaimRef(null, [productPr], [String(issue)]);
    if (openPrs.headRefs.has(claimRef)) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "in-flight",
        claimRef,
        pairingKey: key,
        planIdentity: identity,
        detail: "open finalize leftover PR (close-owed window)",
        blocks: false,
      });
      continue;
    }
    const claim = remoteClaimMeta(projectRoot, claimRef, runGit, nowMs);
    if (claim.exists && !claim.stale) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "in-flight",
        claimRef,
        pairingKey: key,
        planIdentity: identity,
        detail: "live claim ref (close-owed window)",
        blocks: false,
      });
      continue;
    }
    const issueState = fetchIssueState(issue, options.repo, runGh);
    if (issueState.error !== null || issueState.state === null) {
      // Already-stale claims keep blocking even when origin issue fetch fails (#4919).
      if (claim.exists && claim.stale) {
        stories.push({
          issue,
          productPr,
          relPath,
          state: "stale",
          claimRef,
          pairingKey: key,
          planIdentity: identity,
          detail: `stale claim ageMs=${String(claim.ageMs)} (close-owed window); issue verify failed: ${issueState.error ?? "issue state unknown"}`,
          blocks: true,
        });
      } else {
        stories.push({
          issue,
          productPr,
          relPath,
          state: "unverified",
          claimRef,
          pairingKey: key,
          planIdentity: identity,
          detail: issueState.error ?? "issue state unknown",
          blocks: false,
        });
      }
      continue;
    }
    // Closed (or protected) origin: do not reclaim/delete the finalize branch (#4919).
    if (issueState.state === "closed" || issueState.protectedUmbrella) {
      continue;
    }
    if (claim.exists && claim.stale) {
      stories.push({
        issue,
        productPr,
        relPath,
        state: "stale",
        claimRef,
        pairingKey: key,
        planIdentity: identity,
        detail: `stale claim ageMs=${String(claim.ageMs)} (close-owed window)`,
        blocks: true,
      });
      continue;
    }
    stories.push({
      issue,
      productPr,
      relPath,
      state: "close-owed",
      claimRef,
      pairingKey: key,
      planIdentity: identity,
      detail: "completed on tip; issue still open",
      blocks: true,
    });
  }

  stories.sort((a, b) => a.issue - b.issue || a.relPath.localeCompare(b.relPath));
  return {
    deliveryBranch: options.deliveryBranch,
    tip: options.tip,
    stories,
    fetchError: openPrs.error,
  };
}

function tryClaimRef(
  projectRoot: string,
  claimRef: string,
  tipSha: string,
  runGit: GitRunner,
): { claimed: boolean; detail: string } {
  // Marker commit so claim age uses claim creation time, not delivery-tip age (#4919).
  const tree = runGit(projectRoot, ["rev-parse", `${tipSha}^{tree}`]);
  if (tree.code !== 0 || tree.stdout.trim().length === 0) {
    return {
      claimed: false,
      detail: tree.stderr.trim() || tree.stdout.trim() || "claim tree resolve failed",
    };
  }
  const marker = runGit(projectRoot, [
    "-c",
    "user.name=deft-finalize-owed",
    "-c",
    "user.email=finalize-owed@localhost",
    "commit-tree",
    tree.stdout.trim(),
    "-p",
    tipSha,
    "-m",
    `deft finalize-owed claim ${claimRef}`,
  ]);
  if (marker.code !== 0 || marker.stdout.trim().length === 0) {
    return {
      claimed: false,
      detail: marker.stderr.trim() || marker.stdout.trim() || "claim marker commit failed",
    };
  }
  const claimSha = marker.stdout.trim();
  // Create-only: empty expected OID means remote ref must be absent (#4919).
  const push = runGit(projectRoot, [
    "push",
    `--force-with-lease=refs/heads/${claimRef}:`,
    "origin",
    `${claimSha}:refs/heads/${claimRef}`,
  ]);
  if (push.code !== 0) {
    return {
      claimed: false,
      detail: push.stderr.trim() || push.stdout.trim() || "claim push rejected",
    };
  }
  return { claimed: true, detail: "claimed" };
}

function deleteStaleClaim(
  projectRoot: string,
  claimRef: string,
  runGit: GitRunner,
): { ok: boolean; detail: string } {
  const del = runGit(projectRoot, ["push", "origin", "--delete", claimRef]);
  if (del.code !== 0) {
    return { ok: false, detail: del.stderr.trim() || del.stdout.trim() || "delete failed" };
  }
  return { ok: true, detail: "stale claim deleted" };
}

export function finalizeOwed(args: FinalizeOwedArgs = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: FinalizeOwedResult;
} {
  const projectRoot = resolve(args.projectRoot ?? process.cwd());
  const runGh = args.runGh ?? defaultRunGh;
  const runGit = args.runGit ?? defaultGitRunner;
  const dryRun = args.dryRun ?? false;
  const emitJson = args.emitJson ?? false;
  const inventoryOnly = args.inventoryOnly ?? false;
  const waitThroughLand = args.waitThroughLand ?? false;
  const errors: string[] = [];
  const warnings: string[] = [];
  const finalized: number[] = [];
  const skipped: number[] = [];

  if (!existsSync(projectRoot)) {
    return respondFinalizeOwed({
      delivery_branch: "",
      tip: null,
      stories: [],
      finalized: [],
      skipped: [],
      errors: [`project root does not exist: ${projectRoot}`],
      warnings: [],
      fetch_error: null,
      ok: false,
      emitJson,
      exitCode: EXIT_CONFIG_ERROR,
    });
  }

  const policyDelivery = resolveDeliveryBranch(projectRoot, runGit);
  const deliveryBranch =
    args.deliveryBranch !== null &&
    args.deliveryBranch !== undefined &&
    args.deliveryBranch.trim().length > 0
      ? args.deliveryBranch.trim()
      : policyDelivery.branch;

  const repo = args.repo ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? null;
  if (repo === null || repo.trim().length === 0) {
    return respondFinalizeOwed({
      delivery_branch: deliveryBranch,
      tip: null,
      stories: [],
      finalized: [],
      skipped: [],
      errors: ["--repo OWNER/REPO required (or GH_REPO / GITHUB_REPOSITORY)"],
      warnings: [],
      fetch_error: null,
      ok: false,
      emitJson,
      exitCode: EXIT_CONFIG_ERROR,
    });
  }

  const fetched = fetchDeliveryTipPrivate(projectRoot, deliveryBranch, runGit);
  if (fetched.tip === null) {
    return respondFinalizeOwed({
      delivery_branch: deliveryBranch,
      tip: null,
      stories: [],
      finalized: [],
      skipped: [],
      errors: [],
      warnings: [],
      fetch_error: fetched.error,
      ok: false,
      emitJson,
      exitCode: EXIT_CONFIG_ERROR,
      extraLines: ["finalize owed: unknown"],
    });
  }

  const inventory = discoverFinalizeOwed(projectRoot, {
    repo: repo.trim(),
    deliveryBranch,
    tip: fetched.tip,
    runGh,
    runGit,
    now: args.now,
  });
  if (inventory.fetchError !== null) {
    warnings.push(`open-PR probe: ${inventory.fetchError}`);
  }

  if (inventoryOnly || dryRun) {
    const blocking = inventory.stories.filter((s) => s.blocks);
    return respondFinalizeOwed({
      delivery_branch: deliveryBranch,
      tip: fetched.tip,
      stories: inventory.stories,
      finalized: [],
      skipped: inventory.stories.map((s) => s.issue),
      errors,
      warnings,
      fetch_error: null,
      ok: errors.length === 0,
      emitJson,
      exitCode: errors.length === 0 ? EXIT_OK : EXIT_GATE_FAILED,
      dryRun,
      note: dryRun
        ? `DRY-RUN: ${String(blocking.length)} blocking / ${String(inventory.stories.length)} listed`
        : undefined,
    });
  }

  for (const story of inventory.stories) {
    if (story.state === "in-flight" || story.state === "unverified" || story.state === "backlog") {
      skipped.push(story.issue);
      continue;
    }
    if (story.state === "stale") {
      const deleted = deleteStaleClaim(projectRoot, story.claimRef, runGit);
      if (!deleted.ok) {
        warnings.push(`#${String(story.issue)}: stale reclaim failed: ${deleted.detail}`);
        skipped.push(story.issue);
        continue;
      }
    }
    if (story.state !== "owed" && story.state !== "close-owed" && story.state !== "stale") {
      skipped.push(story.issue);
      continue;
    }

    const claim = tryClaimRef(projectRoot, story.claimRef, fetched.tip, runGit);
    if (!claim.claimed) {
      // Close-owed also requires the create-only claim; another live owner must win (#4919).
      warnings.push(`#${String(story.issue)}: in flight (${claim.detail})`);
      skipped.push(story.issue);
      continue;
    }

    const runFinalize =
      args.runFinalize ??
      ((input) => {
        const result = finalizeCohort({
          projectRoot: input.projectRoot,
          prNumbers: [input.productPr],
          storyTokens: [String(input.issue)],
          repo: repo.trim(),
          deliveryBranch,
          label: null,
          noOpenPr: false,
          // Default: open leftover, enable auto-merge, hand off as pending.
          // --wait-through-land owns the land wait instead (#4919).
          handOffLeftover: !waitThroughLand,
          sleep: waitThroughLand ? undefined : () => {},
          runGh,
          runGit: (cmd, options) => {
            const cwd = options?.cwd ?? input.projectRoot;
            const argsOnly = cmd[0] === "git" ? cmd.slice(1) : cmd;
            const r = runGit(cwd, argsOnly);
            return { returncode: r.code, stdout: r.stdout, stderr: r.stderr };
          },
          emitJson: false,
        });
        return { exitCode: result.exitCode, result: result.result, stdout: result.stdout };
      });

    // Fresh checkout isolation: finalize-cohort prepareLifecycleCheckout owns this.
    const outcome = runFinalize({
      issue: story.issue,
      productPr: story.productPr,
      claimRef: story.claimRef,
      projectRoot,
    });
    if (
      outcome.exitCode === EXIT_OK ||
      outcome.exitCode === EXIT_INCOMPLETE ||
      outcome.result.pending !== null
    ) {
      finalized.push(story.issue);
      if (outcome.exitCode === EXIT_INCOMPLETE || outcome.result.pending !== null) {
        warnings.push(
          `#${String(story.issue)}: finalize incomplete (origin-close pending); leftover handed off`,
        );
      }
    } else {
      errors.push(
        `#${String(story.issue)}: finalize failed (exit ${String(outcome.exitCode)}): ${
          outcome.result.errors[0] ?? outcome.stdout.trim().split("\n").pop() ?? "unknown"
        }`,
      );
      skipped.push(story.issue);
    }
  }

  const incomplete = warnings.some((w) => w.includes("origin-close pending"));
  const failed = errors.length > 0;
  return respondFinalizeOwed({
    delivery_branch: deliveryBranch,
    tip: fetched.tip,
    stories: inventory.stories,
    finalized,
    skipped,
    errors,
    warnings,
    fetch_error: null,
    ok: !failed,
    emitJson,
    exitCode: failed ? EXIT_GATE_FAILED : incomplete ? EXIT_INCOMPLETE : EXIT_OK,
  });
}

function respondFinalizeOwed(input: {
  delivery_branch: string;
  tip: string | null;
  stories: readonly FinalizeOwedStory[];
  finalized: readonly number[];
  skipped: readonly number[];
  errors: readonly string[];
  warnings: readonly string[];
  fetch_error: string | null;
  ok: boolean;
  emitJson: boolean;
  exitCode: number;
  dryRun?: boolean;
  note?: string;
  extraLines?: readonly string[];
}): {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: FinalizeOwedResult;
} {
  const result: FinalizeOwedResult = {
    delivery_branch: input.delivery_branch,
    tip: input.tip,
    stories: input.stories,
    finalized: input.finalized,
    skipped: input.skipped,
    errors: input.errors,
    warnings: input.warnings,
    fetch_error: input.fetch_error,
    ok: input.ok,
  };
  if (input.emitJson) {
    return {
      exitCode: input.exitCode,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      result,
    };
  }
  const lines: string[] = [
    `Swarm finalize-owed ${input.dryRun === true ? "DRY-RUN" : "live"}`,
    `  Delivery branch: ${input.delivery_branch}`,
  ];
  if (input.tip !== null) {
    lines.push(`  Tip: ${input.tip}`);
  }
  if (input.fetch_error !== null) {
    lines.push(`  Fetch error: ${input.fetch_error}`);
  }
  for (const extra of input.extraLines ?? []) {
    lines.push(extra);
  }
  if (input.stories.length > 0) {
    lines.push("  Inventory:");
    for (const story of input.stories) {
      lines.push(
        `    #${String(story.issue)} pr=#${String(story.productPr)} state=${story.state}` +
          `${story.blocks ? " [blocks]" : ""} -- ${story.detail}`,
      );
    }
  } else if (input.fetch_error === null) {
    lines.push("  Inventory: (empty)");
  }
  if (input.finalized.length > 0) {
    lines.push(`  Finalized: ${input.finalized.map((n) => `#${String(n)}`).join(", ")}`);
  }
  if (input.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const w of input.warnings) {
      lines.push(`    - ${w}`);
    }
  }
  if (input.errors.length > 0) {
    lines.push("  Errors:");
    for (const e of input.errors) {
      lines.push(`    - ${e}`);
    }
  }
  if (input.note !== undefined) {
    lines.push(`  ${input.note}`);
  }
  lines.push("");
  lines.push(
    input.ok
      ? input.exitCode === EXIT_INCOMPLETE
        ? "Result: FINALIZE-OWED INCOMPLETE -- origin-close pending on one or more stories."
        : "Result: FINALIZE-OWED CLEAN."
      : "Result: FINALIZE-OWED FAILED.",
  );
  return {
    exitCode: input.exitCode,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    result,
  };
}

/** Format inventory lines for session-start (#4919 Recut item 7). */
export function formatFinalizeOwedInventoryLines(inventory: FinalizeOwedInventory): string[] {
  if (inventory.fetchError !== null && inventory.tip === null) {
    return ["finalize owed: unknown"];
  }
  const nonBacklog = inventory.stories.filter((s) => s.state !== "backlog");
  if (nonBacklog.length === 0) {
    return [];
  }
  const lines = ["finalize owed inventory:"];
  for (const story of nonBacklog) {
    lines.push(
      `  #${String(story.issue)} ${story.state}${story.blocks ? " [blocks]" : ""}` +
        ` pr=#${String(story.productPr)} ${story.relPath}`,
    );
  }
  return lines;
}

export function inventoryHasBlockingOwed(inventory: FinalizeOwedInventory): boolean {
  return inventory.stories.some((s) => s.blocks);
}
