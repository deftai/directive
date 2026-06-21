import { describe, expect, it } from "vitest";
import {
  coverageMapCompleteness,
  ORCHESTRATION_CLI_COVERAGE_MAP,
  ORCHESTRATION_CLI_PYTHON_TESTS,
  renderCoverageMapMarkdown,
} from "./coverage-map.js";

describe("orchestration-cli coverage map", () => {
  it("lists every in-scope Python CLI test file", () => {
    const result = coverageMapCompleteness();
    expect(result.ok, `missing: ${result.missing.join(", ")}`).toBe(true);
    expect(ORCHESTRATION_CLI_PYTHON_TESTS.length).toBe(28);
  });

  it("records both existing-coverage and orchestration-cli-spec rows", () => {
    const kinds = new Set(ORCHESTRATION_CLI_COVERAGE_MAP.map((e) => e.kind));
    expect(kinds.has("existing-coverage")).toBe(true);
    expect(kinds.has("orchestration-cli-spec")).toBe(true);
  });

  it("renders a PR-body markdown table", () => {
    const md = renderCoverageMapMarkdown();
    expect(md).toContain("| Python test | Kind | TS target | Notes |");
    expect(md).toContain("test_pr_merge_readiness.py");
    expect(md).toContain("test_release.py");
    expect(md).toContain("test_swarm_launch.py");
  });
});
