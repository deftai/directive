/**
 * Closed-verb gate on the tag-push / npm-publish boundary (#3527).
 *
 * Reuses the draft-flip evaluator (`evaluateReleasePublishGate`) so the
 * distributing step carries the same authz tier. Does not delete or weaken
 * the later `release:publish` draft-flip check.
 *
 * Rehearsal exemption (#4000) is keyed to the throwaway slug prefix and
 * sentinel version the e2e owns. It does not teach the evaluator to honour
 * DEFT_RELEASE_E2E.
 */
import { closedVerbEnvBypassKey } from "../authz/closed-verb.js";
import type { ClosedVerbDecision } from "../authz/types.js";
import { DEFAULT_OWNER, REHEARSAL_VERSION, REPO_SLUG_PREFIX } from "../release-e2e/constants.js";
import { evaluateReleasePublishGate } from "../release-publish/pipeline.js";
import { EXIT_OK, EXIT_VIOLATION, TOTAL_STEPS } from "./constants.js";
import { runGit } from "./git.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

function emitGate(label: string, status: string): void {
  process.stderr.write(`[10/${TOTAL_STEPS}] ${label}... ${status}\n`);
}

export const TAG_PUSH_CLOSED_VERB = "release-publish" as const;

export const REHEARSAL_CLOSED_VERB_EXEMPT_STATUS = "OK (rehearsal-closed-verb-exempt)";

function normaliseSentinelVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed.startsWith("v") || trimmed.startsWith("V")) return trimmed.slice(1);
  return trimmed;
}

/**
 * True only for the throwaway rehearsal identity: owner DEFAULT_OWNER, slug
 * prefix, AND sentinel version. Production deftai/directive cannot satisfy
 * the conjunction even when DEFT_RELEASE_E2E=1. A prefix-matching slug under
 * another owner is not rehearsal-owned.
 */
export function githubOwnerRepoFromRemoteUrl(url: string): string | null {
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(
      url.trim(),
    );
  if (!match?.groups) return null;
  return `${match.groups.owner}/${match.groups.repo}`;
}

function originOwnerRepo(projectRoot: string, seams: ReleaseSeams): string | null {
  const result = runGit(projectRoot, ["remote", "get-url", "origin"], seams);
  if (result.status !== 0) return null;
  return githubOwnerRepoFromRemoteUrl(result.stdout);
}

export function isRehearsalClosedVerbExempt(repo: string, version: string): boolean {
  const trimmed = repo.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return false;
  const owner = trimmed.slice(0, slash);
  const slug = trimmed.slice(slash + 1);
  if (owner.toLowerCase() !== DEFAULT_OWNER.toLowerCase()) return false;
  if (!slug.startsWith(REPO_SLUG_PREFIX)) return false;
  return normaliseSentinelVersion(version) === REHEARSAL_VERSION;
}

export function evaluateReleaseTagPushGate(
  version: string,
  projectRoot: string,
  seams: ReleaseSeams,
  repo: string,
): ClosedVerbDecision {
  return evaluateReleasePublishGate(version, projectRoot, {
    grants: seams.closedVerbGrants,
    env: seams.closedVerbEnv,
    repo,
  });
}

/**
 * Fail closed before git tag + atomic tag push when skipTag is false.
 * Dry-run and `--skip-tag` do not require a grant (no npm distribution).
 * Rehearsal throwaway slug + sentinel version may tag without a grant (#4000);
 * that path still tags and pushes. Returns EXIT_OK to continue, EXIT_VIOLATION
 * to halt. Never spends the grant — draft-flip `release:publish`
 * still owns markGrantUsed (#1095).
 */
export function assertTagPushClosedVerb(config: ReleaseConfig, seams: ReleaseSeams): number {
  if (config.skipTag) {
    return EXIT_OK;
  }
  const tag = `v${config.version}`;
  const label = `Closed-verb gate ${TAG_PUSH_CLOSED_VERB} ${tag} (tag-push / npm-publish)`;
  if (config.dryRun) {
    emitGate(
      label,
      "DRYRUN (would require human-origin grant or DEFT_ALLOW_RELEASE_PUBLISH=1 before tag push)",
    );
    return EXIT_OK;
  }
  if (isRehearsalClosedVerbExempt(config.repo, config.version)) {
    const originRepo = originOwnerRepo(config.projectRoot, seams);
    if (
      originRepo !== null &&
      originRepo.toLowerCase() === config.repo.toLowerCase() &&
      isRehearsalClosedVerbExempt(originRepo, config.version)
    ) {
      emitGate(label, REHEARSAL_CLOSED_VERB_EXEMPT_STATUS);
      return EXIT_OK;
    }
  }
  const gate = evaluateReleaseTagPushGate(config.version, config.projectRoot, seams, config.repo);
  if (!gate.allowed) {
    const bypassKey =
      gate.envBypassKey ??
      closedVerbEnvBypassKey(TAG_PUSH_CLOSED_VERB, config.projectRoot) ??
      "DEFT_ALLOW_RELEASE_PUBLISH";
    emitGate(label, `FAIL (${gate.code}: ${gate.reason})`);
    process.stderr.write(
      `[release] denied code=${gate.code} — set ${bypassKey}=1 or ` +
        `mint \`deft authz:grant -- --template ${TAG_PUSH_CLOSED_VERB} --target ${config.version}\`\n`,
    );
    return EXIT_VIOLATION;
  }
  emitGate(
    label,
    gate.code === "closed-verb-allow" && gate.humanApprovalRef !== null
      ? `OK (${gate.code} grant=${gate.humanApprovalRef})`
      : `OK (${gate.code})`,
  );
  return EXIT_OK;
}
