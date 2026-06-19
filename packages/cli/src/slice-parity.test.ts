import { describe, expect, it } from "vitest";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./slice-parity.js";

describe("slice-parity helpers", () => {
  it("normalizeOutput replaces volatile values", () => {
    expect(
      normalizeOutput(
        "slice_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee at 2026-05-14T17:00:00Z --project-root /tmp/x",
      ),
    ).toContain("slice_id=<UUID>");
    expect(normalizeOutput("")).toBe("");
  });

  it("diffCase flags mismatches", () => {
    const same = diffCase(
      { exitCode: 0, stdout: "ok", stderr: "" },
      { exitCode: 0, stdout: "ok", stderr: "" },
      "x",
    );
    expect(same.exitMismatch).toBe(false);
    const diff = diffCase(
      { exitCode: 1, stdout: "", stderr: "err" },
      { exitCode: 0, stdout: "", stderr: "other" },
      "x",
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.stderrMismatch).toBe(true);
  });

  it("renderReport describes clean and divergent results", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "list-empty",
            exitMismatch: true,
            stdoutMismatch: true,
            stderrMismatch: false,
            pythonExit: 0,
            tsExit: 2,
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });

  it.each(
    PARITY_CASES.map((c) => [c.name, c] as const),
  )("buildFixtureRepo handles %s", (_name, c) => {
    const root = buildFixtureRepo(c.fixture);
    expect(root.length).toBeGreaterThan(0);
  });
});
