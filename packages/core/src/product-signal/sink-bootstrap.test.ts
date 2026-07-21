import { describe, expect, it, vi } from "vitest";
import { GhRestError } from "../scm/gh-rest.js";
import { bootstrapProductSignalLabels, bootstrapProductSignalSink } from "./sink-bootstrap.js";

describe("sink-bootstrap", () => {
  it("dry-run bootstrap sink", () => {
    expect(bootstrapProductSignalSink({ dryRun: true }).stdout).toContain("dry-run");
  });

  it("skips existing labels", () => {
    const runGhApiFn = vi.fn(() => ({ returncode: 1, stdout: "", stderr: "already_exists" }));
    expect(
      bootstrapProductSignalLabels("deftai/product-signal", { runGhApiFn }).skipped,
    ).toBeGreaterThan(0);
  });

  it("records label errors for unexpected failures", () => {
    const runGhApiFn = vi.fn(() => {
      throw new GhRestError({
        stderr: "500 server",
        exitCode: 500,
        endpoint: "labels",
        payload: null,
      });
    });
    const result = bootstrapProductSignalLabels("deftai/product-signal", { runGhApiFn });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("records non-GhRestError label failures", () => {
    const runGhApiFn = vi.fn(() => {
      throw new Error("boom");
    });
    const result = bootstrapProductSignalLabels("deftai/product-signal", { runGhApiFn });
    expect(result.errors[0]).toContain("boom");
  });
});
