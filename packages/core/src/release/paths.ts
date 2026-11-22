import { resolve } from "node:path";
import { resolveScriptDir } from "../doctor/paths.js";
import { DEFAULT_REPO } from "./constants.js";
import { spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";

/**
 * Project root for the release verbs: `--project-root`, then
 * `DEFT_PROJECT_ROOT`, else the current working directory (#6864). The
 * working directory is where `authz:grant` mints grants by default and what
 * `task release:*` passes, so the mint and the gate read one store. There is
 * no framework-root fallback: from the installed CLI that is the runtime
 * package, not the operator's repository.
 */
export function resolveProjectRoot(argRoot: string | null): string {
  if (argRoot !== null) {
    return resolve(argRoot);
  }
  const envRoot = process.env.DEFT_PROJECT_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }
  return resolve(process.cwd());
}

export function resolveRepo(
  argRepo: string | null,
  projectRoot: string,
  seams: Pick<ReleaseSeams, "spawnText"> = {},
): string {
  if (argRepo) {
    return argRepo;
  }
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn("git", ["-C", projectRoot, "remote", "get-url", "origin"], {
    timeoutMs: 10_000,
  });
  if (result.status !== 0) {
    return DEFAULT_REPO;
  }
  const url = result.stdout.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(
      url,
    );
  if (!match?.groups) {
    return DEFAULT_REPO;
  }
  return `${match.groups.owner}/${match.groups.repo}`;
}

export function resolveScriptsDir(frameworkRoot?: string): string {
  return resolveScriptDir(frameworkRoot);
}

export function todayIso(now: () => Date = () => new Date()): string {
  return now().toISOString().slice(0, 10);
}
