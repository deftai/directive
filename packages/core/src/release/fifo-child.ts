/* v8 ignore file -- spawned FIFO fixture helper (#4318) */
/**
 * Bounded child for FIFO CHANGELOG fixtures (#4318). Do not import from tests
 * in-process — spawn this file so a guard regression cannot hang the suite.
 */
import { runPipeline } from "./pipeline.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const projectRoot = process.argv[2] ?? "";
const mode = process.argv[3] ?? "skip-ci";

const config: ReleaseConfig = {
  version: "0.21.0",
  repo: "deftai/directive",
  baseBranch: "master",
  projectRoot,
  dryRun: mode === "dry-run",
  skipTag: true,
  skipRelease: true,
  allowDirty: true,
  draft: true,
  skipCi: mode !== "ci",
  skipBuild: true,
  summary: null,
  allowVbriefDrift: true,
  allowCoverageDebtIssue: null,
  allowSkipCiIssue: 716,
  breakGlass: true,
};

const seams: ReleaseSeams = {
  validateReleaseInputs: passReleaseInputs,
  todayIso: () => "2026-04-28",
  spawnText: (_c, a) => {
    if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
    if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
  checkTagAvailable: () => [true, "ok"],
};

const rc = runPipeline(config, seams);
process.stdout.write(`rc=${String(rc)}\n`);
