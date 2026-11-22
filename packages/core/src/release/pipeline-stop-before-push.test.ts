import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseLine } from "../changelog/release-line.js";
import { EXIT_OK } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { paidSkipCiLedgerSeam, seedReleaseProjectDir } from "./pipeline-fixture.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const V = "0.106.0";

function config(projectRoot: string): ReleaseConfig {
  return {
    version: V,
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot,
    dryRun: false,
    skipTag: false,
    skipRelease: false,
    allowDirty: false,
    draft: true,
    skipCi: true,
    skipBuild: true,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: 716,
    stopBeforePush: true,
  };
}

function recording(): ReleaseSeams & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    validateReleaseInputs: passReleaseInputs,
    probeSkipCiIncidentLedger: paidSkipCiLedgerSeam,
    whichGh: () => "gh",
    spawnText: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("--show-current"))
        return { status: 0, stdout: `release/v${V}\n`, stderr: "" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "abc123\n", stderr: "" };
      // Staged changes exist, so Step 9 commits.
      if (args.includes("diff") && args.includes("--quiet")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
    checkVbriefLifecycleSync: () => [true, 0, ""],
    runBuild: () => [true, "ok"],
    todayIso: () => "2026-11-22",
    closedVerbEnv: {},
    closedVerbGrants: [],
  };
}

describe("release pipeline stopBeforePush (#6876 local cut)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("commits the release artifacts (Steps 1 to 9) and returns before any push, PR or tag", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recording();
    expect(runPipeline(config(projectRoot), seams)).toBe(EXIT_OK);
    expect(seams.calls.some((c) => c.includes("commit"))).toBe(true);
    expect(seams.calls.some((c) => c.includes("push"))).toBe(false);
    expect(seams.calls.some((c) => c[0] === "gh" && c.includes("create"))).toBe(false);
    expect(seams.calls.some((c) => c.includes("tag") && c.includes("-a"))).toBe(false);
    expect(readFileSync(join(projectRoot, "CHANGELOG.md"), "utf8")).toContain(releaseLine(V));
    const printed = err.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain(`Release v${V} local cut complete (Steps 1 to 9; nothing pushed).`);
  });

  it("leaves the release PR path unchanged when the field is absent", () => {
    const projectRoot = seedReleaseProjectDir();
    dirs.push(projectRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seams = recording();
    const { stopBeforePush: _drop, ...rest } = config(projectRoot);
    expect(runPipeline({ ...rest, stopBeforePush: false }, seams)).toBe(EXIT_OK);
    expect(seams.calls.some((c) => c.includes("push"))).toBe(true);
  });
});
