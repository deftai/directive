import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdVbriefBuild } from "./main.js";
import { PARITY_SCENARIO_NAMES, runParityScenario } from "./parity-scenarios.js";

describe("main CLI", () => {
  it("prints help for missing args", () => {
    expect(cmdVbriefBuild([])).toBe(2);
  });

  it("runs all parity scenarios", () => {
    expect(cmdVbriefBuild(["--all"])).toBe(0);
  });
});

describe("parity scenarios", () => {
  it("covers every named scenario", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "vb-scenarios-"));
    for (const name of PARITY_SCENARIO_NAMES) {
      const result = runParityScenario(name, { fixtureRoot });
      expect(result.scenario).toBe(name);
      expect(result.ok).toBe(true);
    }
  });
});
