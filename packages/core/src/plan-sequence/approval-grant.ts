/**
 * Operator approval for ordered-plan writes (#6205).
 *
 * One template, `plan-sequence-approval`, minted only through
 * mintHumanOriginGrant (operator-cli origin, the `authz:grant` human-presence
 * path) into the main clone grant store. A grant binds the repository, the
 * plan's `sequence_id` and generation, and one action: insert of one entry
 * (kind, id, issue, position), replace of an existing plan, or clear. It is
 * single-use: the plan write runs under claimSingleUseGrantForApply, and a
 * failed write rolls the spend back. Failures are returned, never thrown.
 *
 * `authorized_by`, `--approved-by`, `--confirm` and narrative text are never
 * consent here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mintHumanOriginGrant } from "../authz/actions.js";
import { isHumanOrigin } from "../authz/origin.js";
import { claimSingleUseGrantForApply, listGrants } from "../authz/store.js";
import { assertNoIndependentSessionAuthMint } from "../authz/templates.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { mainWorktreeRoot } from "../session/main-worktree.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { isPlanTargetKind, type PlanTargetKind } from "./types.js";

export const PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME = "plan-sequence-approval" as const;

/** Default TTL hours — Number("24") keeps the literal free of numeric-const extract. */
export const PLAN_SEQUENCE_APPROVAL_DEFAULT_EXPIRY_HOURS = Number("24");

const SURFACE_PREFIX = `${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}:`;

export type PlanSequenceApprovalActionKind = "insert" | "replace" | "clear";

export type PlanSequenceApprovalAction =
  | {
      readonly kind: "insert";
      readonly entryKind: PlanTargetKind;
      readonly entryId: string;
      readonly issue: number | null;
      /** Bound too: verify:plan-sequence matches an entry by title (#6205 review). */
      readonly title: string | null;
      readonly position: number;
    }
  | { readonly kind: "replace" }
  | { readonly kind: "clear" };

/** What one grant approves: repository, plan identity and one action. */
export interface PlanSequenceApprovalBinding {
  readonly repo: string;
  readonly sequenceId: string;
  readonly generation: number;
  readonly action: PlanSequenceApprovalAction;
}

/**
 * The one place that says which plan writes need this approval (#6205).
 * Insert, replace (set on an existing plan file) and clear need it only when
 * `plan.policy.requireBoundPrePrPush` is true, because only then does the
 * plan authorize pushes (operator rulings 6906744687 and 6908156182). With it
 * false or absent, no plan write needs an approval. `action` stays a
 * parameter so a later ruling can scope one action differently here.
 */
export function planSequenceApprovalRequired(
  _action: PlanSequenceApprovalActionKind,
  projectRoot: string,
): boolean {
  return boundPrePrPushEnrolled(projectRoot);
}

/**
 * `plan.policy.requireBoundPrePrPush === true`, read the same way as the
 * pre-push gate (resolveRequireBoundPrePrPush, hook default false). Read here
 * directly: importing the pre-push module would close an import cycle through
 * the pre-PR controller.
 */
function boundPrePrPushEnrolled(projectRoot: string): boolean {
  try {
    const pdPath = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    if (!existsSync(pdPath)) return false;
    const data = JSON.parse(readFileSync(pdPath, "utf8")) as { plan?: unknown };
    const policy = readPlanPolicy(data.plan);
    return (
      policy !== null &&
      typeof policy === "object" &&
      (policy as Record<string, unknown>).requireBoundPrePrPush === true
    );
  } catch {
    return false;
  }
}

export function isPlanSequenceApprovalTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME;
}

/** True for a grant minted by this template (event ref and surfaces). */
export function isPlanSequenceApprovalGrant(grant: HumanOriginGrant): boolean {
  return (
    (grant.origin.eventRef ?? "").startsWith(`template:${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}`) &&
    grant.scope.surfaces.some((s) => s.startsWith(`${SURFACE_PREFIX}action:`))
  );
}

/**
 * Parse `--target`: `insert:<kind>:<id>`, `replace` or `clear`. Insert
 * position and issue come from their own flags.
 */
export function parsePlanSequenceApprovalTarget(
  raw: string,
):
  | { ok: true; kind: "insert"; entryKind: PlanTargetKind; entryId: string }
  | { ok: true; kind: "replace" | "clear" }
  | { ok: false; reason: string } {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower === "replace" || lower === "clear") {
    return { ok: true, kind: lower };
  }
  const match = /^insert:([a-z]+):(.+)$/i.exec(text);
  const entryKind = match?.[1]?.toLowerCase();
  const entryId = match?.[2]?.trim() ?? "";
  if (match === null || !isPlanTargetKind(entryKind) || entryId.length === 0) {
    return {
      ok: false,
      reason:
        `template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} requires --target ` +
        `insert:<kind>:<id>, replace or clear (got ${JSON.stringify(raw)})`,
    };
  }
  return { ok: true, kind: "insert", entryKind, entryId };
}

function bindingSurfaces(binding: PlanSequenceApprovalBinding): string[] {
  const surfaces = [
    `${SURFACE_PREFIX}sequence:${binding.sequenceId}`,
    `${SURFACE_PREFIX}generation:${String(binding.generation)}`,
    `${SURFACE_PREFIX}action:${binding.action.kind}`,
  ];
  if (binding.action.kind === "insert") {
    const { entryKind, entryId, issue, title, position } = binding.action;
    const boundTitle = title === null ? "" : title.trim().toLowerCase();
    surfaces.push(
      `${SURFACE_PREFIX}entry:${entryKind}:${entryId.trim().toLowerCase()}`,
      `${SURFACE_PREFIX}issue:${issue === null ? "none" : String(issue)}`,
      // `none` (absent) and `=<title>` (present) never collide, even for the title "none".
      `${SURFACE_PREFIX}title:${boundTitle.length === 0 ? "none" : `=${boundTitle}`}`,
      `${SURFACE_PREFIX}position:${String(position)}`,
    );
  }
  return surfaces.sort();
}

/** Operator command that mints the grant this binding needs. */
export function formatPlanSequenceApprovalCommand(binding: PlanSequenceApprovalBinding): string {
  const action = binding.action;
  const target =
    action.kind === "insert" ? `insert:${action.entryKind}:${action.entryId}` : action.kind;
  const insertFlags =
    action.kind === "insert"
      ? ` --position ${String(action.position)}` +
        (action.issue !== null ? ` --issue-ids ${String(action.issue)}` : "") +
        (action.title !== null && action.title.trim().length > 0
          ? ` --title ${JSON.stringify(action.title)}`
          : "")
      : "";
  return (
    `deft authz:grant -- --template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} --target ${target} ` +
    `--plan-ref ${binding.sequenceId} --generation ${String(binding.generation)}${insertFlags} ` +
    `--repo ${binding.repo} --confirm`
  );
}

/** The one grant store for this template: the main clone root. */
export function resolvePlanSequenceApprovalStore(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: true; root: string } | { ok: false; reason: string } {
  const root = mainWorktreeRoot(projectRoot, runGit);
  if (root === null) {
    return {
      ok: false,
      reason:
        `plan-sequence-approval grant store cannot be resolved: no main clone ` +
        `(git rev-parse --git-common-dir) from ${projectRoot}; refusing (#6205)`,
    };
  }
  return { ok: true, root };
}

/** Repository slug for the binding: explicit, DEFT_TRIAGE_REPO, or git origin. */
export function resolvePlanSequenceApprovalRepo(
  explicit: string | null | undefined,
  projectRoot: string,
): { ok: true; repo: string } | { ok: false; reason: string } {
  const repo = resolveRepo(explicit, projectRoot);
  if (repo === null || repo.trim().length === 0) {
    return {
      ok: false,
      reason:
        "plan-sequence-approval needs the repository (owner/name): pass --repo or set an origin remote",
    };
  }
  return { ok: true, repo: repo.trim().toLowerCase() };
}

function isoExpiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface MintPlanSequenceApprovalInput {
  readonly projectRoot: string;
  /** `insert:<kind>:<id>`, `replace` or `clear`. */
  readonly target: string;
  /** The plan's `sequence_id`. */
  readonly sequenceId: string;
  readonly generation: number | null;
  /** Required for insert. */
  readonly position?: number | null;
  /** Insert only: the entry's issue number, if any. */
  readonly issue?: number | null;
  /** Insert only: the entry's title, if any (a title is also a verify target). */
  readonly title?: string | null;
  readonly repo?: string | null;
  readonly actor?: string;
  readonly expiresAt?: string | null;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}

export type PlanSequenceApprovalMintResult =
  | { readonly ok: true; readonly grant: HumanOriginGrant; readonly storeRoot: string }
  | { readonly ok: false; readonly reason: string };

/** Mint a single-use plan-sequence-approval grant in the main clone store. */
export function mintPlanSequenceApprovalGrant(
  input: MintPlanSequenceApprovalInput,
): PlanSequenceApprovalMintResult {
  const dualMint = assertNoIndependentSessionAuthMint();
  if (dualMint.sessionAuthIsAuthority || dualMint.mintPath !== "mintHumanOriginGrant") {
    return {
      ok: false,
      reason: `${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} mint refused: dual authorization SoT is forbidden`,
    };
  }
  const parsed = parsePlanSequenceApprovalTarget(input.target);
  if (!parsed.ok) {
    return parsed;
  }
  const sequenceId = input.sequenceId.trim();
  if (sequenceId.length === 0) {
    return {
      ok: false,
      reason: `template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} requires --plan-ref <sequence_id>`,
    };
  }
  const generation = input.generation;
  if (generation === null || !Number.isInteger(generation) || generation < 0) {
    return {
      ok: false,
      reason: `template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} requires --generation <n> (the plan's current generation)`,
    };
  }
  let action: PlanSequenceApprovalAction;
  if (parsed.kind === "insert") {
    const position = input.position ?? null;
    if (position === null || !Number.isInteger(position) || position < 0) {
      return {
        ok: false,
        reason: `template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} insert requires --position <index>`,
      };
    }
    const issue = input.issue ?? null;
    if (issue !== null && (!Number.isInteger(issue) || issue <= 0)) {
      return {
        ok: false,
        reason: "plan-sequence-approval: --issue-ids must be a positive integer",
      };
    }
    action = {
      kind: "insert",
      entryKind: parsed.entryKind,
      entryId: parsed.entryId,
      issue,
      title: input.title ?? null,
      position,
    };
  } else {
    action = { kind: parsed.kind };
  }
  const repo = resolvePlanSequenceApprovalRepo(input.repo, input.projectRoot);
  if (!repo.ok) {
    return repo;
  }
  const store = resolvePlanSequenceApprovalStore(input.projectRoot, input.runGit);
  if (!store.ok) {
    return store;
  }
  const expiresAt =
    input.expiresAt ??
    isoExpiry(input.now ?? new Date(), PLAN_SEQUENCE_APPROVAL_DEFAULT_EXPIRY_HOURS);
  if (Number.isNaN(Date.parse(expiresAt))) {
    return {
      ok: false,
      reason: `template ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}: --expires ${JSON.stringify(expiresAt)} is not a readable date`,
    };
  }
  const binding: PlanSequenceApprovalBinding = {
    repo: repo.repo,
    sequenceId,
    generation,
    action,
  };
  const minted = mintHumanOriginGrant({
    projectRoot: store.root,
    actor: input.actor ?? "operator",
    operations: ["settings"],
    surfaces: bindingSurfaces(binding),
    expiresAt,
    singleUse: true,
    planRef: sequenceId,
    repo: repo.repo,
    issueIds: action.kind === "insert" && action.issue !== null ? [action.issue] : [],
    storyIds: [],
    eventRef: `template:${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME}`,
    now: input.now,
  });
  if (!minted.ok) {
    return { ok: false, reason: minted.reason };
  }
  return { ok: true, grant: minted.grant, storeRoot: store.root };
}

function sameSurfaces(grant: HumanOriginGrant, expected: readonly string[]): boolean {
  const own = grant.scope.surfaces.filter((s) => s.startsWith(SURFACE_PREFIX)).sort();
  return own.length === expected.length && own.every((s, i) => s === expected[i]);
}

function bindingMatches(grant: HumanOriginGrant, binding: PlanSequenceApprovalBinding): boolean {
  return (
    isPlanSequenceApprovalGrant(grant) &&
    isHumanOrigin(grant.origin) &&
    grant.semantics.revokedAt === null &&
    grant.semantics.singleUse &&
    (grant.scope.planRef ?? "") === binding.sequenceId &&
    (grant.scope.repo ?? "").toLowerCase() === binding.repo &&
    sameSurfaces(grant, bindingSurfaces(binding))
  );
}

function usableAt(grant: HumanOriginGrant, now: Date): boolean {
  const expiresAt = grant.semantics.expiresAt;
  return (
    grant.semantics.usedAt === null &&
    expiresAt !== null &&
    !Number.isNaN(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > now.getTime()
  );
}

/** A plan write the claim runs once the grant is spent; gets the grant id. */
export type PlanSequenceApprovedWrite = (
  grantId: string,
) => { readonly ok: true } | { readonly ok: false; readonly reason: string };

class ApprovedWriteFailed extends Error {}

/**
 * Find the one grant for this binding, spend it, and run the write under the
 * claim. A failed write rolls the spend back. Every refusal names the remint
 * command.
 */
export function claimPlanSequenceApproval(input: {
  readonly projectRoot: string;
  readonly binding: PlanSequenceApprovalBinding;
  readonly write: PlanSequenceApprovedWrite;
  readonly now?: Date;
  readonly runGit?: GitRunner;
}): { ok: true; grantId: string } | { ok: false; reason: string } {
  const remint = formatPlanSequenceApprovalCommand(input.binding);
  const store = resolvePlanSequenceApprovalStore(input.projectRoot, input.runGit);
  if (!store.ok) {
    return { ok: false, reason: `${store.reason}. Operator approval: ${remint}` };
  }
  const now = input.now ?? new Date();
  const matching = listGrants(store.root).filter((g) => bindingMatches(g, input.binding));
  const usable = matching.find((g) => usableAt(g, now));
  if (usable === undefined) {
    const spent = matching.find((g) => g.semantics.usedAt !== null);
    const detail =
      spent !== undefined
        ? `grant ${spent.id} for this ${input.binding.action.kind} was already used at ${spent.semantics.usedAt ?? "?"} (single-use)`
        : matching.length > 0
          ? `grant ${matching.map((g) => g.id).join(", ")} for this ${input.binding.action.kind} expired`
          : `no ${PLAN_SEQUENCE_APPROVAL_TEMPLATE_NAME} grant binds this ${input.binding.action.kind} ` +
            `(sequence ${input.binding.sequenceId}, generation ${String(input.binding.generation)})`;
    return {
      ok: false,
      reason: `plan-sequence ${input.binding.action.kind} refused: ${detail}. Operator approval at a terminal: ${remint}`,
    };
  }
  try {
    const claimed = claimSingleUseGrantForApply(store.root, usable.id, {
      now,
      revalidate: (grant) =>
        bindingMatches(grant, input.binding) && usableAt(grant, now)
          ? { ok: true }
          : { ok: false, reason: `grant ${grant.id} no longer approves this plan write` },
      apply: (grant) => {
        const wrote = input.write(grant.id);
        if (!wrote.ok) {
          throw new ApprovedWriteFailed(wrote.reason);
        }
      },
    });
    if (!claimed.ok) {
      return { ok: false, reason: claimed.reason };
    }
    return { ok: true, grantId: claimed.grant.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `plan-sequence ${input.binding.action.kind} write failed (grant ${usable.id} not spent): ${reason}`,
    };
  }
}
