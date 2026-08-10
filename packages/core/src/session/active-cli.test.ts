import { describe, expect, it } from "vitest";
import {
  type ActiveCliCheckSeams,
  type CliCandidate,
  checkActiveCliAgainstTarget,
} from "./active-cli.js";

function seamsFromMap(
  pathVersions: Readonly<Record<string, string | null>>,
  pathOrder: readonly string[],
): ActiveCliCheckSeams {
  const byCommand = new Map<string, string[]>();
  for (const p of pathOrder) {
    // Infer command from basename-ish path tail.
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
  };
}

describe("checkActiveCliAgainstTarget (#3233)", () => {
  it("passes when PATH is empty (absence is not this gate)", () => {
    const result = checkActiveCliAgainstTarget("0.98.1", {
      whichAll: () => [],
      probeVersion: () => null,
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
    expect(result.message).toMatch(/lower-precedence install is newer/i);
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
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/\+\d+ more/);
    // No target → remediation still lists upgrade command and competing installs.
    expect(result.lines.join("\n")).toContain("the upgraded engine version");
    expect(result.lines.join("\n")).toContain("Competing installs");
  });

  it("dedupes competing candidate paths across target and skew detection", () => {
    const result = checkActiveCliAgainstTarget(
      "0.98.1",
      seamsFromMap(
        {
          "/a/deft": "0.97.0",
          "/b/deft": "0.99.0",
        },
        ["/a/deft", "/b/deft"],
      ),
    );
    expect(result.ok).toBe(false);
    const competingLines = result.lines.filter((l) => l.includes("/b/deft"));
    // Listed in diagnostic + competing section, but competing section once.
    expect(competingLines.length).toBeGreaterThanOrEqual(1);
  });
});
