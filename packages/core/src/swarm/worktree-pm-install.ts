/**
 * Swarm worktree package install (AC14.25).
 * After `git worktree add`, materialize node_modules via the project PM.
 * Failure must prevent claiming readiness.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type WorktreePm = "npm" | "pnpm";

export type WorktreePmInstallResult =
  | { readonly ok: true; readonly pm: WorktreePm; readonly skipped: boolean; readonly reason?: string }
  | { readonly ok: false; readonly pm: WorktreePm | null; readonly message: string };

export type WorktreePmRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => { readonly status: number | null; readonly stderr: string; readonly stdout: string };

function defaultRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; stderr: string; stdout: string } {
  const proc = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
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

/**
 * Run project PM install in a newly created worktree (AC14.25).
 * Skips when there is no package.json. Fails closed on PM error when a
 * runtime pin is present (configured project).
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
  const args = pm === "pnpm" ? (["install", "--frozen-lockfile"] as const) : (["install"] as const);
  // Prefer frozen when lockfile exists for npm
  const npmArgs =
    pm === "npm" && existsSync(join(worktreePath, "package-lock.json"))
      ? (["ci"] as const)
      : args;
  const useArgs = pm === "npm" ? npmArgs : args;
  const proc = runner(pm, useArgs, worktreePath);
  if (proc.status !== 0) {
    // Retry npm ci failure with npm install (lockfile drift across worktrees is rare)
    if (pm === "npm" && useArgs[0] === "ci") {
      const retry = runner(pm, ["install"], worktreePath);
      if (retry.status === 0) {
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
  // Configured projects must end with a local runtime after install.
  if (hasRuntimePin(pkg)) {
    const runtimeDir = join(worktreePath, "node_modules", "@deftai", "directive-runtime");
    if (!existsSync(runtimeDir)) {
      return {
        ok: false,
        pm,
        message:
          "worktree PM install finished but @deftai/directive-runtime is missing under node_modules; not claiming readiness",
      };
    }
  }
  return { ok: true, pm, skipped: false };
}

/** True when the worktree pin is the new runtime package (skip .deft/core copy). */
export function worktreeHasRuntimePin(worktreePath: string): boolean {
  const pkg = readPackageJson(worktreePath);
  return pkg !== null && hasRuntimePin(pkg);
}
