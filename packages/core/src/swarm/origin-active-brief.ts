/**
 * Origin-resident active brief probe (#4714 R2 lite).
 * swarm:launch / finalize require the selected active path on fetched delivery tip.
 */
import type { runText } from "./subprocess.js";

export interface OriginActiveBriefResult {
  readonly present: boolean;
  readonly error: string | null;
}

/** True when `origin/<deliveryBranch>:<relPath>` exists as a blob. */
export function originActiveBriefPresent(
  projectRoot: string,
  deliveryBranch: string,
  relPath: string,
  runGit: typeof runText,
): OriginActiveBriefResult {
  const rel = relPath.replace(/\\/g, "/");
  const fetch = runGit(["git", "fetch", "origin", deliveryBranch], { cwd: projectRoot });
  if (fetch.returncode !== 0) {
    return {
      present: false,
      error:
        `git fetch origin ${deliveryBranch} failed: ` +
        `${fetch.stderr.trim() || fetch.stdout.trim()}`,
    };
  }
  const tip = `origin/${deliveryBranch}`;
  // Require a blob. `cat-file -e` also succeeds for trees, which would false-present
  // a directory path and then fail later on `git show` (#4714 SLizard P1).
  const probe = runGit(["git", "cat-file", "-t", `${tip}:${rel}`], { cwd: projectRoot });
  if (probe.returncode === 0 && probe.stdout.trim() === "blob") {
    return { present: true, error: null };
  }
  return {
    present: false,
    error:
      `protected delivery tip ${tip} is missing active brief ${rel}. ` +
      "Land a human-reviewed activation PR before swarm:launch / finalize (#4714 R2).",
  };
}
