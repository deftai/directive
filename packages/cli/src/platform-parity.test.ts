import { describe, expect, it } from "vitest";
import {
  diffCase,
  normalizeAgentsPlan,
  normalizeCapabilityReport,
  PARITY_CASES,
  renderReport,
  runParity,
} from "./platform-parity.js";

describe("platform-parity helpers", () => {
  it("normalizes volatile plan fields", () => {
    const normalized = normalizeAgentsPlan({
      state: "stale",
      sha: "abc",
      refreshed: "2020",
      session: "sess",
      new_content: "body",
    });
    expect(normalized.sha).toBe("<NORMALIZED>");
    expect(normalized.new_content).toBe("<NORMALIZED>");
  });

  it("normalizes capability ownership path", () => {
    const out = normalizeCapabilityReport({
      ownership: { path: "/tmp/x", uid: 1, gid: 1, interpreted_as_sandbox_view: false },
    });
    expect((out as { ownership: { path: string } }).ownership.path).toBe("<REPO>");
  });

  it("diffCase detects mismatches", () => {
    const diff = diffCase("x", { a: 1 }, { a: 2 });
    expect(diff.mismatch).toBe(true);
    expect(diffCase("y", { a: 1 }, { a: 1 }).mismatch).toBe(false);
  });

  it("renderReport lists case count", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain(String(PARITY_CASES.length));
  });

  it("runParity returns structured result", () => {
    const result = runParity();
    expect(result.diffs.length).toBe(PARITY_CASES.length);
    expect(typeof result.ok).toBe("boolean");
  });
});
