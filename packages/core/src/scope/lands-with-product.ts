/**
 * In-PR story completion (#6277, accepted Bound on lean 6860551121).
 *
 * A story's last product PR carries its brief from `active/` to `completed/`
 * (`scope:complete --in-pr`). The brief is stamped with completion
 * disposition `lands-with-product` and carries no delivered provenance and no
 * merge evidence. Three checks keep that honest:
 *
 * - in-PR mode refuses on the brief's own inputs when its acceptance rests on
 *   a merge ({@link evaluateInPrCompletionInputs});
 * - CI admits the `completed/` add only on facts the identity join after merge
 *   also accepts ({@link evaluateLandsWithProductAdmission});
 * - after merge, the close proofs re-run the identity join on the commit that
 *   landed the brief (`lifecycle/lands-with-product-proof.ts`).
 *
 * The human product merge plus that identity join is the completion proof.
 * Stories the product PR cannot carry keep the post-merge path (#6303).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { isTestOrFixturePath, pathMatchesFileScope } from "../scope-provenance/base-fence.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import {
  isClauseLessAcceptance,
  itemDeclaresMergeRequirement,
  readNamespacedAcceptanceFields,
} from "./acceptance-evidence.js";
import {
  bodyHasClosingKeywordFor,
  bodyHasStoryPartLine,
  isDeliveryBriefLandPath,
  type PrFileEntry,
  prDiffAddsBrief,
  resolvePlanGithubIssueRef,
} from "./delivery-evidence.js";
import { isLandsWithProductPlan } from "./lifecycle-write.js";

/** Recovery named by every in-PR refusal (#6277 Bound 1). */
export const IN_PR_POST_MERGE_PATH =
  "Use the post-merge path: merge the product PR without the brief move, then run " +
  "`task scope:complete -- <active-path>` (or `task swarm:finalize-cohort`) and land the " +
  "lifecycle PR. Stories the product PR cannot carry are tracked on #6303.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Every plan item, nested `items` / `subItems` included. */
function walkPlanItems(items: unknown, out: Record<string, unknown>[]): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const item = asRecord(raw);
    if (item === null) continue;
    out.push(item);
    walkPlanItems(item.items, out);
    walkPlanItems(item.subItems, out);
  }
}

function evidenceKind(value: unknown): string | null {
  const rec = asRecord(value);
  return typeof rec?.kind === "string" ? rec.kind.trim().toLowerCase() : null;
}

/** True when an item already stores acceptance evidence of kind `merge`. */
function itemStoresMergeEvidence(item: Record<string, unknown>): boolean {
  const fields = readNamespacedAcceptanceFields(item);
  return evidenceKind(fields.evidence) === "merge" || evidenceKind(item.evidence) === "merge";
}

function itemLabel(item: Record<string, unknown>, index: number): string {
  return typeof item.id === "string" && item.id.trim().length > 0
    ? item.id.trim()
    : `item ${String(index + 1)}`;
}

function hasStoredProvenance(plan: Record<string, unknown>): boolean {
  const meta = asRecord(plan.metadata);
  return meta?.completionProvenance !== undefined && meta.completionProvenance !== null;
}

/** The brief's `metadata.swarm.file_scope` entries. */
export function planFileScope(plan: Record<string, unknown>): string[] {
  const meta = asRecord(plan.metadata);
  const swarm = asRecord(meta?.swarm);
  const scope = swarm?.file_scope;
  return Array.isArray(scope)
    ? scope.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

/**
 * A production path for in-PR completion: not lifecycle state (`xbrief/`,
 * `vbrief/`, changelog entries, the spec-drift ledger) and not a test or
 * fixture path.
 */
export function isInPrProductionPath(path: string): boolean {
  const p = normalize(path);
  if (p.length === 0) return false;
  if (isDeliveryBriefLandPath(p) || p.startsWith("xbrief/") || p.startsWith("vbrief/")) {
    return false;
  }
  return !isTestOrFixturePath(p);
}

export type InPrInputsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Bound 1 refusals on the brief's own inputs, before in-PR mode runs. A story
 * whose acceptance rests on a merge keeps the post-merge path: judged by what
 * the brief contains, not by what in-PR mode would write.
 */
export function evaluateInPrCompletionInputs(
  plan: Record<string, unknown>,
  input: { readonly changedPaths: readonly string[] | null },
): InPrInputsResult {
  const reasons: string[] = [];
  const items: Record<string, unknown>[] = [];
  walkPlanItems(plan.items, items);
  items.forEach((item, index) => {
    if (itemDeclaresMergeRequirement(item)) {
      reasons.push(`${itemLabel(item, index)} declares the merge requirement`);
    }
    if (itemStoresMergeEvidence(item)) {
      reasons.push(`${itemLabel(item, index)} stores acceptance evidence of kind merge`);
    }
  });
  if (hasStoredProvenance(plan)) {
    reasons.push("the brief already stores completionProvenance");
  }
  if (isClauseLessAcceptance(plan)) {
    reasons.push("the brief's acceptance has no clauses");
  }
  if (resolvePlanGithubIssueRef(plan) === null) {
    reasons.push("the brief has no GitHub issue reference");
  }
  if (input.changedPaths === null) {
    reasons.push("the branch's changed files could not be read");
  } else {
    const scope = planFileScope(plan);
    const inScope = input.changedPaths.some(
      (path) => isInPrProductionPath(path) && pathMatchesFileScope(normalize(path), scope),
    );
    if (!inScope) {
      reasons.push("the branch changes no production file inside the brief's file_scope");
    }
  }
  if (reasons.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `scope:complete --in-pr refused (#6277): ${reasons.join("; ")}. ${IN_PR_POST_MERGE_PATH}`,
  };
}

function runGitOut(runGit: GitRunner, root: string, args: readonly string[]): string | null {
  try {
    const result = runGit(root, args);
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/** Base ref for the branch: DEFT_BASE_REF, GITHUB_BASE_REF, then origin/<deliveryBranch>. */
export function resolveInPrBaseRef(projectRoot: string, runGit: GitRunner): string | null {
  const candidates: string[] = [];
  const envBase = process.env.DEFT_BASE_REF?.trim() ?? "";
  if (envBase.length > 0) candidates.push(envBase);
  const ghBase = process.env.GITHUB_BASE_REF?.trim() ?? "";
  if (ghBase.length > 0) candidates.push(`origin/${ghBase}`);
  try {
    const delivery = resolveDeliveryBranch(projectRoot, runGit);
    if (delivery.branch.trim().length > 0) candidates.push(`origin/${delivery.branch.trim()}`);
  } catch {
    // fall through to the fixed defaults
  }
  candidates.push("origin/master", "origin/main");
  for (const ref of candidates) {
    if (runGitOut(runGit, projectRoot, ["rev-parse", "--verify", "-q", ref]) !== null) {
      return ref;
    }
  }
  return null;
}

/** Merge base of HEAD and the delivery base ref, or null when unresolvable. */
export function resolveBranchMergeBase(
  projectRoot: string,
  options: { readonly baseRef?: string | null; readonly runGit?: GitRunner } = {},
): string | null {
  const root = resolve(projectRoot);
  const runGit = options.runGit ?? defaultGitRunner;
  const baseRef = options.baseRef ?? resolveInPrBaseRef(root, runGit);
  if (baseRef === null || baseRef.trim().length === 0) {
    return null;
  }
  const sha = runGitOut(runGit, root, ["merge-base", "HEAD", baseRef.trim()])?.trim() ?? "";
  return sha.length > 0 ? sha : null;
}

/**
 * Files the branch changes against its merge base: committed, staged and
 * unstaged tracked changes plus untracked files. Null when git cannot answer.
 */
export function listBranchChangedPaths(
  projectRoot: string,
  options: { readonly baseRef?: string | null; readonly runGit?: GitRunner } = {},
): string[] | null {
  const root = resolve(projectRoot);
  const runGit = options.runGit ?? defaultGitRunner;
  const base = resolveBranchMergeBase(root, { ...options, runGit });
  if (base === null) return null;
  const diff = runGitOut(runGit, root, ["diff", "--name-only", base]);
  const untracked = runGitOut(runGit, root, ["ls-files", "--others", "--exclude-standard"]);
  if (diff === null || untracked === null) return null;
  const out = new Set<string>();
  for (const line of `${diff}\n${untracked}`.split(/\r?\n/)) {
    const p = normalize(line.trim());
    if (p.length > 0) out.add(p);
  }
  return [...out];
}

/** One change-set record, as `git diff --name-status` reports it. */
export interface ChangeSetRecord {
  readonly status: "A" | "D" | "M" | "R";
  readonly src: string;
  readonly dest: string;
}

const ACTIVE_BRIEF_RE = /^(xbrief|vbrief)\/active\/([^/]+)$/;
const COMPLETED_BRIEF_RE = /^(xbrief|vbrief)\/completed\/([^/]+)$/;

function briefParts(rel: string, re: RegExp): { root: string; name: string } | null {
  const m = re.exec(normalize(rel));
  return m === null ? null : { root: m[1] ?? "", name: m[2] ?? "" };
}

/** PR changed-file entries for {@link prDiffAddsBrief} built from change-set records. */
export function changeSetRecordsToPrFiles(records: readonly ChangeSetRecord[]): PrFileEntry[] {
  return records.map((rec) => {
    if (rec.status === "R") {
      return { status: "renamed", filename: rec.dest, previousFilename: rec.src };
    }
    if (rec.status === "D") {
      return { status: "removed", filename: rec.src };
    }
    return { status: rec.status === "A" ? "added" : "modified", filename: rec.dest };
  });
}

export interface LandsWithProductAdmissionInput {
  /** The `completed/` path being admitted. */
  readonly completedRel: string;
  readonly plan: Record<string, unknown>;
  readonly records: readonly ChangeSetRecord[];
  /**
   * PR body. `undefined` means no PR context (local run or merge queue): the
   * keyword condition is reported as not evaluated; CI on the PR event checks it.
   */
  readonly prBody?: string;
}

export type LandsWithProductAdmission =
  | { readonly ok: true; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Bound 3 admission for a `lands-with-product` `completed/` add: the brief
 * leaves `active/` in the same change set (rename, or delete of the same
 * basename beside the add); `prDiffAddsBrief` holds; every changed production
 * file sits inside the brief's `file_scope`; and the PR body has a closing
 * keyword for the brief's issue. A part line for the issue is refused too,
 * because the identity join after merge refuses it on every basis (#6317).
 * No sole-mark scan is used.
 */
export function evaluateLandsWithProductAdmission(
  input: LandsWithProductAdmissionInput,
): LandsWithProductAdmission {
  const reasons: string[] = [];
  const notes: string[] = [];
  const completed = briefParts(input.completedRel, COMPLETED_BRIEF_RE);
  if (completed === null) {
    return { ok: false, reasons: [`${input.completedRel} is not a completed/ brief path`] };
  }
  const activeRel = `${completed.root}/active/${completed.name}`;
  const leavesActive = input.records.some(
    (rec) =>
      (rec.status === "R" &&
        normalize(rec.src) === activeRel &&
        normalize(rec.dest) === normalize(input.completedRel)) ||
      (rec.status === "D" && normalize(rec.src) === activeRel),
  );
  if (!leavesActive) {
    reasons.push(`the change set does not remove ${activeRel}`);
  }
  if (!prDiffAddsBrief(changeSetRecordsToPrFiles(input.records), completed.name)) {
    reasons.push(`the change set does not add ${completed.name} beside a code change`);
  }
  if (hasStoredProvenance(input.plan)) {
    reasons.push("a lands-with-product brief must not carry completionProvenance");
  }
  const scope = planFileScope(input.plan);
  const outside = new Set<string>();
  for (const rec of input.records) {
    for (const path of rec.status === "R" ? [rec.src, rec.dest] : [rec.dest]) {
      const p = normalize(path);
      if (isInPrProductionPath(p) && !pathMatchesFileScope(p, scope)) {
        outside.add(p);
      }
    }
  }
  if (outside.size > 0) {
    reasons.push(
      `production files outside the brief's file_scope: ${[...outside].sort().join(", ")}`,
    );
  }
  const issue = resolvePlanGithubIssueRef(input.plan);
  if (issue === null) {
    reasons.push("the brief has no GitHub issue reference");
  } else if (input.prBody === undefined) {
    notes.push(
      `closing keyword for ${issue.repository}#${String(issue.issueNumber)} not evaluated ` +
        "outside a pull_request context (pass --pr-body-file to check it locally)",
    );
  } else {
    if (!bodyHasClosingKeywordFor(input.prBody, issue.repository, issue.issueNumber)) {
      reasons.push(`the PR body has no closing keyword for #${String(issue.issueNumber)}`);
    }
    if (bodyHasStoryPartLine(input.prBody, issue.issueNumber)) {
      reasons.push(
        `the PR body carries \`deft-story-part: ${String(issue.issueNumber)}\`; a part line ` +
          "cannot complete the story (#6317)",
      );
    }
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, notes };
}

/** A brief this change set moves from `active/` to `completed/` as `lands-with-product`. */
export interface LandsWithProductMove {
  readonly activeRel: string;
  readonly completedRel: string;
  readonly plan: Record<string, unknown>;
  readonly planId: string;
}

function readPlan(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const data = asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return asRecord(data?.plan);
  } catch {
    return null;
  }
}

/** Parse `git diff --name-status -M` stdout into change-set records. */
export function parseNameStatus(stdout: string): ChangeSetRecord[] {
  const out: ChangeSetRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const code = (parts[0] ?? "").trim().charAt(0);
    if (code === "R" && parts.length >= 3) {
      out.push({ status: "R", src: normalize(parts[1] ?? ""), dest: normalize(parts[2] ?? "") });
    } else if ((code === "A" || code === "D" || code === "M") && parts.length >= 2) {
      const path = normalize(parts[1] ?? "");
      out.push({ status: code, src: path, dest: path });
    }
  }
  return out;
}

/**
 * Lands-with-product moves in this branch's change set against its merge base:
 * an `active/` brief deleted or renamed whose same-basename `completed/` file
 * on disk is stamped `lands-with-product`. Story gates use this to find the
 * story's brief after the move (Bound 6). Empty when git cannot answer.
 */
export function discoverLandsWithProductMoves(
  projectRoot: string,
  options: { readonly baseRef?: string | null; readonly runGit?: GitRunner } = {},
): LandsWithProductMove[] {
  const root = resolve(projectRoot);
  const runGit = options.runGit ?? defaultGitRunner;
  const base = resolveBranchMergeBase(root, { ...options, runGit });
  if (base === null) return [];
  const stdout = runGitOut(runGit, root, ["diff", "--name-status", "-M", base]);
  if (stdout === null) return [];
  const moves: LandsWithProductMove[] = [];
  const seen = new Set<string>();
  for (const rec of parseNameStatus(stdout)) {
    if (rec.status !== "D" && rec.status !== "R") continue;
    const active = briefParts(rec.src, ACTIVE_BRIEF_RE);
    if (active === null) continue;
    const completedRel = `${active.root}/completed/${active.name}`;
    if (seen.has(completedRel)) continue;
    const plan = readPlan(join(root, ...completedRel.split("/")));
    if (plan === null || !isLandsWithProductPlan(plan)) continue;
    seen.add(completedRel);
    moves.push({
      activeRel: normalize(rec.src),
      completedRel,
      plan,
      planId: typeof plan.id === "string" ? plan.id.trim() : "",
    });
  }
  return moves;
}

/**
 * True when a story pin (`DEFT_ACTIVE_SCOPE` or a bound path) names this move's
 * brief: its old `active/` path, its new `completed/` path (relative or
 * absolute), or its basename. A pin set before `scope:complete --in-pr` keeps
 * naming the story after the move (#6277).
 */
export function pinNamesLandsWithProductMove(
  projectRoot: string,
  pin: string,
  move: LandsWithProductMove,
): boolean {
  const raw = pin.trim();
  if (raw.length === 0) return false;
  const rel = isAbsolute(raw) ? relative(resolve(projectRoot), resolve(raw)) : raw;
  const want = normalize(rel).toLowerCase();
  const name = move.completedRel.split("/").pop() ?? "";
  return [move.activeRel, move.completedRel, name].some(
    (candidate) => normalize(candidate).toLowerCase() === want,
  );
}

/** The single lands-with-product move of this change set, or null (none or several). */
export function soleLandsWithProductMove(
  projectRoot: string,
  options: { readonly baseRef?: string | null; readonly runGit?: GitRunner } = {},
): LandsWithProductMove | null {
  const moves = discoverLandsWithProductMoves(projectRoot, options);
  return moves.length === 1 ? (moves[0] ?? null) : null;
}
