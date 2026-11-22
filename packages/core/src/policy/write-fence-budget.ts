/**
 * Write-time extra-path admission for the story write fence (#6221).
 *
 * The story write fence uses the same extra-path rule as membership and the
 * Path-independent `verify:scope-provenance` check
 * (`scope-provenance/extra-path-admission.ts`), under the same allowlist
 * authority: the merge-base mint when present (or the admitted one-PR mint,
 * #6361), else the merge-base brief's concrete `file_scope`. A glob entry
 * without a mint does not admit on its own; a matching path is an extra.
 *
 * The budget counts the cumulative distinct paths of the story: merge-base to
 * the working tree (committed, staged, unstaged) plus untracked files plus
 * every target of the pending operation. A path already counted spends
 * nothing again. Any inventory or mint read failure refuses closed.
 *
 * The result only changes the story allow layer. Project allow and deny
 * paths, story deny paths, protected stores and active-brief protection are
 * applied by the caller as before. #6203 forge approval is never read here.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isChangelogEntryPath } from "../changelog/entry-path.js";
import { matchAny } from "../orchestration/pathspec.js";
import type { RefusalDeclaration } from "../refusal-declarations/table.js";
import {
  approvedScopeSafePlanId,
  isHumanApprovalStamp,
  normalizeFileScope,
} from "../scope-provenance/digest.js";
import { basenameMintPathOk, parseApprovedScopeRecordRaw } from "../scope-provenance/evaluate.js";
import {
  assessExtraPaths,
  classifyExtraPath,
  declaredExtraPathRefusal,
  EXTRA_PATH_NOT_ADMITTED_TOKEN,
  EXTRA_PATHS_OVER_BUDGET_TOKEN,
  type ExtraPathAssessment,
  type ExtraPathAuthority,
  type ExtraPathChangeKind,
  extraPathRemedy,
  matchesExtraPathAllowlist,
} from "../scope-provenance/extra-path-admission.js";
import { loadTestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  continueCheckpointRefusalNote,
  isContinueCheckpointPath,
} from "./continue-checkpoint-path.js";
import type { StoryWriteFenceView } from "./write-fence.js";

/** Git seam: run `git <args>` in `root`; a spawn failure is `code !== 0`. */
export type WriteFenceGit = (
  root: string,
  args: readonly string[],
) => { readonly code: number; readonly stdout: string };

function defaultWriteFenceGit(
  root: string,
  args: readonly string[],
): { readonly code: number; readonly stdout: string } {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.signal !== null) return { code: 1, stdout: "" };
  return { code: result.status ?? 1, stdout: result.stdout ?? "" };
}

export type StoryWriteAllowDecision =
  /** The fence carries no merge base: keep today's story allow layer. */
  | { readonly kind: "unchanged" }
  /** Story allow layer to use: the allowlist plus admitted extras. */
  | {
      readonly kind: "scope";
      readonly storyAllow: readonly string[];
      readonly assessment: ExtraPathAssessment | null;
      /** Warn-mode declared refusal lines (#6281): the targets are admitted and the caller prints these. */
      readonly warnings?: readonly string[];
    }
  /** Refuse; `storyAllow` is the allowlist without extras. */
  | {
      readonly kind: "refuse";
      readonly reason: string;
      readonly storyAllow: readonly string[];
      /**
       * True only for a refusal that is purely a story-scope verdict (path not
       * admitted, allowance spent). A read failure or invalid record stays hard,
       * so a live merge gate (#6535) may warn on this one and never on the rest.
       */
      readonly scopeOnly?: true;
    };

export interface ResolveStoryWriteAllowInput {
  /** Root of the tree the write lands in. */
  readonly projectRoot: string;
  readonly fence: StoryWriteFenceView;
  /** Repo-relative POSIX targets; null for a target outside the tree. */
  readonly targets: readonly (string | null)[];
  /**
   * `write`: a target already in the inventory spends nothing again (PreToolUse).
   * `commit`: the staged targets are the change; any target past the budget refuses.
   */
  readonly mode?: "write" | "commit";
  /** Paths that are not the story's change (merge arrivals, #6379): left out of the inventory. */
  readonly excludeFromInventory?: readonly string[];
  /** Declared refusal rows (tests); defaults to the shipped table (#6281). */
  readonly refusalRows?: readonly RefusalDeclaration[];
  readonly git?: WriteFenceGit;
  readonly roots?: {
    readonly testRoots?: readonly string[];
    readonly fixtureRoots?: readonly string[];
    readonly sourceRoots?: readonly string[];
  };
}

function normalizeRel(raw: string): string {
  // No trim: a POSIX name may end in whitespace and is a different path from the trimmed one.
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Every git call here passes `-z`, so NUL is the only separator (a name may hold a newline). */
function linesOf(stdout: string): string[] {
  return stdout
    .split("\0")
    .map((line) => normalizeRel(line))
    .filter((line) => line.length > 0);
}

type Authority =
  | {
      readonly kind: "ok";
      readonly authority: ExtraPathAuthority;
      readonly allowlist: string[];
      /** Merge-base brief a declared path must also match under a mint (#5192). */
      readonly also?: string[];
    }
  | { readonly kind: "refuse"; readonly reason: string };

/** Same authority membership uses for this story (#6221 / #5192 / #6361). */
function resolveAuthority(
  root: string,
  fence: StoryWriteFenceView,
  sha: string,
  git: WriteFenceGit,
): Authority {
  const brief = normalizeFileScope(fence.fileScope);
  if (fence.onePrMint?.admitted === true) {
    return { kind: "ok", authority: "mint", allowlist: brief };
  }
  // A brief with no plan.id keys its mint by the brief's leaf name, as the PR check does.
  const hasPlanId = typeof fence.planId === "string" && fence.planId.trim().length > 0;
  const leaf = (fence.briefRel ?? "")
    .split("/")
    .pop()
    ?.replace(/\.xbrief\.json$/i, "")
    .replace(/\.vbrief\.json$/i, "");
  const planId = hasPlanId ? (fence.planId as string) : (leaf ?? "");
  if (planId.trim().length === 0) {
    return { kind: "ok", authority: "concrete", allowlist: brief };
  }
  const rel = `.deft/approved-scope/${approvedScopeSafePlanId(planId)}.json`;
  const exists = git(root, ["cat-file", "-e", `${sha}:${rel}`]);
  if (exists.code !== 0) {
    return { kind: "ok", authority: "concrete", allowlist: brief };
  }
  const shown = git(root, ["show", `${sha}:${rel}`]);
  if (shown.code !== 0) {
    return {
      kind: "refuse",
      reason: `merge-base mint read failed for ${rel}; fail closed (#6221)`,
    };
  }
  const parsed = parseApprovedScopeRecordRaw(shown.stdout);
  if (parsed === null || !isHumanApprovalStamp(parsed.humanApproval) || parsed.planId !== planId) {
    return {
      kind: "refuse",
      reason: `merge-base mint at ${rel} is invalid for ${planId}; fail closed (#6221 / #5192)`,
    };
  }
  // A basename-keyed mint counts only for this brief's own path or its
  // lifecycle move: the same rule the PR check applies (basenameMintPathOk).
  if (!hasPlanId && !basenameMintPathOk(String(parsed.xbriefRelPath ?? ""), fence.briefRel ?? "")) {
    return { kind: "ok", authority: "concrete", allowlist: brief };
  }
  return {
    kind: "ok",
    authority: "mint",
    allowlist: normalizeFileScope(parsed.fileScope),
    also: brief,
  };
}

/**
 * Story allow layer for one operation under the shared extra-path rule
 * (#6221). Never throws; every read failure refuses.
 */
export function resolveStoryWriteAllow(
  input: ResolveStoryWriteAllowInput,
): StoryWriteAllowDecision {
  const fence = input.fence;
  const sha = fence.mergeBaseSha;
  if (typeof sha !== "string" || sha.length === 0 || fence.fileScope.length === 0) {
    return { kind: "unchanged" };
  }
  const git = input.git ?? defaultWriteFenceGit;
  const root = input.projectRoot;
  try {
    const auth = resolveAuthority(root, fence, sha, git);
    if (auth.kind === "refuse") {
      return { kind: "refuse", reason: auth.reason, storyAllow: [] };
    }
    const targets = [
      ...new Set(
        input.targets
          .filter((t): t is string => t !== null)
          .map((t) => normalizeRel(t))
          .filter((t) => t.length > 0),
      ),
    ];
    // The story allow layer becomes the exact admitted targets of this operation.
    const declared = (t: string): boolean =>
      matchesExtraPathAllowlist(t, auth.allowlist, auth.authority, auth.also);
    const storyAllow = targets.filter((t) => isChangelogEntryPath(t) || declared(t));
    const extraTargets = targets.filter((t) => !isChangelogEntryPath(t) && !declared(t));
    if (extraTargets.length === 0) {
      return { kind: "scope", storyAllow, assessment: null };
    }

    // Cumulative inventory: merge base to the working tree, plus untracked.
    const tracked = git(root, ["diff", "--name-only", "-z", "--no-renames", sha]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (tracked.code !== 0 || untracked.code !== 0) {
      return {
        kind: "refuse",
        reason:
          "story write fence could not read the change set since the merge base " +
          "(extra-path budget inventory); fail closed (#6221)",
        storyAllow,
      };
    }
    const excluded = new Set((input.excludeFromInventory ?? []).map((p) => normalizeRel(p)));
    const inventory = new Set(
      [...linesOf(tracked.stdout), ...linesOf(untracked.stdout)].filter((p) => !excluded.has(p)),
    );
    const changed = [...inventory, ...targets.filter((t) => !inventory.has(t))];

    const roots: NonNullable<ResolveStoryWriteAllowInput["roots"]> = input.roots ?? loadRoots(root);
    // Only undeclared test/fixture paths need a base-presence probe.
    const candidates = changed.filter((rel) => {
      const c = classifyExtraPath(rel, roots);
      return (c === "test" || c === "fixture") && !isChangelogEntryPath(rel) && !declared(rel);
    });
    const onBase = new Set<string>();
    if (candidates.length > 0) {
      const pathspecs = candidates.map((p) => `:(literal)${p}`);
      const listed = git(root, ["ls-tree", "-r", "--name-only", "-z", sha, "--", ...pathspecs]);
      if (listed.code !== 0) {
        return {
          kind: "refuse",
          reason: "story write fence could not read the merge-base tree; fail closed (#6221)",
          storyAllow,
        };
      }
      for (const line of linesOf(listed.stdout)) onBase.add(line);
    }
    const mode = input.mode ?? "write";
    // A Write/Edit target exists after the operation; a staged target is read from the index.
    const writtenTargets = new Set(mode === "write" ? targets : []);
    const inIndex = new Set<string>();
    if (mode === "commit" && candidates.length > 0) {
      const staged = git(root, [
        "ls-files",
        "--cached",
        "-z",
        "--",
        ...candidates.map((p) => `:(literal)${p}`),
      ]);
      if (staged.code !== 0) {
        return {
          kind: "refuse",
          reason: "story write fence could not read the staged index; fail closed (#6221)",
          storyAllow,
        };
      }
      for (const line of linesOf(staged.stdout)) inIndex.add(line);
    }
    const changeKind = (rel: string): ExtraPathChangeKind | null => {
      const present = onBase.has(rel);
      const exists =
        mode === "commit"
          ? inIndex.has(rel)
          : writtenTargets.has(rel) || existsSync(join(root, ...rel.split("/")));
      if (present && exists) return "modify";
      if (present) return "delete";
      return "add";
    };

    const assessment = assessExtraPaths({
      allowlist: auth.allowlist,
      ...(auth.also !== undefined ? { alsoAllowlist: auth.also, allowanceScope: auth.also } : {}),
      authority: auth.authority,
      changedPaths: changed,
      changeKind,
      isFree: (rel) => isChangelogEntryPath(rel),
      otherClass: "refuse",
      ...roots,
    });

    const spentTargets = extraTargets.filter((t) => assessment.spent.includes(t));
    // On a refusal, `storyAllow` still names every target the rule admits, so
    // the staged consumer reports only the refused paths as uncovered.
    const refusedTargets = extraTargets.filter((t) => assessment.refused.includes(t));
    // #6281 warn-first. Before #6221 this fence admitted exactly the paths its
    // `file_scope` globs matched and refused the rest. A refusal of a path those
    // globs did not match is that old refusal and stays hard. A refusal of a path
    // they did match (an unminted glob match that now spends the allowance, or is
    // not admitted) is new: it is a declared row that warns for one release (the
    // path is admitted with the printed line) and refuses once the row enforces.
    const globAdmittedBefore = (t: string): boolean => matchAny(fence.fileScope, t);
    const warnings: string[] = [];
    const admitted = [...spentTargets];
    if (refusedTargets.length > 0) {
      const detail = assessment.entries
        .filter((e) => refusedTargets.includes(e.path))
        .map((e) => `${e.path} (${e.pathClass}: ${e.note})`)
        .join(", ");
      const reason =
        `${EXTRA_PATH_NOT_ADMITTED_TOKEN}: ${detail} is outside the story file_scope and ` +
        "the extra-path budget does not admit it.";
      const isNew = refusedTargets.every(globAdmittedBefore);
      const remedy = notAdmittedRemedy(assessment, refusedTargets);
      const declared = isNew
        ? declaredExtraPathRefusal(assessment, "not-admitted", reason, input.refusalRows, remedy)
        : null;
      if (declared === null || !declared.proceed) {
        return {
          kind: "refuse",
          reason: declared?.line ?? `${reason} ${remedy}`,
          storyAllow: [...storyAllow, ...spentTargets],
          scopeOnly: true,
        };
      }
      warnings.push(declared.line);
      admitted.push(...refusedTargets);
    }
    const overBudget = assessment.spent.length > assessment.allowance;
    const newSpending =
      mode === "commit" ? spentTargets : spentTargets.filter((t) => !inventory.has(t));
    if (overBudget && newSpending.length > 0) {
      const overflow = new Set(assessment.overflow);
      const reason =
        `${EXTRA_PATHS_OVER_BUDGET_TOKEN}: ${String(assessment.spent.length)} extra path(s) ` +
        `would spend the allowance ${String(assessment.allowance)} ` +
        `(concreteBase=${String(assessment.concreteBaseCount)}): ${assessment.spent.join(", ")}.`;
      const isNew = spentTargets.filter((t) => overflow.has(t)).every(globAdmittedBefore);
      const declared = isNew
        ? declaredExtraPathRefusal(assessment, "over-budget", reason, input.refusalRows)
        : null;
      if (declared === null || !declared.proceed) {
        return {
          kind: "refuse",
          reason: declared?.line ?? `${reason} ${extraPathRemedy(assessment)}`,
          storyAllow: [...storyAllow, ...spentTargets.filter((t) => !overflow.has(t))],
          scopeOnly: true,
        };
      }
      warnings.push(declared.line);
    }
    return {
      kind: "scope",
      storyAllow: [...storyAllow, ...admitted],
      assessment,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: "refuse",
      reason: `story write fence extra-path check failed (${detail}); fail closed (#6221)`,
      storyAllow: [],
    };
  }
}

/**
 * Not-admitted remedy at the write fence (#6914). A refused continue checkpoint
 * is named as the checkpoint with no split or widen remedy; other refused paths
 * keep the shared remedy.
 */
function notAdmittedRemedy(
  assessment: ExtraPathAssessment,
  refusedTargets: readonly string[],
): string {
  const checkpoints = refusedTargets.filter((t) => isContinueCheckpointPath(t));
  if (checkpoints.length === 0) return extraPathRemedy(assessment);
  const note = continueCheckpointRefusalNote(checkpoints);
  if (checkpoints.length === refusedTargets.length) return note;
  return `${note} For the other paths: ${extraPathRemedy(assessment)}`;
}

function loadRoots(root: string): NonNullable<ResolveStoryWriteAllowInput["roots"]> {
  try {
    const policy = loadTestBoundaryPolicy(root);
    return {
      testRoots: policy.testRoots,
      fixtureRoots: policy.fixtureRoots,
      sourceRoots: policy.sourceRoots,
    };
  } catch {
    return {};
  }
}
