import { DOUBLE_READ_SLEEP_SECONDS, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { ghReleaseDelete, ghReleaseExists } from "./gh.js";
import {
  gitDeleteLocalTag,
  gitDeleteRemoteTag,
  gitPushBase,
  gitRevertReleaseCommit,
  gitTagExistsLocal,
  gitTagExistsOrigin,
  resolveReleasePrepSha,
} from "./git.js";
import { computeThreshold, doubleReadDownloads, releaseAgeSeconds } from "./guard.js";
import type { GhReleasePayload, RollbackConfig, RollbackSeams } from "./types.js";

function defaultEmit(label: string, status: string): void {
  process.stderr.write(`[rollback] ${label}... ${status}\n`);
}

function emit(label: string, status: string, seams: RollbackSeams): void {
  (seams.emit ?? defaultEmit)(label, status);
}

export function detectState(
  config: RollbackConfig,
  seams: RollbackSeams = {},
): [string, GhReleasePayload | null, string] {
  const { projectRoot, version, repo } = config;

  const [state, payload, reason] = ghReleaseExists(version, repo, seams);
  if (state === "exists") {
    return ["released", payload, ""];
  }
  if (state === "error") {
    return ["error", null, reason];
  }

  const local = gitTagExistsLocal(projectRoot, version, seams);
  const remote = gitTagExistsOrigin(projectRoot, version, seams);
  if (remote) {
    return ["tag-pushed-no-release", null, ""];
  }
  if (local) {
    return ["local-only", null, ""];
  }
  return ["absent", null, ""];
}

function resolvePrepShaOrEmit(
  config: RollbackConfig,
  seams: RollbackSeams,
): [string, number | null] {
  const [sha, reason] = resolveReleasePrepSha(config.projectRoot, config.version, seams);
  if (!sha) {
    emit(`Resolve release-prep SHA for v${config.version}`, `FAIL (${reason})`, seams);
    return ["", EXIT_VIOLATION];
  }
  emit(`Resolve release-prep SHA for v${config.version}`, `OK (${sha})`, seams);
  return [sha, null];
}

export function unwindLocal(config: RollbackConfig, seams: RollbackSeams = {}): number {
  const { projectRoot, version } = config;
  if (config.dryRun) {
    emit(
      `Unwind local v${version}`,
      `DRYRUN (would resolve release-prep SHA + run ` +
        `\`git tag -d v${version}\` + \`git revert <sha> --no-edit\`)`,
      seams,
    );
    return EXIT_OK;
  }

  const [sha, refusal] = resolvePrepShaOrEmit(config, seams);
  if (refusal !== null) {
    return refusal;
  }

  const [ok, reason] = gitDeleteLocalTag(projectRoot, version, seams);
  if (!ok) {
    emit(`Delete local tag v${version}`, `FAIL (${reason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Delete local tag v${version}`, `OK (${reason})`, seams);

  const [revertOk, revertReason] = gitRevertReleaseCommit(projectRoot, sha, seams);
  if (!revertOk) {
    emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `FAIL (${revertReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `OK (${revertReason})`, seams);
  return EXIT_OK;
}

export function unwindTagPushedNoRelease(
  config: RollbackConfig,
  seams: RollbackSeams = {},
): number {
  const { projectRoot, version, baseBranch } = config;
  if (config.dryRun) {
    emit(
      `Unwind pushed tag v${version}`,
      `DRYRUN (would resolve release-prep SHA + run ` +
        `\`git push --delete origin v${version}\` + ` +
        `\`git tag -d v${version}\` + \`git revert <sha> --no-edit\` + ` +
        `\`git push origin ${baseBranch}\` (no force))`,
      seams,
    );
    return EXIT_OK;
  }

  const [sha, refusal] = resolvePrepShaOrEmit(config, seams);
  if (refusal !== null) {
    return refusal;
  }

  const [remoteOk, remoteReason] = gitDeleteRemoteTag(projectRoot, version, seams);
  if (!remoteOk) {
    emit(`Delete remote tag v${version}`, `FAIL (${remoteReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Delete remote tag v${version}`, `OK (${remoteReason})`, seams);

  if (gitTagExistsLocal(projectRoot, version, seams)) {
    const [localOk, localReason] = gitDeleteLocalTag(projectRoot, version, seams);
    if (!localOk) {
      emit(`Delete local tag v${version}`, `FAIL (${localReason})`, seams);
      return EXIT_VIOLATION;
    }
    emit(`Delete local tag v${version}`, `OK (${localReason})`, seams);
  }

  const [revertOk, revertReason] = gitRevertReleaseCommit(projectRoot, sha, seams);
  if (!revertOk) {
    emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `FAIL (${revertReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `OK (${revertReason})`, seams);

  const [pushOk, pushReason] = gitPushBase(projectRoot, baseBranch, seams);
  if (!pushOk) {
    emit(`Push ${baseBranch} to origin`, `FAIL (${pushReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Push ${baseBranch} to origin`, `OK (${pushReason})`, seams);
  return EXIT_OK;
}

export function unwindReleased(
  config: RollbackConfig,
  payload: GhReleasePayload,
  seams: RollbackSeams = {},
): number {
  const { projectRoot, version, repo } = config;

  const ageSeconds = releaseAgeSeconds(payload);
  const [threshold, thresholdReason] = computeThreshold(ageSeconds, {
    allowLowDownloads: config.allowLowDownloads,
    allowDataLoss: config.allowDataLoss,
    forceStrict0: config.forceStrict0,
  });
  emit(`Compute guard threshold (age=${ageSeconds}s)`, thresholdReason, seams);

  if (threshold === null) {
    emit(
      "Guard refusal",
      "FAIL (release > 30 min old without --allow-data-loss; " +
        "see hot-fix-path recommendation in script docstring)",
      seams,
    );
    return EXIT_VIOLATION;
  }

  if (config.dryRun) {
    emit(
      `Double-read download_count (threshold=${threshold})`,
      "DRYRUN (would read download_count, sleep 5s, re-read)",
      seams,
    );
    emit(
      `Delete release v${version}`,
      `DRYRUN (would run \`gh release delete v${version} --yes --cleanup-tag\`)`,
      seams,
    );
    emit(
      `Revert release-prep commit for v${version}`,
      `DRYRUN (would resolve release-prep SHA + run ` +
        `\`git revert <sha> --no-edit\` + \`git push origin ` +
        `${config.baseBranch}\` (no force))`,
      seams,
    );
    return EXIT_OK;
  }

  const [sha, refusal] = resolvePrepShaOrEmit(config, seams);
  if (refusal !== null) {
    return refusal;
  }

  const sleepSeconds = config.skipSleep ? 0 : DOUBLE_READ_SLEEP_SECONDS;
  const [ok, firstCount, secondCount, reason] = doubleReadDownloads(
    version,
    repo,
    { sleepSeconds },
    seams,
  );
  emit(
    `Double-read download_count (threshold=${threshold})`,
    `first=${firstCount}, second=${secondCount}, ok=${ok}; reason: ${reason || "agreed"}`,
    seams,
  );
  if (!ok) {
    return EXIT_VIOLATION;
  }
  if (Math.max(firstCount, secondCount) > threshold) {
    emit(
      "Guard refusal",
      `FAIL (download_count=${Math.max(firstCount, secondCount)} > ` +
        `threshold=${threshold}; pass --allow-low-downloads or ` +
        "--allow-data-loss to override)",
      seams,
    );
    return EXIT_VIOLATION;
  }

  const [deleteOk, deleteReason] = ghReleaseDelete(version, repo, seams);
  if (!deleteOk) {
    emit(`Delete release v${version}`, `FAIL (${deleteReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Delete release v${version}`, `OK (${deleteReason})`, seams);

  if (gitTagExistsLocal(projectRoot, version, seams)) {
    const [localOk, localReason] = gitDeleteLocalTag(projectRoot, version, seams);
    if (!localOk) {
      emit(`Delete local tag v${version}`, `WARN (${localReason})`, seams);
    } else {
      emit(`Delete local tag v${version}`, `OK (${localReason})`, seams);
    }
  }

  const [revertOk, revertReason] = gitRevertReleaseCommit(projectRoot, sha, seams);
  if (!revertOk) {
    emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `FAIL (${revertReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Revert release-prep commit ${sha.slice(0, 12)}`, `OK (${revertReason})`, seams);

  const [pushOk, pushReason] = gitPushBase(projectRoot, config.baseBranch, seams);
  if (!pushOk) {
    emit(`Push ${config.baseBranch} to origin`, `FAIL (${pushReason})`, seams);
    return EXIT_VIOLATION;
  }
  emit(`Push ${config.baseBranch} to origin`, `OK (${pushReason})`, seams);
  return EXIT_OK;
}

export function runRollback(config: RollbackConfig, seams: RollbackSeams = {}): number {
  if (config.dryRun) {
    emit(
      "Detect post-release state",
      `DRYRUN (would probe gh release view v${config.version} + git tag -l + git ls-remote)`,
      seams,
    );
    const [state, payload, reason] = detectState(config, seams);
    emit("State (dry-run probe)", `${state} (${reason || "no reason"})`, seams);
    if (state === "absent") {
      emit("Rollback", "DRYRUN (no-op; nothing to unwind)", seams);
      return EXIT_OK;
    }
    if (state === "local-only") {
      return unwindLocal(config, seams);
    }
    if (state === "tag-pushed-no-release") {
      return unwindTagPushedNoRelease(config, seams);
    }
    if (state === "released" && payload !== null) {
      return unwindReleased(config, payload, seams);
    }
    if (state === "error") {
      emit("State probe", `FAIL (${reason})`, seams);
      return EXIT_VIOLATION;
    }
    return EXIT_OK;
  }

  const [state, payload, reason] = detectState(config, seams);
  emit("Detect post-release state", `${state} (${reason || "ok"})`, seams);
  if (state === "absent") {
    emit("Rollback", "NOOP (no local tag, no remote tag, no release)", seams);
    return EXIT_OK;
  }
  if (state === "error") {
    return EXIT_VIOLATION;
  }
  if (state === "local-only") {
    return unwindLocal(config, seams);
  }
  if (state === "tag-pushed-no-release") {
    return unwindTagPushedNoRelease(config, seams);
  }
  if (state === "released") {
    if (payload === null) {
      emit("Rollback", "FAIL (released state without payload)", seams);
      return EXIT_VIOLATION;
    }
    return unwindReleased(config, payload, seams);
  }
  emit("Rollback", `FAIL (unknown state '${state}')`, seams);
  return EXIT_VIOLATION;
}
