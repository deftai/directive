import { resolveProjectRoot } from "../release/paths.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION, RELEASE_E2E_HELP } from "./constants.js";
import { emit, generateRepoSlug, parseE2EFlags } from "./flags.js";
import { destroyTempRepo, provisionTempRepo } from "./gh-ops.js";
import { type LegacyBridgeLegSeams, runLegacyBridgeLeg } from "./legacy-bridge-leg.js";
import { runRehearsal } from "./rehearsal.js";
import type { E2EConfig, E2ESeams } from "./types.js";

export function runE2e(config: E2EConfig, seams: E2ESeams & LegacyBridgeLegSeams = {}): number {
  const slug = config.repoSlug ?? generateRepoSlug(seams);
  const owner = config.owner;

  if (config.dryRun) {
    emit("Provision temp repo", `DRYRUN (would run \`gh repo create --private ${owner}/${slug}\`)`);
    const npmPlan = config.skipNpm
      ? "task release:rollback"
      : "npm publish dry-run (4 packages) -> task release:rollback";
    emit(
      "Rehearsal",
      "DRYRUN (would run pipeline-mirror rehearsal: clone -> push heads+tags -> task release -> " +
        `verify draft + tag -> ${npmPlan} against temp repo)`,
    );
    if (config.legacyBridge) {
      emit(
        "Legacy-bridge leg",
        "DRYRUN (would run the pinned legacy -> bridge -> npm-hybrid migration leg; reads the " +
          "Tier-0 SoT lastGoInstaller(), pending-pin while null)",
      );
    }
    emit("Destroy temp repo", `DRYRUN (would run \`gh repo delete ${owner}/${slug} --yes\`)`);
    return EXIT_OK;
  }

  // Opt-in #1912 leg: local + self-contained (no temp GitHub repo), so run it
  // independently of the pipeline-mirror rehearsal and fold its result into rc.
  let legacyBridgeRc = EXIT_OK;
  if (config.legacyBridge) {
    const [ok, reason] = runLegacyBridgeLeg(config.projectRoot, seams);
    emit("Legacy-bridge leg", `${ok ? "OK" : "FAIL"} (${reason})`);
    if (!ok) {
      legacyBridgeRc = EXIT_VIOLATION;
    }
  }

  const [provisionOk, provisionReason] = provisionTempRepo(owner, slug, seams);
  if (!provisionOk) {
    emit(`Provision ${owner}/${slug}`, `FAIL (${provisionReason})`);
    return EXIT_VIOLATION;
  }
  emit(`Provision ${owner}/${slug}`, `OK (${provisionReason})`);

  let rehearsalRc = EXIT_OK;
  try {
    const [ok, reason] = runRehearsal(
      owner,
      slug,
      config.projectRoot,
      undefined,
      seams,
      config.skipNpm,
    );
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

  return rehearsalRc !== EXIT_OK ? rehearsalRc : legacyBridgeRc;
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
    skipNpm: flags.skipNpm,
    legacyBridge: flags.legacyBridge,
    repoSlug: null,
  };

  return runE2e(config, seams);
}
