import { describe, expect, it } from "vitest";
import {
  diffCase,
  normalizeAgentsPlan,
  normalizeCapabilityReport,
  PARITY_CASES,
  renderReport,
} from "./platform-parity.js";

// Hermetic unit tests: these exercise ONLY the parity binary's pure helpers
// with injected fixtures. The live cross-language diff (which shells out to the
// frozen Python oracle via `uv run python`) is intentionally NOT invoked here --
// it runs in the dedicated `TS port parity` CI job. vitest must never depend on
// a real Python subprocess / host state. (#1787 s3)
describe("platform-parity helpers", () => {
  it("normalizes volatile plan fields", () => {
    const normalized = normalizeAgentsPlan({
      state: "stale",
      sha: "abc",
      refreshed: "2020",
      session: "sess",
      attributed_rendered: "x",
      new_content: "body",
    });
    expect(normalized.sha).toBe("<NORMALIZED>");
    expect(normalized.refreshed).toBe("<NORMALIZED>");
    expect(normalized.session).toBe("<NORMALIZED>");
    expect(normalized.attributed_rendered).toBe("<NORMALIZED>");
    expect(normalized.new_content).toBe("<NORMALIZED>");
    expect(normalized.state).toBe("stale");
  });

  it("leaves absent plan keys untouched", () => {
    const normalized = normalizeAgentsPlan({ state: "current" });
    expect(normalized).toEqual({ state: "current" });
  });

  it("normalizes capability ownership path", () => {
    const out = normalizeCapabilityReport({
      ownership: { path: "/tmp/x", uid: 1, gid: 1, interpreted_as_sandbox_view: false },
      runtime_mode: "cloud-headless",
    });
    expect((out as { ownership: { path: string } }).ownership.path).toBe("<REPO>");
    expect((out as { runtime_mode: string }).runtime_mode).toBe("cloud-headless");
  });

  it("passes through non-object and ownership-less capability reports", () => {
    expect(normalizeCapabilityReport(null)).toBeNull();
    expect(normalizeCapabilityReport("scalar")).toBe("scalar");
    expect(normalizeCapabilityReport({ runtime_mode: "x" })).toEqual({ runtime_mode: "x" });
  });

  it("diffCase detects mismatches and equality", () => {
    const diff = diffCase("x", { a: 1 }, { a: 2 });
    expect(diff.mismatch).toBe(true);
    expect(diff.caseName).toBe("x");
    expect(diffCase("y", { a: 1 }, { a: 1 }).mismatch).toBe(false);
  });

  it("renderReport lists case count on CLEAN", () => {
    const report = renderReport({ ok: true, diffs: [] });
    expect(report).toContain("CLEAN");
    expect(report).toContain(String(PARITY_CASES.length));
  });

  it("renderReport prints DIVERGENCE detail blocks", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "slug-normalize-unicode",
          mismatch: true,
          pythonJson: '{\n  "slugs": ["a"]\n}\n',
          tsJson: '{\n  "slugs": ["b"]\n}\n',
        },
        {
          caseName: "version-resolve-manifest",
          mismatch: false,
          pythonJson: "{}\n",
          tsJson: "{}\n",
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("slug-normalize-unicode");
    expect(report).toContain("--- python");
    expect(report).toContain("--- ts");
    // The non-mismatching case must not be rendered as a diff block.
    expect(report).not.toContain("version-resolve-manifest");
  });

  it("defines the six golden-diff parity cases", () => {
    expect(PARITY_CASES.length).toBe(6);
    expect(PARITY_CASES.map((c) => c.name)).toContain("agents-refresh-managed-section");
  });

  it("runs the slug TS side hermetically (no Python subprocess)", () => {
    const slugCase = PARITY_CASES.find((c) => c.name === "slug-normalize-unicode");
    expect(slugCase).toBeDefined();
    const ts = slugCase?.runTs("", "") as { slugs: string[]; collision: string };
    expect(Array.isArray(ts.slugs)).toBe(true);
    expect(ts.slugs.length).toBeGreaterThan(0);
    expect(ts.collision).not.toBe("hello-world");
  });
});
