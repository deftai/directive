import { EXIT_CONFIG_ERROR } from "../release/constants.js";
import { resolveProjectRoot, resolveRepo } from "../release/paths.js";
import { validateVersion } from "../release/version.js";
import { formatMissingVersionError, formatReleasePublishHelp, parsePublishFlags } from "./flags.js";
import { runPublish } from "./pipeline.js";
import type { PublishConfig, ReleasePublishSeams } from "./types.js";

export function cmdReleasePublish(
  args: readonly string[],
  seams: ReleasePublishSeams = {},
): number {
  const flags = parsePublishFlags(args);

  if (flags.help) {
    process.stdout.write(formatReleasePublishHelp());
    return 0;
  }

  if (flags.unknown.length > 0) {
    process.stderr.write(
      `release_publish: error: unrecognized arguments: ${flags.unknown.join(" ")}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  if (flags.version === null) {
    process.stderr.write(formatMissingVersionError());
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

  const config: PublishConfig = {
    version: flags.version,
    repo,
    projectRoot,
    dryRun: flags.dryRun,
  };

  return runPublish(config, seams);
}
