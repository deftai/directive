import { describe, expect, it } from "vitest";
import {
  formatCacheFetchAllRecoveryCommand,
  recoveryHintForStaleFailure,
} from "./cache-recovery.js";

describe("formatCacheFetchAllRecoveryCommand (#2574)", () => {
  it("uses the space-separated CLI surface with required source and repo", () => {
    expect(formatCacheFetchAllRecoveryCommand("deftai/directive")).toBe(
      "deft cache fetch-all --source github-issue --repo deftai/directive",
    );
  });

  it("appends --force when age-stale recovery is requested", () => {
    expect(formatCacheFetchAllRecoveryCommand("deftai/cartograph", { force: true })).toBe(
      "deft cache fetch-all --source github-issue --repo deftai/cartograph --force",
    );
  });

  it("falls back to OWNER/NAME when repo is unresolved", () => {
    expect(formatCacheFetchAllRecoveryCommand(null, { force: true })).toBe(
      "deft cache fetch-all --source github-issue --repo OWNER/NAME --force",
    );
  });

  it("never emits the unknown cache:fetch-all colon alias", () => {
    const plain = formatCacheFetchAllRecoveryCommand("owner/repo");
    const forced = formatCacheFetchAllRecoveryCommand("owner/repo", { force: true });
    for (const cmd of [plain, forced]) {
      expect(cmd).not.toContain("cache:fetch-all");
      expect(cmd).toContain("cache fetch-all");
      expect(cmd).toContain("--source github-issue");
      expect(cmd).toContain("--repo");
    }
  });
});

describe("recoveryHintForStaleFailure -- branch-aware (#1953 / #2574)", () => {
  it("age-only failure names cache fetch-all --force with repo slug", () => {
    const hint = recoveryHintForStaleFailure(
      { ageStale: true, driftDetected: false },
      "deftai/directive",
    );
    expect(hint).toContain("cache fetch-all --source github-issue --repo deftai/directive --force");
    expect(hint).not.toContain("cache:fetch-all");
  });

  it("drift-only failure names plain cache fetch-all without --force", () => {
    const hint = recoveryHintForStaleFailure(
      { ageStale: false, driftDetected: true },
      "deftai/directive",
    );
    expect(hint).toContain("cache fetch-all --source github-issue --repo deftai/directive");
    expect(hint).not.toContain("--force");
    expect(hint).not.toContain("cache:fetch-all");
  });

  it("mixed age+drift prefers cache fetch-all --force", () => {
    const hint = recoveryHintForStaleFailure(
      { ageStale: true, driftDetected: true },
      "deftai/directive",
    );
    expect(hint).toContain("--force");
    expect(hint).not.toContain("cache:fetch-all");
  });
});
