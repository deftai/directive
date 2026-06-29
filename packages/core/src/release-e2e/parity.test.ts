import { describe, expect, it } from "vitest";
import { normaliseStderr, PARITY_SCENARIOS } from "../../../cli/src/release-e2e-fixtures.js";

describe("release-e2e parity helpers", () => {
  it("normalises repo slugs in stderr", () => {
    const input =
      "[e2e] Provision temp repo... DRYRUN (would run `gh repo create --private deftai/deftai-release-test-20260619115029-31972b`)";
    expect(normaliseStderr(input)).toContain("deftai-release-test-YYYYMMDDHHMMSS-uuid6");
    expect(normaliseStderr(input)).not.toContain("31972b");
  });

  it("defines cache-off dry-run scenarios", () => {
    expect(PARITY_SCENARIOS.some((s) => s.name === "dry-run")).toBe(true);
    expect(PARITY_SCENARIOS.some((s) => s.name === "help")).toBe(true);
  });
});
