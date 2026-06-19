import { EXIT_OK, EXIT_VIOLATION } from "../release/constants.js";
import { editReleasePublish, viewRelease } from "./gh-api.js";
import type { PublishConfig, ReleasePublishSeams } from "./types.js";

export function emit(label: string, status: string): void {
  process.stderr.write(`[publish] ${label}... ${status}\n`);
}

export function runPublish(config: PublishConfig, seams: ReleasePublishSeams = {}): number {
  const { version, repo, dryRun } = config;
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

  process.stderr.write(`Release ${tag} published successfully on ${repo}.\n`);
  return EXIT_OK;
}
