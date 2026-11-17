/**
 * Live merge-gate signal for warn-only local hook sites (#6535).
 *
 * A repository may name one required status check that runs its full merge gate
 * in `plan.policy.mergeGateContext`. The worktree copy of the project definition
 * is only a trigger: with no name there, no GitHub call is made. With a name,
 * the signal holds only when the project definition at the head of the delivery
 * branch on GitHub names the same check AND the branch's live required status
 * contexts list it. Both reads share one short budget. Any failure, timeout or
 * mismatch means no signal and the caller refuses as today.
 *
 * The result lives in memory for one hook call. Nothing is written under
 * `.deft/`, the #1517 record and the #6281 table are not read, and no local ref
 * is trusted as authority for the name.
 */
import { relative, sep } from "node:path";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { loadProjectDefinition, projectDefinitionPath } from "../policy/resolve.js";
import { fetchRequiredStatusContexts, makeBudgetedRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { parseGitHubRepoSlug } from "../text/redos-safe.js";

/**
 * Total time for the whole signal read (contents read plus required contexts),
 * well under the 30 s tool.before host timeout. Owned by this signal; do not
 * share with another action's timing.
 */
export const MERGE_GATE_SIGNAL_READ_BUDGET_SECONDS = 10;

export interface MergeGateSignalResult {
  /** True only when the named check is live-required on the delivery branch. */
  readonly live: boolean;
  /** The named check when live, else null. */
  readonly check: string | null;
  /** The delivery branch the live read covered when live, else null. */
  readonly branch: string | null;
}

export interface MergeGateSignal {
  /** Lazy and memoized: the first call does the reads, later calls reuse them. */
  evaluate(): MergeGateSignalResult;
}

export interface MergeGateSignalOptions {
  /** Checkout whose project definition is the trigger. */
  readonly root: string;
  readonly runGit?: GitRunner;
  /** Test seam; defaults to one budgeted gh runner shared by both reads. */
  readonly runGh?: RunGhFn;
}

const NO_SIGNAL: MergeGateSignalResult = { live: false, check: null, branch: null };

/** The trimmed `plan.policy.mergeGateContext` of a parsed project definition, or null. */
export function readMergeGateContext(data: Record<string, unknown> | null): string | null {
  if (data === null) return null;
  const policy = readPlanPolicy(data.plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return null;
  const raw = (policy as Record<string, unknown>).mergeGateContext;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function decodeContentsPayload(stdout: string): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(stdout) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const body = payload as Record<string, unknown>;
    if (body.encoding !== "base64" || typeof body.content !== "string") return null;
    const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

function evaluateSignal(options: MergeGateSignalOptions): MergeGateSignalResult {
  const root = options.root;
  const runGit = options.runGit ?? defaultGitRunner;
  const trigger = readMergeGateContext(loadProjectDefinition(root)[0]);
  if (trigger === null) return NO_SIGNAL;

  const remote = runGit(root, ["remote", "get-url", "origin"]);
  const repo = remote.code === 0 ? parseGitHubRepoSlug(remote.stdout) : null;
  if (repo === null) return NO_SIGNAL;
  const delivery = resolveDeliveryBranch(root, runGit);
  if (delivery.error !== null || delivery.branch === "") return NO_SIGNAL;
  const branch = delivery.branch;

  const runGh = options.runGh ?? makeBudgetedRunGh(MERGE_GATE_SIGNAL_READ_BUDGET_SECONDS * 1000);

  // The name is read only from GitHub, at the delivery-branch head.
  const rel = relative(root, projectDefinitionPath(root)).split(sep).join("/");
  const contents = runGh([
    "gh",
    "api",
    `repos/${repo}/contents/${rel}?ref=${encodeURIComponent(branch)}`,
  ]);
  if (contents.returncode !== 0) return NO_SIGNAL;
  const remoteDefinition = decodeContentsPayload(contents.stdout);
  if (readMergeGateContext(remoteDefinition) !== trigger) return NO_SIGNAL;

  const required = fetchRequiredStatusContexts(repo, branch, runGh);
  if (required.resolutionFailed) return NO_SIGNAL;
  if (!required.contexts.some((context) => context.name === trigger)) return NO_SIGNAL;
  return { live: true, check: trigger, branch };
}

/** Lazy per-hook-call signal. Cheap to create; reads happen on first `evaluate()`. */
export function createMergeGateSignal(options: MergeGateSignalOptions): MergeGateSignal {
  let cached: MergeGateSignalResult | null = null;
  return {
    evaluate(): MergeGateSignalResult {
      if (cached === null) {
        try {
          cached = evaluateSignal(options);
        } catch {
          // Any read or setup failure (missing gh, unreadable file) is no signal.
          cached = NO_SIGNAL;
        }
      }
      return cached;
    },
  };
}

/**
 * One warning line: today's refusal text plus one clause that local enforcement
 * is advisory because the named check is required on the delivery branch. The
 * clause does not claim that check enforces the same condition.
 */
export function mergeGateWarningLine(refusal: string, signal: MergeGateSignalResult): string {
  return (
    `${refusal.trim()} Local enforcement is advisory here: ${signal.check ?? "the named check"} ` +
    `is required on ${signal.branch ?? "the delivery branch"}.`
  );
}

/** Prefix a message with `Warning:` and the collected warning lines (none: unchanged). */
export function withMergeGateWarnings(message: string, lines: readonly string[]): string {
  return lines.length === 0 ? message : `Warning: ${lines.join(" ")} ${message}`;
}
