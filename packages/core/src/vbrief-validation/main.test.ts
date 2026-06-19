import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdVbriefValidation, run } from "./main.js";
import { PARITY_SCENARIO_NAMES, runParityScenario } from "./parity-scenarios.js";
import { setValidateAllForTests } from "./validation.js";

describe("vbrief-validation parity scenarios", () => {
  it("runs every named scenario", () => {
    // Stub the Python validate_all bridge so the suite stays hermetic in the
    // Node-only CI job (the real bridge is exercised by the parity harness in
    // the Python-enabled parity job).
    setValidateAllForTests(() => [[], []]);
    const root = mkdtempSync(join(tmpdir(), "vb-parity-"));
    try {
      for (const name of PARITY_SCENARIO_NAMES) {
        const result = runParityScenario(name, { fixtureRoot: root });
        expect(result.ok, name).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      setValidateAllForTests(null);
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
