import { describe, expect, it } from "vitest";
import { INSTALL_CLI_TAIL_COVERAGE_MAP } from "./coverage-map.js";

describe("install/migrate CLI tail coverage map", () => {
  it("classifies every in-scope pytest file exactly once", () => {
    const paths = INSTALL_CLI_TAIL_COVERAGE_MAP.map((e) => e.pythonTest);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBe(21);
  });

  it("tags retarget entries with vitest spec paths", () => {
    const retarget = INSTALL_CLI_TAIL_COVERAGE_MAP.filter((e) => e.classification === "retarget");
    expect(retarget).toHaveLength(2);
    for (const entry of retarget) {
      expect(entry.vitestSpec).toContain("install-cli/");
    }
  });

  it("records one-line rationale for every entry", () => {
    for (const entry of INSTALL_CLI_TAIL_COVERAGE_MAP) {
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });
});
