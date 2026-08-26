import { describe, expect, it } from "vitest";
import type { ActiveCliCheckResult, CliCandidate } from "../session/active-cli.js";
import {
  buildCliDriftReport,
  classifyRegistryVisibility,
  emitCliDriftReportBestEffort,
  formatCliDriftReport,
  npmViewArgs,
  pollWorkspacePackages,
  remediationCommand,
  shouldSkipRegistryPoll,
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
    expect(args).toContain("@deftai/directive-core@0.107.0");
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
      nowMs: (() => {
        let t = 0;
        return () => {
          const now = t;
          t += 30_000;
          return now;
        };
      })(),
      sleepMs: () => undefined,
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
      nowMs: (() => {
        let t = 0;
        return () => {
          const now = t;
          t += 30_000;
          return now;
        };
      })(),
      sleepMs: () => undefined,
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
      nowMs: (() => {
        let t = 0;
        return () => {
          const now = t;
          t += 30_000;
          return now;
        };
      })(),
      sleepMs: () => undefined,
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
});
