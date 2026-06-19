import { resolveProjectRoot, resolveRepo } from "../release/paths.js";
import { validateVersion } from "../release/version.js";
import { EXIT_CONFIG_ERROR, ROLLBACK_USAGE_SHORT } from "./constants.js";
import { formatRollbackHelp, parseRollbackFlags } from "./flags.js";
import { runRollback } from "./pipeline.js";
import type { RollbackConfig, RollbackSeams } from "./types.js";

export function cmdRollback(args: readonly string[], seams: RollbackSeams = {}): number {
  const flags = parseRollbackFlags(args);

  if (flags.help) {
    process.stdout.write(formatRollbackHelp());
    return 0;
  }

  if (flags.parseError) {
    process.stderr.write(ROLLBACK_USAGE_SHORT);
    process.stderr.write(`release_rollback: error: ${flags.parseError}\n`);
    return EXIT_CONFIG_ERROR;
  }

  if (flags.unknown.length > 0) {
    process.stderr.write(
      `release_rollback: error: unrecognized arguments: ${flags.unknown.join(" ")}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  if (flags.version === null) {
    process.stderr.write(
      "release_rollback: error: the following arguments are required: version\n",
    );
    return EXIT_CONFIG_ERROR;
  }

  try {
    validateVersion(flags.version);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const projectRoot = resolveProjectRoot(flags.projectRoot);
  const repo = resolveRepo(flags.repo, projectRoot, seams);

  if (flags.allowLowDownloads < 0) {
    process.stderr.write(
      `Error: --allow-low-downloads must be >= 0 (got ${flags.allowLowDownloads}).\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  const config: RollbackConfig = {
    version: flags.version,
    repo,
    baseBranch: flags.baseBranch,
    projectRoot,
    dryRun: flags.dryRun,
    allowLowDownloads: flags.allowLowDownloads,
    allowDataLoss: flags.allowDataLoss,
    forceStrict0: flags.forceStrict0,
  };

  return runRollback(config, seams);
}
