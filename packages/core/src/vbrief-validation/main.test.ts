import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdVbriefValidation, run } from "./main.js";
import { PARITY_SCENARIO_NAMES, runParityScenario } from "./parity-scenarios.js";

function seedValidProjectDefinition(vbriefDir: string): void {
  mkdirSync(vbriefDir, { recursive: true });
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "PROJECT-DEFINITION",
        status: "running",
        narratives: { Overview: "Test overview narrative.", "tech stack": "Python 3.12" },
        items: [],
      },
    }),
    "utf8",
  );
}

describe("vbrief-validation parity scenarios", () => {
  it("runs every named scenario", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-parity-"));
    try {
      seedValidProjectDefinition(join(root, "vbrief-valid"));
      seedValidProjectDefinition(join(root, "vbrief"));
      for (const name of PARITY_SCENARIO_NAMES) {
        const result = runParityScenario(name, { fixtureRoot: root });
        expect(result.ok, name).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("vbrief-validation CLI", () => {
  it("returns usage on missing args", () => {
    expect(run([])).toBe(2);
  });

  it("runs a single scenario via cmd", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cli-"));
    try {
      expect(cmdVbriefValidation(["--scenario", "slugify-basic", "--fixture-root", root])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
