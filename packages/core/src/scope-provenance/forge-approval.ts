/**
 * Forge-approved head-brief membership admit (#6203).
 *
 * Membership (#4774 / #5192) trusts a brief's file_scope only from the merge
 * base, so a PR that carries a new or widened brief plus its code is refused.
 * This module supplies the only other accepted proof: a currently effective
 * GitHub APPROVED review, by a non-author User with repo write, whose reviewed
 * commit holds a brief with the same auth-hash v1 as the evaluated PR head.
 *
 * Auth-hash v1 covers plan.id, the xbrief path, the concrete file_scope, and
 * the acceptanceCriteria array. Delivery metadata (plan.metadata.productPullRequest
 * and the rest of plan.metadata) stays out, so a PPR stamp does not drop the
 * approval.
 *
 * Every failure (no PR context, forge unavailable, Bot/App reviewer, withdrawn
 * review, hash mismatch, head mismatch) returns a reject verdict. The caller
 * keeps today's Path B or mint remediation. This module never throws.
 *
 * Residual: an agent that holds a second human forge token can satisfy these
 * predicates. That confused-deputy posture stays on #6207; the hash does not
 * close it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseGitHubRepoSlug } from "../text/redos-safe.js";
import { isConcreteFileScopeEntry } from "./base-fence.js";
import { extractFileScope, extractPlanId, normalizeFileScope } from "./digest.js";

export const FORGE_AUTH_HASH_SCHEMA = "deft.scope.forge-auth-hash.v1" as const;

/** Review page cap: 10 pages x 100 reviews. Past the cap the proof is unavailable. */
const REVIEW_PAGE_SIZE = Number("100");
const REVIEW_PAGE_CAP = Number("10");

/** SHA-1 (40 hex) or SHA-256 (64 hex) object ids. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export interface ForgeAuthHashPreimage {
  readonly schema: typeof FORGE_AUTH_HASH_SCHEMA;
  readonly planId: string;
  readonly xbriefPath: string;
  readonly fileScope: readonly string[];
  readonly acceptanceCriteria: readonly unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRel(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectItemAcceptance(items: unknown, out: unknown[]): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const narrative = asRecord(rec.narrative);
    if (narrative !== null && narrative.Acceptance !== undefined) {
      out.push({
        source: "plan.items[].narrative.Acceptance",
        id: typeof rec.id === "string" ? rec.id : null,
        value: narrative.Acceptance,
      });
    }
    collectItemAcceptance(rec.subItems, out);
    collectItemAcceptance(rec.items, out);
  }
}

/**
 * The acceptanceCriteria array of auth-hash v1, in document order:
 * plan.acceptance, plan.narratives.AcceptanceCriteria, then each item's
 * narrative.Acceptance (nested subItems / items depth-first).
 */
export function collectAcceptanceCriteria(payload: unknown): unknown[] {
  const plan = asRecord(asRecord(payload)?.plan);
  if (plan === null) return [];
  const out: unknown[] = [];
  if (plan.acceptance !== undefined) {
    out.push({ source: "plan.acceptance", value: plan.acceptance });
  }
  const narratives = asRecord(plan.narratives);
  if (narratives !== null && narratives.AcceptanceCriteria !== undefined) {
    out.push({
      source: "plan.narratives.AcceptanceCriteria",
      value: narratives.AcceptanceCriteria,
    });
  }
  collectItemAcceptance(plan.items, out);
  return out;
}

/** Auth-hash v1 preimage, or null when the brief has no plan.id. */
export function buildAuthHashV1Preimage(
  payload: unknown,
  xbriefRelPath: string,
): ForgeAuthHashPreimage | null {
  const planId = extractPlanId(payload);
  if (planId === null) return null;
  return {
    schema: FORGE_AUTH_HASH_SCHEMA,
    planId,
    xbriefPath: normalizeRel(xbriefRelPath),
    fileScope: normalizeFileScope(extractFileScope(payload)).filter((e) =>
      isConcreteFileScopeEntry(e),
    ),
    acceptanceCriteria: collectAcceptanceCriteria(payload),
  };
}

/**
 * Canonical form for the hash: object keys sorted by UTF-16 code unit, arrays
 * in order, strings byte-exact. No Unicode normalization: membership compares
 * paths exactly, so two spellings of one visible name are two files and must
 * hash apart.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[key] = canonicalize(rec[key]);
    }
    return out;
  }
  return value;
}

/** `sha256:<hex>` over canonical JSON of the v1 preimage; null without plan.id. */
export function computeAuthHashV1(payload: unknown, xbriefRelPath: string): string | null {
  const preimage = buildAuthHashV1Preimage(payload, xbriefRelPath);
  if (preimage === null) return null;
  const canonical = JSON.stringify(canonicalize(preimage));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Forge seams
// ---------------------------------------------------------------------------

export type ForgeReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/** REST reader. `path` is a `gh api` path such as `repos/o/r/pulls/1`. */
export interface ForgeApprovalReader {
  readonly getJson: (path: string) => ForgeReadResult<unknown>;
  /** Raw file bytes (contents API with the raw media type). */
  readonly getRaw: (path: string) => ForgeReadResult<string>;
}

export interface ForgeApprovalGit {
  /** `git rev-parse HEAD`, or null. */
  readonly headSha: () => string | null;
  /** Parents of HEAD (empty when unreadable). */
  readonly headParents: () => readonly string[];
  /** OWNER/NAME of the checkout's `origin` remote, or null. */
  readonly originRepo: () => string | null;
}

export interface ForgeApprovalContext {
  readonly prNumber: number;
  /**
   * OWNER/NAME the caller expects. It must equal the checkout's `origin`
   * repo; it never replaces it (a fork approval cannot authorize here).
   */
  readonly repo?: string | null;
  readonly reader?: ForgeApprovalReader;
  readonly git?: ForgeApprovalGit;
}

export type ForgeApprovalVerdict =
  | {
      readonly kind: "admit";
      readonly approver: string;
      readonly commitId: string;
      readonly authHash: string;
    }
  | { readonly kind: "reject"; readonly reason: string };

function runGh(args: readonly string[]): ForgeReadResult<string> {
  const r = spawnSync("gh", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { ok: false, detail: `gh unavailable: ${String(r.error.message)}` };
  }
  if (r.status !== 0) {
    const err = String(r.stderr ?? "").trim();
    return { ok: false, detail: `gh api exit ${String(r.status)}${err ? `: ${err}` : ""}` };
  }
  return { ok: true, value: String(r.stdout ?? "") };
}

export const defaultForgeApprovalReader: ForgeApprovalReader = {
  getJson: (path) => {
    const r = runGh(["api", path]);
    if (!r.ok) return r;
    try {
      return { ok: true, value: JSON.parse(r.value) as unknown };
    } catch {
      return { ok: false, detail: `gh api ${path}: unreadable JSON` };
    }
  },
  getRaw: (path) => runGh(["api", "-H", "Accept: application/vnd.github.raw", path]),
};

export function defaultForgeApprovalGit(projectRoot: string): ForgeApprovalGit {
  const run = (args: string[]): string | null => {
    const r = spawnSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error !== undefined || r.status !== 0) return null;
    return String(r.stdout ?? "").trim();
  };
  return {
    headSha: () => {
      const out = run(["rev-parse", "HEAD"]);
      return out !== null && SHA_RE.test(out) ? out : null;
    },
    headParents: () => {
      const out = run(["rev-list", "--parents", "-n", "1", "HEAD"]);
      if (out === null) return [];
      return out
        .split(/\s+/)
        .slice(1)
        .filter((s) => SHA_RE.test(s));
    },
    originRepo: () => {
      const out = run(["remote", "get-url", "origin"]);
      return out === null ? null : parseGitHubRepoSlug(out);
    },
  };
}

// ---------------------------------------------------------------------------
// Review semantics
// ---------------------------------------------------------------------------

export interface ForgeReview {
  readonly login: string | null;
  readonly userType: string | null;
  readonly state: string;
  readonly commitId: string | null;
}

function toReview(raw: unknown): ForgeReview | null {
  const rec = asRecord(raw);
  if (rec === null || typeof rec.state !== "string") return null;
  const user = asRecord(rec.user);
  return {
    login: typeof user?.login === "string" ? user.login : null,
    userType: typeof user?.type === "string" ? user.type : null,
    state: rec.state.toUpperCase(),
    commitId: typeof rec.commit_id === "string" ? rec.commit_id.toLowerCase() : null,
  };
}

const DECIDING_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Currently effective approvals: per reviewer, the latest APPROVED /
 * CHANGES_REQUESTED / DISMISSED review decides; COMMENTED and PENDING never
 * override. Returns reviewers whose deciding review is APPROVED, latest first.
 */
export function effectiveApprovals(reviews: readonly ForgeReview[]): ForgeReview[] {
  const latest = new Map<string, { review: ForgeReview; index: number }>();
  reviews.forEach((review, index) => {
    if (review.login === null) return;
    if (!DECIDING_STATES.has(review.state)) return;
    latest.set(review.login.toLowerCase(), { review, index });
  });
  return [...latest.values()]
    .filter((e) => e.review.state === "APPROVED")
    .sort((a, b) => b.index - a.index)
    .map((e) => e.review);
}

function encodePath(rel: string): string {
  return normalizeRel(rel)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function hashAtCommit(
  reader: ForgeApprovalReader,
  repo: string,
  xbriefRelPath: string,
  sha: string,
): ForgeReadResult<string> {
  const short = sha.slice(0, 7);
  const raw = reader.getRaw(`repos/${repo}/contents/${encodePath(xbriefRelPath)}?ref=${sha}`);
  if (!raw.ok) return { ok: false, detail: `brief unreadable at ${short}: ${raw.detail}` };
  let payload: unknown;
  try {
    payload = JSON.parse(raw.value) as unknown;
  } catch {
    return { ok: false, detail: `brief at ${short} is unreadable JSON` };
  }
  const hash = computeAuthHashV1(payload, xbriefRelPath);
  if (hash === null) return { ok: false, detail: `brief at ${short} has no plan.id` };
  return { ok: true, value: hash };
}

function listReviews(
  reader: ForgeApprovalReader,
  repo: string,
  prNumber: number,
): ForgeReadResult<ForgeReview[]> {
  const out: ForgeReview[] = [];
  for (let page = 1; page <= REVIEW_PAGE_CAP; page += 1) {
    const r = reader.getJson(
      `repos/${repo}/pulls/${String(prNumber)}/reviews?per_page=${String(REVIEW_PAGE_SIZE)}&page=${String(page)}`,
    );
    if (!r.ok) return { ok: false, detail: `reviews unavailable: ${r.detail}` };
    if (!Array.isArray(r.value)) return { ok: false, detail: "reviews response is not an array" };
    for (const raw of r.value) {
      const review = toReview(raw);
      if (review !== null) out.push(review);
    }
    if (r.value.length < REVIEW_PAGE_SIZE) return { ok: true, value: out };
  }
  return { ok: false, detail: `more than ${String(REVIEW_PAGE_CAP)} review pages` };
}

function hasWritePermission(
  reader: ForgeApprovalReader,
  repo: string,
  login: string,
): ForgeReadResult<boolean> {
  const r = reader.getJson(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
  if (!r.ok) return { ok: false, detail: `permission unavailable: ${r.detail}` };
  const rec = asRecord(r.value);
  const permission = typeof rec?.permission === "string" ? rec.permission.toLowerCase() : "";
  const role = typeof rec?.role_name === "string" ? rec.role_name.toLowerCase() : "";
  return { ok: true, value: WRITE_PERMISSIONS.has(permission) || WRITE_PERMISSIONS.has(role) };
}

export interface ForgeHeadBriefApprovalInput {
  readonly projectRoot: string;
  readonly context: ForgeApprovalContext;
  readonly xbriefRelPath: string;
  readonly headPayload: unknown;
}

/**
 * Decide whether a qualifying forge approval admits the evaluated head brief
 * for membership. Never throws; any failure is a reject with a reason.
 */
export function evaluateForgeHeadBriefApproval(
  input: ForgeHeadBriefApprovalInput,
): ForgeApprovalVerdict {
  try {
    return evaluateUnsafe(input);
  } catch (err) {
    return {
      kind: "reject",
      reason: `forge proof unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function evaluateUnsafe(input: ForgeHeadBriefApprovalInput): ForgeApprovalVerdict {
  // Operational deny: a returned verdict, never a throw (Path B fallback).
  const deny = (reason: string): ForgeApprovalVerdict => ({ kind: "reject", reason });
  const { context } = input;
  const rel = normalizeRel(input.xbriefRelPath);

  const headHash = computeAuthHashV1(input.headPayload, rel);
  if (headHash === null) return deny("head brief has no plan.id");
  if (!Number.isInteger(context.prNumber) || context.prNumber <= 0) {
    return deny("no PR number");
  }
  const git = context.git ?? defaultForgeApprovalGit(input.projectRoot);
  // Repo identity comes from the checkout, never from the caller: a supplied
  // repo may only confirm it, so a fork's approval cannot authorize here.
  const repo = git.originRepo();
  if (repo === null || !REPO_RE.test(repo)) return deny("project repo unresolved (origin)");
  const requested = context.repo ?? "";
  if (requested.length > 0 && requested.toLowerCase() !== repo.toLowerCase()) {
    return deny(`requested repo ${requested} is not the project repo ${repo}`);
  }
  const reader = context.reader ?? defaultForgeApprovalReader;

  const pull = reader.getJson(`repos/${repo}/pulls/${String(context.prNumber)}`);
  if (!pull.ok) return deny(`PR unavailable: ${pull.detail}`);
  const pr = asRecord(pull.value);
  const head = asRecord(pr?.head);
  const baseRepo = asRecord(asRecord(pr?.base)?.repo);
  const author = asRecord(pr?.user);
  const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : "";
  const authorLogin = typeof author?.login === "string" ? author.login.toLowerCase() : "";
  if (pr === null || pr.number !== context.prNumber) return deny("PR number mismatch");
  if (
    typeof baseRepo?.full_name !== "string" ||
    baseRepo.full_name.toLowerCase() !== repo.toLowerCase()
  ) {
    return deny("PR base repo does not match");
  }
  if (!SHA_RE.test(headSha)) return deny("PR head sha unreadable");
  if (authorLogin.length === 0) return deny("PR author unreadable");

  // Candidate head binding: the evaluated tree is the PR head, or GitHub's
  // synthetic merge commit whose second parent is the PR head.
  const localHead = git.headSha();
  const parents = git.headParents();
  const bound = localHead === headSha || (parents.length === 2 && parents[1] === headSha);
  if (!bound) return deny("evaluated HEAD is not the PR head");

  const prHeadHash = hashAtCommit(reader, repo, rel, headSha);
  if (!prHeadHash.ok) return deny(prHeadHash.detail);
  if (prHeadHash.value !== headHash) {
    return deny("evaluated brief differs from the PR head brief");
  }

  const reviews = listReviews(reader, repo, context.prNumber);
  if (!reviews.ok) return deny(reviews.detail);
  const approvals = effectiveApprovals(reviews.value);
  if (approvals.length === 0) return deny("no currently effective APPROVED review");

  const skipped: string[] = [];
  for (const review of approvals) {
    const login = review.login ?? "";
    if (review.userType !== "User" || login.toLowerCase().endsWith("[bot]")) {
      skipped.push(`${login}: not a User`);
      continue;
    }
    if (login.toLowerCase() === authorLogin) {
      skipped.push(`${login}: PR author`);
      continue;
    }
    const commitId = review.commitId ?? "";
    if (!SHA_RE.test(commitId)) {
      skipped.push(`${login}: review commit unreadable`);
      continue;
    }
    const reviewed = commitId === headSha ? prHeadHash : hashAtCommit(reader, repo, rel, commitId);
    if (!reviewed.ok) {
      skipped.push(`${login}: ${reviewed.detail}`);
      continue;
    }
    if (reviewed.value !== headHash) {
      skipped.push(`${login}: auth-hash mismatch`);
      continue;
    }
    const perm = hasWritePermission(reader, repo, login);
    if (!perm.ok) {
      skipped.push(`${login}: ${perm.detail}`);
      continue;
    }
    if (!perm.value) {
      skipped.push(`${login}: no repo write`);
      continue;
    }
    return { kind: "admit", approver: login, commitId, authHash: headHash };
  }
  return deny(`no qualifying approval (${skipped.join("; ")})`);
}
