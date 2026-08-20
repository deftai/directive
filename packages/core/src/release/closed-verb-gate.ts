/**
 * Closed-verb gate on the tag-push / npm-publish boundary (#3527).
 *
 * Reuses the draft-flip evaluator (`evaluateReleasePublishGate`) so the
 * distributing step carries the same authz tier. Does not delete or weaken
 * the later `release:publish` draft-flip check.
 */
import { closedVerbEnvBypassKey } from "../authz/closed-verb.js";
import type { ClosedVerbDecision } from "../authz/types.js";
import { evaluateReleasePublishGate } from "../release-publish/pipeline.js";
import { EXIT_OK, EXIT_VIOLATION, TOTAL_STEPS } from "./constants.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

function emitGate(label: string, status: string): void {
  process.stderr.write(`[10/${TOTAL_STEPS}] ${label}... ${status}\n`);
}

export const TAG_PUSH_CLOSED_VERB = "release-publish" as const;

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
 * Returns EXIT_OK to continue, EXIT_VIOLATION to halt. Never spends the grant
 * — draft-flip `release:publish` still owns markGrantUsed (#1095).
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
    `OK (${gate.code}${gate.humanApprovalRef !== null ? ` grant=${gate.humanApprovalRef}` : ""})`,
  );
  return EXIT_OK;
}
