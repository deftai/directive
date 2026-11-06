import { EXIT_CONFIG_ERROR } from "../release/constants.js";
import { resolveProjectRoot, resolveRepo } from "../release/paths.js";
import { validateReleaseChannelVersion } from "../release/version.js";
import { formatMissingVersionError, formatReleasePublishHelp, parsePublishFlags } from "./flags.js";
import { runPromoteLatest, runPublish } from "./pipeline.js";
import type { PublishConfig, ReleasePublishSeams } from "./types.js";

export function cmdReleasePublish(
  args: readonly string[],
  seams: ReleasePublishSeams = {},
): number {
  const promoteLatest = args.includes("--promote-latest");
  const filtered = args.filter((a) => a !== "--promote-latest");
  const flags = parsePublishFlags(filtered);

  if (flags.help) {
    // Keep byte-stable RELEASE_PUBLISH_HELP as the first write (main.test contract);
    // append promote-latest discovery (#5852 Greptile P2) without widening constants.ts.
    process.stdout.write(formatReleasePublishHelp());
    process.stdout.write(
      "\nAlso: --promote-latest dispatches npm-publish promote-latest for stable X.Y.Z " +
        "(requires release-promote-latest grant or DEFT_ALLOW_RELEASE_PROMOTE_LATEST=1; " +
        "a release-publish grant does not authorize this). Publish accepts X.Y.Z or " +
        "publishable prereleases X.Y.Z-(alpha|beta|rc).N; promote requires stable X.Y.Z.\n",
    );
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
    validateReleaseChannelVersion(flags.version);
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

  if (promoteLatest) {
    return runPromoteLatest(config, seams);
  }
  return runPublish(config, seams);
}
