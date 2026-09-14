import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveCliCheckResult, CliCandidate } from "../session/active-cli.js";
import {
  buildCliDriftReport,
  CLI_DRIFT_POLL_TIMEOUT_MS,
  classifyRegistryVisibility,
  cmdReleaseWaitNpm,
  defaultCliDriftSleepMs,
  emitCliDriftReportBestEffort,
  formatCliDriftReport,
  npmViewArgs,
  phase7CliDriftPollTimeoutMs,
  pollWorkspacePackages,
  remediationCommand,
  runPhase7NpmWait,
  shouldSkipRegistryPoll,
  versionsListContains,
  WORKSPACE_PACKAGES,
  type WorkspacePackageName,
  type WorkspacePackageProbe,
} from "./cli-drift-report.js";
import { RELEASE_E2E_ENV } from "./skip-ci-incident.js";

function probe(
  name: WorkspacePackageName,
  visible: boolean,
  version: string | null = visible ? "0.107.0" : null,
): WorkspacePackageProbe {
  return { name, visible, version };
}

function sleepClock(): { nowMs: () => number; sleepMs: (ms: number) => void } {
  let t = 0;
  return {
    nowMs: () => t,
    sleepMs: (ms: number) => {
      t += ms;
    },
  };
}

function matchingCli(version: string): ActiveCliCheckResult {
  const active: CliCandidate = {
    command: "deft",
    path: "C:\\npm\\deft.cmd",
    version,
    precedence: 0,
    versionSource: "exec",
  };
  return {
    ok: true,
    code: 0,
    active,
    candidates: [active],
    targetVersion: version,
    message: `active CLI engine ${version} matches target ${version}`,
    lines: [],
  };
}

function staleCli(local: string, target: string): ActiveCliCheckResult {
  const active: CliCandidate = {
    command: "deft",
    path: "C:\\npm\\deft.cmd",
    version: local,
    precedence: 0,
    versionSource: "exec",
  };
  return {
    ok: false,
    code: 1,
    active,
    candidates: [active],
    targetVersion: target,
    message: `shell-active deft is engine ${local}`,
    lines: [],
  };
}

describe("cli drift report (#3753)", () => {
  it("polls all four workspace packages, never one", () => {
    expect(WORKSPACE_PACKAGES).toEqual([
      "@deftai/directive-types",
      "@deftai/directive-core",
      "@deftai/directive-content",
      "@deftai/directive",
    ]);
  });

  it("bypasses the npm metadata cache on every view", () => {
    const args = npmViewArgs("@deftai/directive-core", "0.107.0");
    expect(args).toContain("--prefer-online");
    expect(args).toContain("versions");
    expect(args).toContain("--json");
    expect(args).toContain("@deftai/directive-core");
    expect(args.join(" ")).not.toContain("@deftai/directive-core@0.107.0");
    expect(remediationCommand("0.107.0")).toBe(
      "npm i -g @deftai/directive@0.107.0 --prefer-online",
    );
  });

  it("classifies partial visibility as still-propagating", () => {
    const probes = [
      probe("@deftai/directive-types", true),
      probe("@deftai/directive-core", false),
      probe("@deftai/directive-content", true),
      probe("@deftai/directive", true),
    ];
    expect(classifyRegistryVisibility({ probes, waitExhausted: true, skipped: false })).toBe(
      "still-propagating",
    );
  });

  it("classifies zero visibility after a wait as publish-incomplete", () => {
    const probes = WORKSPACE_PACKAGES.map((name) => probe(name, false));
    expect(classifyRegistryVisibility({ probes, waitExhausted: true, skipped: false })).toBe(
      "publish-incomplete",
    );
    expect(classifyRegistryVisibility({ probes, waitExhausted: false, skipped: false })).toBe(
      "still-propagating",
    );
  });

  it("polls until all four resolve, then stops", () => {
    let calls = 0;
    const { probes, waitExhausted } = pollWorkspacePackages("0.107.0", {
      timeoutMs: 90_000,
      intervalMs: 30_000,
      ...sleepClock(),
      viewPackage: (name) => {
        calls += 1;
        // First pass: core missing. Second pass: all visible.
        const coreMissing = calls <= WORKSPACE_PACKAGES.length;
        if (name === "@deftai/directive-core" && coreMissing) {
          return probe(name, false);
        }
        return probe(name, true);
      },
    });
    expect(waitExhausted).toBe(false);
    expect(probes.every((p) => p.visible)).toBe(true);
    expect(calls).toBe(WORKSPACE_PACKAGES.length * 2);
  });

  it("reports local-vs-released via the injected active-CLI check", () => {
    const report = buildCliDriftReport("0.107.0", {
      skipRegistryPoll: false,
      pollTimeoutMs: 0,
      checkActiveCli: () => staleCli("0.95.0", "0.107.0"),
      viewPackage: (name) => probe(name, true),
    });
    expect(report.match).toBe(false);
    expect(report.localVersion).toBe("0.95.0");
    expect(report.registry).toBe("all-visible");
    expect(report.remediation).toContain("--prefer-online");
    expect(report.lines.join("\n")).toContain("match: no");
    expect(report.lines.join("\n")).toContain("does not run npm i -g");
  });

  it("reports a match when the active CLI equals the cut", () => {
    const report = buildCliDriftReport("0.107.0", {
      skipRegistryPoll: true,
      checkActiveCli: () => matchingCli("0.107.0"),
    });
    expect(report.match).toBe(true);
    expect(report.registry).toBe("skipped");
    expect(report.lines.join("\n")).toContain("match: yes");
    expect(report.lines.join("\n")).toContain("npm i -g @deftai/directive@0.107.0 --prefer-online");
  });

  it("skips the registry poll for dry-run, skip-tag, rehearsal, e2e, and CI", () => {
    expect(shouldSkipRegistryPoll({ dryRun: true, skipTag: false, version: "0.107.0" })).toBe(true);
    expect(shouldSkipRegistryPoll({ dryRun: false, skipTag: true, version: "0.107.0" })).toBe(true);
    expect(shouldSkipRegistryPoll({ dryRun: false, skipTag: false, version: "0.0.1" })).toBe(true);
    expect(
      shouldSkipRegistryPoll(
        { dryRun: false, skipTag: false, version: "0.107.0" },
        {
          [RELEASE_E2E_ENV]: "1",
        },
      ),
    ).toBe(true);
    expect(
      shouldSkipRegistryPoll(
        { dryRun: false, skipTag: false, version: "0.107.0" },
        {
          CI: "true",
        },
      ),
    ).toBe(true);
    expect(shouldSkipRegistryPoll({ dryRun: false, skipTag: false, version: "0.107.0" }, {})).toBe(
      false,
    );
    expect(
      shouldSkipRegistryPoll(
        { dryRun: false, skipTag: false, version: "0.107.0" },
        {
          VITEST: "true",
        },
      ),
    ).toBe(true);
  });

  it("formats publish-incomplete after a bounded wait with zero visibility", () => {
    const report = buildCliDriftReport("0.107.0", {
      skipRegistryPoll: false,
      pollTimeoutMs: 60_000,
      pollIntervalMs: 30_000,
      ...sleepClock(),
      checkActiveCli: () => ({
        ok: true,
        code: 0,
        active: null,
        candidates: [],
        targetVersion: "0.107.0",
        message: "no CLI",
        lines: [],
      }),
      viewPackage: (name) => probe(name, false),
    });
    expect(report.registry).toBe("publish-incomplete");
    expect(report.match).toBe(false);
    expect(report.localVersion).toBeNull();
    expect(formatCliDriftReport(report)).toContain("local global CLI: none on PATH");
    expect(formatCliDriftReport(report)).toContain("publish-incomplete");
  });

  it("notes PATH shadowing when the active-CLI check fails", () => {
    const report = buildCliDriftReport("0.107.0", {
      skipRegistryPoll: false,
      pollTimeoutMs: 0,
      checkActiveCli: () => staleCli("0.95.0", "0.107.0"),
      viewPackage: (name) => probe(name, name !== "@deftai/directive-core"),
    });
    expect(report.shadowed).toBe(true);
    expect(report.registry).toBe("still-propagating");
    expect(report.lines.join("\n")).toContain("PATH-shadowed");
    expect(report.lines.join("\n")).toContain("@deftai/directive-core");
  });

  it("marks the wait exhausted when the poll ceiling elapses", () => {
    const { waitExhausted, probes } = pollWorkspacePackages("0.107.0", {
      timeoutMs: 60_000,
      intervalMs: 30_000,
      ...sleepClock(),
      viewPackage: (name) => probe(name, false),
    });
    expect(waitExhausted).toBe(true);
    expect(probes.every((p) => !p.visible)).toBe(true);
  });

  it("skips the registry poll under GITHUB_ACTIONS", () => {
    expect(
      shouldSkipRegistryPoll(
        { dryRun: false, skipTag: false, version: "0.107.0" },
        {
          GITHUB_ACTIONS: "true",
        },
      ),
    ).toBe(true);
  });

  it("never throws from the best-effort emitter", () => {
    const chunks: string[] = [];
    emitCliDriftReportBestEffort(
      "0.107.0",
      {
        skipRegistryPoll: false,
        checkActiveCli: () => {
          throw new Error("probe boom");
        },
      },
      (text) => {
        chunks.push(text);
      },
    );
    expect(chunks.join("")).toContain("CLI drift report (#3753): skipped");
    expect(chunks.join("")).toContain("probe boom");
  });
  it("parses versions-list membership without hitting the live registry", () => {
    expect(versionsListContains(JSON.stringify(["0.112.0", "0.113.0"]), "0.113.0")).toBe(true);
    expect(versionsListContains(JSON.stringify(["0.112.0"]), "0.113.0")).toBe(false);
    expect(versionsListContains('"0.113.0"', "0.113.0")).toBe(true);
    expect(versionsListContains("", "0.113.0")).toBe(false);
  });

  it("Phase 7 caller uses the 10-minute ceiling and a real sleep seam", () => {
    expect(phase7CliDriftPollTimeoutMs()).toBe(10 * 60 * 1000);
    expect(phase7CliDriftPollTimeoutMs()).toBe(CLI_DRIFT_POLL_TIMEOUT_MS);
    const sleeps: number[] = [];
    const chunks: string[] = [];
    const clock = sleepClock();
    const code = runPhase7NpmWait(
      "0.107.0",
      {
        skipRegistryPoll: false,
        nowMs: clock.nowMs,
        sleepMs: (ms) => {
          sleeps.push(ms);
          clock.sleepMs(ms);
        },
        checkActiveCli: () => ({
          ok: true,
          code: 0,
          active: null,
          candidates: [],
          targetVersion: "0.107.0",
          message: "no CLI",
          lines: [],
        }),
        viewPackage: (name) => probe(name, name !== "@deftai/directive-core"),
      },
      (text) => {
        chunks.push(text);
      },
    );
    expect(code).toBe(0);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("still-propagating");
    expect(chunks.join("")).toContain("@deftai/directive-core");
    expect(chunks.join("")).toContain("wait before installing");
    expect(chunks.join("")).toContain("npm i -g @deftai/directive@0.107.0 --prefer-online");
    expect(chunks.join("")).toContain("does not run npm i -g");
  });

  it("keeps Step 13 at timeout 0 in the pipeline source", () => {
    const src = readFileSync(join(process.cwd(), "packages/core/src/release/pipeline.ts"), "utf8");
    expect(src).toContain("pollTimeoutMs: 0");
    expect(src).not.toContain("pollTimeoutMs: CLI_DRIFT_POLL_TIMEOUT_MS");
  });

  it("default sleep is Atomics.wait, not a no-op", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release/cli-drift-report.ts"),
      "utf8",
    );
    expect(src).toContain("Atomics.wait");
    expect(src).toContain("sleepMs ?? defaultCliDriftSleepMs");
    expect(src).not.toContain("() => undefined");
    defaultCliDriftSleepMs(0);
  });

  it("isolates npm view in a temp cwd with a scoped registry npmrc", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release/cli-drift-report.ts"),
      "utf8",
    );
    expect(src).toContain("deft-cli-drift-npm-view-");
    expect(src).toContain("@deftai:registry=");
    expect(src).toContain("cwd: dir");
  });

  it("cmdReleaseWaitNpm is report-only and rejects bad argv", () => {
    expect(cmdReleaseWaitNpm(["--help"])).toBe(0);
    expect(cmdReleaseWaitNpm([])).toBe(2);
    expect(cmdReleaseWaitNpm(["not-a-version"])).toBe(2);
    expect(cmdReleaseWaitNpm(["0.107.0", "--bogus"])).toBe(2);
  });

  it("does not fold pollWorkspacePackages into the CI two-pass fixture", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release-e2e/npm-ops.ts"),
      "utf8",
    );
    expect(src).not.toContain("pollWorkspacePackages");
    expect(src).not.toContain("runPhase7NpmWait");
  });
  it("does not treat npm view failures as unpublished", () => {
    const failed = WORKSPACE_PACKAGES.map((name) => ({
      name,
      visible: false,
      version: null,
      probeFailed: true,
    }));
    expect(
      classifyRegistryVisibility({ probes: failed, waitExhausted: true, skipped: false }),
    ).toBe("probe-failed");
    const mixed = [
      probe("@deftai/directive-types", true),
      { name: "@deftai/directive-core" as const, visible: false, version: null, probeFailed: true },
      probe("@deftai/directive-content", true),
      probe("@deftai/directive", true),
    ];
    expect(
      classifyRegistryVisibility({ probes: mixed, waitExhausted: false, skipped: false }),
    ).toBe("probe-failed");
    const report = buildCliDriftReport("0.107.0", {
      skipRegistryPoll: false,
      pollTimeoutMs: 0,
      checkActiveCli: () => ({
        ok: true,
        code: 0,
        active: null,
        candidates: [],
        targetVersion: "0.107.0",
        message: "no CLI",
        lines: [],
      }),
      viewPackage: (name) => ({ name, visible: false, version: null, probeFailed: true }),
    });
    expect(report.registry).toBe("probe-failed");
    expect(formatCliDriftReport(report)).toContain("probe-failed");
    expect(formatCliDriftReport(report)).toContain("not a missing-publish verdict");
    expect(formatCliDriftReport(report)).not.toContain("publish-incomplete");
  });

  it("does not start another probe pass after the poll deadline", () => {
    let calls = 0;
    pollWorkspacePackages("0.107.0", {
      timeoutMs: 30_000,
      intervalMs: 30_000,
      ...sleepClock(),
      viewPackage: (name) => {
        calls += 1;
        return probe(name, false);
      },
    });
    expect(calls).toBe(WORKSPACE_PACKAGES.length);
  });
});
