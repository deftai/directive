import { EXIT_CONFIG_ERROR } from "./constants.js";
import { formatReleaseHelp, parseReleaseFlags } from "./flags.js";
import { resolveProjectRoot, resolveRepo } from "./paths.js";
import { runPipeline } from "./pipeline.js";
import { validateSkipCiIncident } from "./skip-ci-incident.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { validateVersion } from "./version.js";

export function cmdRelease(args: readonly string[], seams: ReleaseSeams = {}): number {
  const flags = parseReleaseFlags(args);

  if (flags.help) {
    process.stdout.write(formatReleaseHelp());
    return 0;
  }

  if (flags.unknown.length > 0) {
    process.stderr.write(`release: error: unrecognized arguments: ${flags.unknown.join(" ")}\n`);
    return EXIT_CONFIG_ERROR;
  }

  if (flags.version === null) {
    process.stderr.write("release: error: the following arguments are required: version\n");
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

  const skipCiGate = validateSkipCiIncident(flags.skipCi, flags.allowSkipCiIssue, process.env);
  if (skipCiGate.kind === "invalid") {
    process.stderr.write(`release: error: ${skipCiGate.reason}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const config: ReleaseConfig = {
    version: flags.version,
    repo,
    baseBranch: flags.baseBranch,
    projectRoot,
    dryRun: flags.dryRun,
    skipTag: flags.skipTag,
    skipRelease: flags.skipRelease,
    allowDirty: flags.allowDirty,
    draft: flags.draft,
    skipCi: flags.skipCi,
    skipBuild: flags.skipBuild,
    summary: flags.summary,
    allowVbriefDrift: flags.allowVbriefDrift,
    allowCoverageDebtIssue: flags.allowCoverageDebtIssue,
    allowSkipCiIssue: flags.allowSkipCiIssue,
  };

  return runPipeline(config, seams);
}
