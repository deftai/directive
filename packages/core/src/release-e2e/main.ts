import { resolveProjectRoot } from "../release/paths.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION, RELEASE_E2E_HELP } from "./constants.js";
import { emit, generateRepoSlug, parseE2EFlags } from "./flags.js";
import { destroyTempRepo, provisionTempRepo } from "./gh-ops.js";
import { runRehearsal } from "./rehearsal.js";
import type { E2EConfig, E2ESeams } from "./types.js";

export function runE2e(config: E2EConfig, seams: E2ESeams = {}): number {
  const slug = config.repoSlug ?? generateRepoSlug(seams);
  const owner = config.owner;

  if (config.dryRun) {
    emit("Provision temp repo", `DRYRUN (would run \`gh repo create --private ${owner}/${slug}\`)`);
    emit(
      "Rehearsal",
      "DRYRUN (would run pipeline-mirror rehearsal: clone -> push heads+tags -> task release -> verify draft + tag -> task release:rollback against temp repo)",
    );
    emit("Destroy temp repo", `DRYRUN (would run \`gh repo delete ${owner}/${slug} --yes\`)`);
    return EXIT_OK;
  }

  const [provisionOk, provisionReason] = provisionTempRepo(owner, slug, seams);
  if (!provisionOk) {
    emit(`Provision ${owner}/${slug}`, `FAIL (${provisionReason})`);
    return EXIT_VIOLATION;
  }
  emit(`Provision ${owner}/${slug}`, `OK (${provisionReason})`);

  let rehearsalRc = EXIT_OK;
  try {
    const [ok, reason] = runRehearsal(owner, slug, config.projectRoot, undefined, seams);
    if (ok) {
      emit("Rehearsal", `OK (${reason})`);
    } else {
      emit("Rehearsal", `FAIL (${reason})`);
      rehearsalRc = EXIT_VIOLATION;
    }
  } finally {
    if (config.keepRepo) {
      emit(
        `Destroy ${owner}/${slug}`,
        "SKIP (--keep-repo set; manual cleanup required: " +
          `gh repo delete ${owner}/${slug} --yes)`,
      );
    } else {
      const [destroyOk, destroyReason] = destroyTempRepo(owner, slug, seams);
      if (destroyOk) {
        emit(`Destroy ${owner}/${slug}`, `OK (${destroyReason})`);
      } else {
        emit(
          `Destroy ${owner}/${slug}`,
          `WARN (${destroyReason}); manual cleanup hint: gh repo delete ${owner}/${slug} --yes`,
        );
      }
    }
  }

  return rehearsalRc;
}

export function cmdReleaseE2e(args: readonly string[], seams: E2ESeams = {}): number {
  const flags = parseE2EFlags(args);

  if (flags.help) {
    process.stdout.write(RELEASE_E2E_HELP);
    return EXIT_OK;
  }

  if (flags.unknown.length > 0) {
    process.stderr.write(
      `release_e2e: error: unrecognized arguments: ${flags.unknown.join(" ")}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  if (!flags.owner) {
    process.stderr.write("Error: --owner must be a non-empty string.\n");
    return EXIT_CONFIG_ERROR;
  }

  const projectRoot = resolveProjectRoot(flags.projectRoot);

  const config: E2EConfig = {
    owner: flags.owner,
    projectRoot,
    dryRun: flags.dryRun,
    keepRepo: flags.keepRepo,
    repoSlug: null,
  };

  return runE2e(config, seams);
}
