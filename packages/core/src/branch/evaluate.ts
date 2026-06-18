import { disclosureLine } from "../policy/disclosure.js";
import { ENV_BYPASS, type PolicyResult, resolvePolicy } from "../policy/resolve.js";
import { type BranchState, currentBranch, GitNotFoundError } from "./git.js";

export const DEFAULT_BRANCHES = new Set(["master", "main"]);

/** When the setup-interview is mid-flight on the default branch. */
export const ENV_SETUP_EXEMPTION = "DEFT_SETUP_INTERVIEW";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Result of branch-protection evaluation; mirrors Python `(exit_code, message)`. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
}

export interface EvaluateOptions {
  /** Skip live git lookup when provided (unit tests). */
  readonly branchOverride?: BranchState;
  /** Simulate git-not-found (unit tests). */
  readonly gitNotFound?: boolean;
  readonly defaultBranches?: ReadonlySet<string>;
  readonly allowMissingProjectDefinition?: boolean;
}

function setupExemptionActive(): boolean {
  const raw = process.env[ENV_SETUP_EXEMPTION] ?? "";
  return TRUTHY.has(raw.trim().toLowerCase());
}

function isDefaultBranch(name: string, defaultBranches: ReadonlySet<string>): boolean {
  const lowered = name.toLowerCase();
  for (const branch of defaultBranches) {
    if (branch.toLowerCase() === lowered) {
      return true;
    }
  }
  return false;
}

function buildBlockMessage(branch: string, result: PolicyResult): string {
  const parts = [
    "❌ deft branch-protection: refusing to commit/push directly to the " +
      `default branch '${branch}' (#747).`,
    "",
    `  Source: policy=${result.source}`,
  ];
  if (result.error !== null) {
    parts.push(`  Error: ${result.error}`);
  }
  if (result.deprecationWarning !== null) {
    parts.push(`  Note: ${result.deprecationWarning}`);
  }
  parts.push(
    "",
    "  How to proceed:",
    "    • Create a feature branch:  git switch -c feat/<name>",
    "    • Or opt out via the typed surface:",
    "        task policy:allow-direct-commits -- --confirm",
    `    • Or set the emergency-escape env-var:  ${ENV_BYPASS}=1`,
    "",
    "  See README.md (Branch policy) and skills/deft-directive-setup/",
    "  Phase 2 Step 9 (capability-cost disclosure).",
  );
  return parts.join("\n");
}

/**
 * Pure evaluator — returns exit code + human message. Faithful to
 * `scripts/preflight_branch.evaluate`.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const defaultBranches = options.defaultBranches ?? DEFAULT_BRANCHES;
  const allowMissingProjectDefinition = options.allowMissingProjectDefinition ?? false;

  if (setupExemptionActive()) {
    return {
      exitCode: 0,
      message:
        "✓ deft branch-protection: setup-interview exemption active " +
        `(${ENV_SETUP_EXEMPTION}=1) -- proceeding without policy lookup.`,
    };
  }

  let branch: string;
  let detached: boolean;
  if (options.gitNotFound) {
    const exc = new GitNotFoundError("git executable not found on PATH");
    return {
      exitCode: 2,
      message:
        "❌ deft branch-protection: cannot determine current branch -- " +
        `${exc.message}\n` +
        "  Recovery: install git (https://git-scm.com/) or set DEFT_PYTHON " +
        "so the hook can dispatch correctly.",
    };
  }

  if (options.branchOverride !== undefined) {
    branch = options.branchOverride.branch;
    detached = options.branchOverride.detached;
  } else {
    try {
      const state = currentBranch(projectRoot);
      branch = state.branch;
      detached = state.detached;
    } catch (err: unknown) {
      if (err instanceof GitNotFoundError) {
        return {
          exitCode: 2,
          message:
            "❌ deft branch-protection: cannot determine current branch -- " +
            `${err.message}\n` +
            "  Recovery: install git (https://git-scm.com/) or set DEFT_PYTHON " +
            "so the hook can dispatch correctly.",
        };
      }
      throw err;
    }
  }

  if (detached) {
    return {
      exitCode: 0,
      message: "✓ deft branch-protection: detached HEAD detected -- nothing to gate.",
    };
  }

  if (!isDefaultBranch(branch, defaultBranches)) {
    return {
      exitCode: 0,
      message: `✓ deft branch-protection: feature branch '${branch}' -- proceeding.`,
    };
  }

  const result = resolvePolicy(projectRoot);
  if (result.allowDirectCommits) {
    return {
      exitCode: 0,
      message:
        `⚠ deft branch-protection: on default branch '${branch}', but ` +
        `policy allows it (${disclosureLine(result)}).`,
    };
  }

  if (result.source === "default-fail-closed" && result.error !== null) {
    if (allowMissingProjectDefinition && result.error.includes("not found")) {
      return {
        exitCode: 0,
        message:
          "✓ deft branch-protection: PROJECT-DEFINITION missing AND " +
          "--allow-missing-project-definition was passed -- treating as " +
          "bootstrap state (the setup interview will write the typed flag).",
      };
    }
    const recovery = result.error.includes("not found")
      ? "  Recovery: run `task setup` to create vbrief/" +
        "PROJECT-DEFINITION.vbrief.json, OR set the env-var bypass:\n" +
        `      ${ENV_BYPASS}=1\n` +
        "  Or pass --allow-missing-project-definition to this script " +
        "(setup-interview hook only)."
      : "  Recovery: fix the malformed PROJECT-DEFINITION (e.g. ensure " +
        "`plan.policy.allowDirectCommitsToMaster` is a boolean and " +
        "`plan` is an object), then re-run.";
    return {
      exitCode: 2,
      message:
        "❌ deft branch-protection: PROJECT-DEFINITION cannot be resolved.\n" +
        `  Detail: ${result.error}\n` +
        recovery,
    };
  }

  return {
    exitCode: 1,
    message: buildBlockMessage(branch, result),
  };
}
