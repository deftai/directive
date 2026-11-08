/**
 * Swarm worktree package install (AC14.25) + guarded linked-worktree prep (#6100).
 * After `git worktree add`, materialize node_modules via the project PM.
 * Failure must prevent claiming readiness.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconstituteLinkedWorktreeDeposit } from "../init-deposit/gitignore.js";
import { HOST_HOOK_OUTER_PIN_HOOK_BIN_REL } from "../init-deposit/host-hook-outer.js";
import { isLinkedWorktreePath, mainWorktreeRoot } from "../session/main-worktree.js";
import {
  liveOccupancyOnTree,
  type OccupancyAdmission,
  type OccupancyRecord,
  occupancyAdmission,
  readOccupancy,
} from "../session/occupancy.js";

export type WorktreePm = "npm" | "pnpm";

export type WorktreePmInstallResult =
  | {
      readonly ok: true;
      readonly pm: WorktreePm;
      readonly skipped: boolean;
      readonly reason?: string;
    }
  | { readonly ok: false; readonly pm: WorktreePm | null; readonly message: string };

export type WorktreePmRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => { readonly status: number | null; readonly stderr: string; readonly stdout: string };

/** Outer-visible runtime pin the deposited host wrapper tests (#6100). */
export const OUTER_VISIBLE_RUNTIME_PIN_REL = HOST_HOOK_OUTER_PIN_HOOK_BIN_REL;

export type PrepareLinkedWorktreeFailureCode =
  | "not-linked"
  | "foreign-worktree"
  | "live-stranger-lease"
  | "deposit-refused"
  | "pm-failed"
  | "pin-missing";

export type PrepareLinkedWorktreeResult =
  | {
      readonly ok: true;
      readonly worktreePath: string;
      readonly pm: WorktreePm | null;
      readonly skippedInstall: boolean;
      readonly pinRel: string;
    }
  | {
      readonly ok: false;
      readonly code: PrepareLinkedWorktreeFailureCode;
      readonly message: string;
    };

export interface PrepareLinkedWorktreeSeams {
  readonly repoRoot?: string;
  readonly presenterSessionId?: string;
  readonly runner?: WorktreePmRunner;
  readonly now?: Date;
  readonly readOccupancy?: (root: string) => OccupancyRecord | null;
  readonly liveOccupancyOnTree?: (
    root: string,
    record: OccupancyRecord | null,
    now?: Date,
  ) => OccupancyRecord | null;
  readonly occupancyAdmission?: (
    record: OccupancyRecord,
    sessionId: string,
    now?: Date,
  ) => OccupancyAdmission;
  readonly mainWorktreeRoot?: (root: string) => string | null;
  readonly reconstitute?: typeof reconstituteLinkedWorktreeDeposit;
  /** When true, skip deposit/PM and only enforce lease/foreign gates + pin presence. */
  readonly requirePinOnly?: boolean;
}

function defaultRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; stderr: string; stdout: string } {
  // Windows exposes npm/pnpm as .cmd shims; spawnSync needs shell to launch them.
  // Force a non-production NODE_ENV so a runtime pin in devDependencies is installed.
  const env = { ...process.env };
  if (env.NODE_ENV === "production") {
    env.NODE_ENV = "development";
  }
  const proc = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
  });
  return {
    status: proc.status,
    stderr: typeof proc.stderr === "string" ? proc.stderr : "",
    stdout: typeof proc.stdout === "string" ? proc.stdout : "",
  };
}

function readPackageJson(worktreePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(worktreePath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasRuntimePin(pkg: Record<string, unknown>): boolean {
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const block = pkg[key];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      if ("@deftai/directive-runtime" in (block as Record<string, unknown>)) return true;
    }
  }
  return false;
}

function sameTree(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** True when the deposited-outer-visible hook-bin exists under the worktree. */
export function outerVisibleRuntimePinExists(worktreePath: string): boolean {
  return existsSync(join(resolve(worktreePath), OUTER_VISIBLE_RUNTIME_PIN_REL));
}

/** Detect npm vs pnpm from lockfile / packageManager field (AC5.6 subset). */
export function detectWorktreePm(worktreePath: string): WorktreePm | null {
  if (existsSync(join(worktreePath, "yarn.lock")) || existsSync(join(worktreePath, "bun.lockb"))) {
    return null;
  }
  if (existsSync(join(worktreePath, "bun.lock"))) return null;
  const pkg = readPackageJson(worktreePath);
  const field = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  if (field.startsWith("yarn@") || field.startsWith("bun@")) return null;
  if (field.startsWith("pnpm@") || field === "pnpm") return "pnpm";
  if (field.startsWith("npm@") || field === "npm") return "npm";
  if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(worktreePath, "package-lock.json"))) return "npm";
  if (pkg !== null) return "npm";
  return null;
}

function assertOuterVisiblePin(
  worktreePath: string,
  pm: WorktreePm | null,
): WorktreePmInstallResult {
  if (outerVisibleRuntimePinExists(worktreePath)) {
    return { ok: true, pm: pm ?? "npm", skipped: false };
  }
  return {
    ok: false,
    pm,
    message:
      `worktree PM install finished but outer-visible pin missing at ` +
      `${OUTER_VISIBLE_RUNTIME_PIN_REL}; not claiming readiness`,
  };
}

/**
 * Run project PM install in a newly created worktree (AC14.25).
 * Skips when there is no package.json. Fails closed on PM error when a
 * runtime pin is present (configured project). Success requires the
 * outer-visible hook-bin for configured (pinned) projects (#6100).
 */
export function installWorktreePackages(
  worktreePath: string,
  seams: { readonly runner?: WorktreePmRunner } = {},
): WorktreePmInstallResult {
  const pkg = readPackageJson(worktreePath);
  if (pkg === null) {
    return { ok: true, pm: "npm", skipped: true, reason: "no package.json" };
  }
  const pm = detectWorktreePm(worktreePath);
  if (pm === null) {
    return {
      ok: false,
      pm: null,
      message:
        "worktree PM install refused: Yarn/Bun projects are not supported (AC5.7). Use npm or pnpm.",
    };
  }
  const runner = seams.runner ?? defaultRunner;
  // Always include devDependencies: @deftai/directive-runtime is commonly a
  // devDependency, and NODE_ENV=production would otherwise omit it.
  const args =
    pm === "pnpm"
      ? (["install", "--frozen-lockfile", "--prod=false"] as const)
      : (["install", "--include=dev"] as const);
  const npmArgs =
    pm === "npm" && existsSync(join(worktreePath, "package-lock.json"))
      ? (["ci", "--include=dev"] as const)
      : args;
  const useArgs = pm === "npm" ? npmArgs : args;
  const proc = runner(pm, useArgs, worktreePath);
  if (proc.status !== 0) {
    // Retry npm ci failure with npm install (lockfile drift across worktrees is rare)
    if (pm === "npm" && useArgs[0] === "ci") {
      const retry = runner(pm, ["install", "--include=dev"], worktreePath);
      if (retry.status === 0) {
        if (hasRuntimePin(pkg)) {
          return assertOuterVisiblePin(worktreePath, pm);
        }
        return { ok: true, pm, skipped: false };
      }
      const detail = (retry.stderr || retry.stdout || proc.stderr || "").trim();
      return {
        ok: false,
        pm,
        message: `worktree PM install failed (${pm} install): ${detail || `exit ${retry.status}`}`,
      };
    }
    const detail = (proc.stderr || proc.stdout || "").trim();
    return {
      ok: false,
      pm,
      message: `worktree PM install failed (${pm} ${useArgs.join(" ")}): ${detail || `exit ${proc.status}`}`,
    };
  }
  // Configured projects must end with the outer-visible pin after install (#6100).
  if (hasRuntimePin(pkg)) {
    return assertOuterVisiblePin(worktreePath, pm);
  }
  return { ok: true, pm, skipped: false };
}

/** True when the worktree pin is the new runtime package (skip .deft/core copy). */
export function worktreeHasRuntimePin(worktreePath: string): boolean {
  const pkg = readPackageJson(worktreePath);
  return pkg !== null && hasRuntimePin(pkg);
}

/**
 * Shared guarded prep for an existing linked worktree (#6100 Prefer-A Recut-3).
 *
 * Order: foreign-worktree refuse → live stranger-lease refuse → deposit/PM →
 * success only when the outer-visible PIN_REL exists. Lease/foreign refuse runs
 * before any deposit write or PM invocation.
 */
export function prepareLinkedWorktree(
  worktreePathRaw: string,
  seams: PrepareLinkedWorktreeSeams = {},
): PrepareLinkedWorktreeResult {
  const worktreePath = resolve(worktreePathRaw);
  if (!isLinkedWorktreePath(worktreePath)) {
    return {
      ok: false,
      code: "not-linked",
      message: `linked-worktree prep refused: ${worktreePath} is not a linked worktree`,
    };
  }

  const mainOf = seams.mainWorktreeRoot ?? mainWorktreeRoot;
  const destMain = mainOf(worktreePath);
  const repoRootRaw = seams.repoRoot?.trim() ?? "";
  const ownershipRoot = repoRootRaw.length > 0 ? resolve(repoRootRaw) : worktreePath;
  const repoMain = mainOf(ownershipRoot);
  if (repoMain === null || destMain === null || !sameTree(repoMain, destMain)) {
    return {
      ok: false,
      code: "foreign-worktree",
      message:
        `linked-worktree prep refused: ${worktreePath} is not a linked worktree of ` +
        `${ownershipRoot} (mainWorktreeRoot mismatch before deposit/PM)`,
    };
  }

  const now = seams.now ?? new Date();
  const readOcc = seams.readOccupancy ?? readOccupancy;
  const liveOnTree = seams.liveOccupancyOnTree ?? liveOccupancyOnTree;
  const admit = seams.occupancyAdmission ?? occupancyAdmission;
  const live = liveOnTree(worktreePath, readOcc(worktreePath), now);
  if (live !== null) {
    const presenter = (seams.presenterSessionId ?? process.env.DEFT_SESSION_ID ?? "").trim() || "";
    if (admit(live, presenter, now) === "stranger") {
      return {
        ok: false,
        code: "live-stranger-lease",
        message:
          `linked-worktree prep refused: ${worktreePath} has a live occupancy lease ` +
          `and presenter admission is stranger (zero deposit/PM mutation)`,
      };
    }
  }

  if (outerVisibleRuntimePinExists(worktreePath)) {
    return {
      ok: true,
      worktreePath,
      pm: detectWorktreePm(worktreePath),
      skippedInstall: true,
      pinRel: OUTER_VISIBLE_RUNTIME_PIN_REL,
    };
  }

  if (seams.requirePinOnly) {
    return {
      ok: false,
      code: "pin-missing",
      message:
        `linked-worktree prep refused: outer-visible pin missing at ` +
        `${OUTER_VISIBLE_RUNTIME_PIN_REL} (requirePinOnly)`,
    };
  }

  const reconstitute = seams.reconstitute ?? reconstituteLinkedWorktreeDeposit;
  const pinned = worktreeHasRuntimePin(worktreePath);
  const pkg = readPackageJson(worktreePath);

  if (pinned) {
    const pm = installWorktreePackages(worktreePath, { runner: seams.runner });
    if (!pm.ok) {
      return { ok: false, code: "pm-failed", message: pm.message };
    }
  } else {
    const deposit = reconstitute(worktreePath, { preferPrimaryCore: true });
    if (deposit.status === "refused") {
      return {
        ok: false,
        code: "deposit-refused",
        message: `linked-worktree prep deposit refused: ${deposit.message}`,
      };
    }
    if (pkg !== null) {
      // Unpinned consumer with package.json: install and require outer-visible pin.
      const pm = installWorktreePackages(worktreePath, { runner: seams.runner });
      if (!pm.ok) {
        return { ok: false, code: "pm-failed", message: pm.message };
      }
    } else {
      // No package.json: deposit-only / fixture path — not Codex pin handoff.
      return {
        ok: true,
        worktreePath,
        pm: null,
        skippedInstall: true,
        pinRel: OUTER_VISIBLE_RUNTIME_PIN_REL,
      };
    }
  }

  if (!outerVisibleRuntimePinExists(worktreePath)) {
    return {
      ok: false,
      code: "pin-missing",
      message:
        `linked-worktree prep finished but outer-visible pin missing at ` +
        `${OUTER_VISIBLE_RUNTIME_PIN_REL}; not claiming readiness`,
    };
  }

  return {
    ok: true,
    worktreePath,
    pm: detectWorktreePm(worktreePath),
    skippedInstall: false,
    pinRel: OUTER_VISIBLE_RUNTIME_PIN_REL,
  };
}
