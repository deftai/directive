import { closedVerbEnvBypassKey, type EnvMap, evaluateClosedVerb } from "../authz/closed-verb.js";
import { listActiveHumanGrants, loadAuthzState, markGrantUsed } from "../authz/store.js";
import type { ClosedVerbDecision, HumanOriginGrant } from "../authz/types.js";
import { loadVerbClassification } from "../authz/verb-classification.js";
import { EXIT_OK, EXIT_VIOLATION } from "../release/constants.js";
import { editReleasePublish, viewRelease } from "./gh-api.js";
import type { PublishConfig, ReleasePublishSeams } from "./types.js";

export function emit(label: string, status: string): void {
  process.stderr.write(`[publish] ${label}... ${status}\n`);
}

/**
 * Fail-closed gate before draft→public (#1095 Wave 4).
 * Allow only DEFT_ALLOW_RELEASE_PUBLISH=1 or a matching human-origin grant.
 * Loads conventions/verb-classification.json from projectRoot when present.
 * Test seam: pass grants / env via optional overrides on seams when present.
 */
export function evaluateReleasePublishGate(
  version: string,
  projectRoot: string,
  options: {
    readonly grants?: readonly HumanOriginGrant[];
    readonly env?: EnvMap;
    readonly repo?: string | null;
  } = {},
): ClosedVerbDecision {
  // Production load of classification SoT (conventions/verb-classification.json).
  const classification = loadVerbClassification(projectRoot);
  const state = loadAuthzState(projectRoot);
  const grants = options.grants ?? listActiveHumanGrants(projectRoot, state);
  return evaluateClosedVerb({
    verb: "release-publish",
    target: version,
    grants,
    env: options.env ?? (process.env as EnvMap),
    projectRoot,
    repo: options.repo ?? null,
    classification,
  });
}

export function runPublish(config: PublishConfig, seams: ReleasePublishSeams = {}): number {
  const { version, repo, dryRun, projectRoot } = config;
  const tag = `v${version}`;

  const viewLabel = `View ${tag} on ${repo}`;
  if (dryRun) {
    emit(
      viewLabel,
      `DRYRUN (would run \`gh api --paginate repos/${repo}/releases?per_page=100\` and filter for tag_name == ${tag})`,
    );
    emit(
      `Edit ${tag}`,
      `DRYRUN (would run \`gh api -X PATCH repos/${repo}/releases/<id> -F draft=false\`)`,
    );
    return EXIT_OK;
  }

  const [state, payload, reason] = viewRelease(version, repo, seams);
  if (state === "not-found") {
    emit(viewLabel, `FAIL (release ${tag} not found on ${repo}: ${reason})`);
    return EXIT_VIOLATION;
  }
  if (state === "gh-error") {
    emit(viewLabel, `FAIL (${reason})`);
    return EXIT_VIOLATION;
  }
  if (state === "published") {
    emit(viewLabel, `NOOP (${tag} is already published; nothing to do)`);
    return EXIT_OK;
  }

  emit(viewLabel, `OK (draft found at ${payload?.url ?? "<no url>"})`);

  // Closed-verb gate: refuse draft→public without grant or env bypass (#1095).
  const gateSeams = seams as ReleasePublishSeams & {
    closedVerbGrants?: readonly HumanOriginGrant[];
    closedVerbEnv?: EnvMap;
  };
  const gate = evaluateReleasePublishGate(version, projectRoot, {
    grants: gateSeams.closedVerbGrants,
    env: gateSeams.closedVerbEnv,
    repo,
  });
  if (!gate.allowed) {
    const bypassKey =
      gate.envBypassKey ??
      closedVerbEnvBypassKey("release-publish", projectRoot) ??
      "DEFT_ALLOW_RELEASE_PUBLISH";
    emit(`Closed-verb gate release-publish ${tag}`, `FAIL (${gate.code}: ${gate.reason})`);
    process.stderr.write(
      `[publish] denied code=${gate.code} — set ${bypassKey}=1 or ` +
        `mint \`deft authz:grant -- --template release-publish --target ${version}\`\n`,
    );
    return EXIT_VIOLATION;
  }
  emit(
    `Closed-verb gate release-publish ${tag}`,
    `OK (${gate.code}${gate.humanApprovalRef !== null ? ` grant=${gate.humanApprovalRef}` : ""})`,
  );

  const editLabel = `Edit ${tag} (--draft=false)`;
  const [ok, editReason] = editReleasePublish(version, repo, payload?.id ?? undefined, seams);
  if (!ok) {
    emit(editLabel, `FAIL (${editReason})`);
    return EXIT_VIOLATION;
  }
  emit(editLabel, `OK (${editReason})`);

  const verifyLabel = `Verify ${tag} is published`;
  const [state2, , reason2] = viewRelease(version, repo, seams);
  if (state2 !== "published") {
    emit(
      verifyLabel,
      `FAIL (post-edit state is '${state2}'; expected 'published'; reason: ${reason2})`,
    );
    return EXIT_VIOLATION;
  }
  emit(verifyLabel, `OK (${tag} is now public)`);

  // Consume single-use grant after successful draft→public (#1095).
  if (gate.humanApprovalRef !== null && gate.code === "closed-verb-allow") {
    markGrantUsed(projectRoot, gate.humanApprovalRef);
  }

  process.stderr.write(`Release ${tag} published successfully on ${repo}.\n`);
  return EXIT_OK;
}
