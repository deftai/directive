import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ActiveCliCheckSeams,
  type CliCandidate,
  checkActiveCliAgainstTarget,
  readEngineVersionFromInstallTree,
  resolveDefaultActiveCliTarget,
} from "./active-cli.js";

function seamsFromMap(
  pathVersions: Readonly<Record<string, string | null>>,
  pathOrder: readonly string[],
  extras: Partial<ActiveCliCheckSeams> = {},
): ActiveCliCheckSeams {
  const byCommand = new Map<string, string[]>();
  for (const p of pathOrder) {
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "deft";
    const command = base.replace(/\.(cmd|exe|bat)$/i, "");
    const list = byCommand.get(command) ?? [];
    list.push(p);
    byCommand.set(command, list);
  }
  return {
    commands: ["deft", "directive"],
    whichAll: (name) => byCommand.get(name) ?? [],
    probeVersion: (path) => (path in pathVersions ? (pathVersions[path] ?? null) : null),
    // Prevent in-process package version from becoming an unexpected target in unit tests.
    resolveDefaultTarget: (candidates) =>
      resolveDefaultActiveCliTarget(candidates, extras.inProcessVersion ?? null),
    inProcessVersion: extras.inProcessVersion ?? null,
    ...extras,
  };
}

describe("checkActiveCliAgainstTarget (#3233)", () => {
  it("passes when PATH is empty (absence is not this gate)", () => {
    const result = checkActiveCliAgainstTarget("0.98.1", {
      whichAll: () => [],
      probeVersion: () => null,
      inProcessVersion: null,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("passes when a single active CLI matches the upgrade target", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap({ "/Users/x/.nvm/bin/deft": "0.98.1" }, ["/Users/x/.nvm/bin/deft"]),
    );
    expect(result.ok).toBe(true);
    expect(result.active?.path).toBe("/Users/x/.nvm/bin/deft");
    expect(result.message).toContain("matches target 0.98.1");
  });

  it("fails closed when PATH prefers an older install after upgrading another prefix", () => {
    const homebrew = "/opt/homebrew/bin/deft";
    const nvm = "/Users/davidcall/.nvm/versions/node/v24.18.0/bin/deft";
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap(
        {
          [homebrew]: "0.97.0",
          [nvm]: "0.98.1",
        },
        [homebrew, nvm],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/stale higher-precedence CLI/i);
    expect(result.lines.join("\n")).toContain(homebrew);
    expect(result.lines.join("\n")).toContain(nvm);
    expect(result.lines.join("\n")).toContain("0.97.0");
    expect(result.lines.join("\n")).toContain("0.98.1");
    expect(result.lines.join("\n")).toMatch(/Remediation/i);
    expect(result.lines.join("\n")).toContain("npm i -g @deftai/directive@latest");
  });

  it("fails closed on multi-prefix skew without an explicit target", () => {
    const result = checkActiveCliAgainstTarget(
      null,
      seamsFromMap(
        {
          "/opt/homebrew/bin/deft": "0.97.0",
          "/Users/x/.nvm/bin/deft": "0.98.1",
        },
        ["/opt/homebrew/bin/deft", "/Users/x/.nvm/bin/deft"],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/lower-precedence install is newer|upgrade target/i);
  });

  it("uses default target from in-process engine when production omits target (#3233 P1)", () => {
    const result = checkActiveCliAgainstTarget(
      null,
      seamsFromMap({ "/opt/homebrew/bin/deft": "0.97.0" }, ["/opt/homebrew/bin/deft"], {
        inProcessVersion: "0.98.1",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.targetVersion).toBe("0.98.1");
    expect(result.message).toMatch(/upgrade target is 0\.98\.1/);
  });

  it("does not let a lone active CLI become its own default target", () => {
    const result = checkActiveCliAgainstTarget(
      null,
      seamsFromMap({ "/opt/homebrew/bin/deft": "0.97.0" }, ["/opt/homebrew/bin/deft"], {
        inProcessVersion: null,
      }),
    );
    // No independent target and no shadow → not this gate's job (no false self-match).
    expect(result.ok).toBe(true);
    expect(result.targetVersion).toBeNull();
    expect(result.message).toMatch(/not shadowed/);
  });

  it("passes when multiple candidates share the same engine version", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap(
        {
          "/opt/homebrew/bin/deft": "0.98.1",
          "/Users/x/.nvm/bin/deft": "0.98.1",
        },
        ["/opt/homebrew/bin/deft", "/Users/x/.nvm/bin/deft"],
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("passes when active is newer than a lower-precedence leftover", () => {
    const result = checkActiveCliAgainstTarget(
      null,
      seamsFromMap(
        {
          "/Users/x/.nvm/bin/deft": "0.98.1",
          "/opt/homebrew/bin/deft": "0.97.0",
        },
        ["/Users/x/.nvm/bin/deft", "/opt/homebrew/bin/deft"],
        { inProcessVersion: "0.98.1" },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("fails when active version cannot be probed against a target", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap({ "/opt/homebrew/bin/deft": null }, ["/opt/homebrew/bin/deft"]),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not report an engine version/i);
  });

  it("checks directive as well as deft", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap(
        {
          "/opt/homebrew/bin/directive": "0.97.0",
          "/Users/x/.nvm/bin/directive": "0.98.1",
        },
        ["/opt/homebrew/bin/directive", "/Users/x/.nvm/bin/directive"],
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("directive");
  });

  it("lists candidate shapes for remediation consumers", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap(
        {
          "/a/deft": "0.97.0",
          "/b/deft": "0.98.1",
        },
        ["/a/deft", "/b/deft"],
      ),
    );
    const active = result.active as CliCandidate;
    expect(active.precedence).toBe(0);
    expect(result.candidates).toHaveLength(2);
  });

  it("aggregates multi-command failures and still remediates without a target", () => {
    const result = checkActiveCliAgainstTarget(null, {
      commands: ["deft", "directive"],
      whichAll: (name) =>
        name === "deft"
          ? ["/opt/homebrew/bin/deft", "/Users/x/.nvm/bin/deft"]
          : ["/opt/homebrew/bin/directive", "/Users/x/.nvm/bin/directive"],
      probeVersion: (path) => (path.includes("homebrew") ? "0.97.0" : "0.98.1"),
      inProcessVersion: null,
      resolveDefaultTarget: (cs) => resolveDefaultActiveCliTarget(cs, null),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/\+\d+ more|upgrade target|lower-precedence/i);
    expect(result.lines.join("\n")).toContain("Competing installs");
  });

  it("does not pass precedence>0 paths to an exec-style probe (security P1)", () => {
    const executed: number[] = [];
    checkActiveCliAgainstTarget("0.98.1", {
      whichAll: (name) => (name === "deft" ? ["/active/deft", "/shadow/deft"] : []),
      probeVersion: (_path, precedence) => {
        executed.push(precedence);
        return precedence === 0 ? "0.97.0" : "0.98.1";
      },
      commands: ["deft"],
      inProcessVersion: null,
      resolveDefaultTarget: () => "0.98.1",
    });
    // Collector still calls probe for both, but default probeCandidateVersion never
    // spawns for precedence>0; injected probe receives precedence for tests.
    expect(executed).toEqual([0, 1]);
  });
});

describe("readEngineVersionFromInstallTree (#3233)", () => {
  it("reads @deftai/directive package.json without executing the binary", () => {
    const root = join(tmpdir(), `deft-active-cli-pkg-${Date.now()}`);
    const pkgDir = join(root, "node_modules", "@deftai", "directive");
    const binDir = join(pkgDir, "dist");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@deftai/directive",
        version: "0.98.1",
        dependencies: { "@deftai/directive-core": "0.98.1" },
      }),
      "utf8",
    );
    const bin = join(binDir, "bin.js");
    writeFileSync(bin, "#!/usr/bin/env node\n", "utf8");
    expect(readEngineVersionFromInstallTree(bin)).toBe("0.98.1");
  });
});
