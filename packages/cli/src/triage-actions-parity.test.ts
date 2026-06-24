import { describe, expect, it } from "vitest";
import {
  buildFixtureRepo,
  type CommandCapture,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./triage-actions-parity.js";

describe("normalizeOutput", () => {
  it("replaces UUIDs and timestamps", () => {
    const raw = "defer #7 (deftai/directive) -> c3f3a68e-016b-43aa-a0be-e585bc440165\n";
    expect(normalizeOutput(raw)).toBe("defer #7 (deftai/directive) -> <UUID>\n");
  });
});

describe("diffCase", () => {
  it("reports no mismatch when outputs agree after normalisation", () => {
    const cap: CommandCapture = { exitCode: 1, stdout: "", stderr: "triage_actions: boom" };
    const diff = diffCase(cap, cap, "x");
    expect(diff.exitMismatch).toBe(false);
    expect(diff.stderrMismatch).toBe(false);
  });

  it("reports exit mismatch", () => {
    const py: CommandCapture = { exitCode: 1, stdout: "", stderr: "" };
    const ts: CommandCapture = { exitCode: 0, stdout: "", stderr: "" };
    expect(diffCase(py, ts, "x").exitMismatch).toBe(true);
  });

  it("reports stderr mismatch", () => {
    const py: CommandCapture = {
      exitCode: 1,
      stdout: "",
      stderr: "triage_actions: boom a\n",
    };
    const ts: CommandCapture = {
      exitCode: 1,
      stdout: "",
      stderr: "triage_actions: boom b\n",
    };
    expect(diffCase(py, ts, "x").stderrMismatch).toBe(true);
  });

  it("ignores non-triage stderr noise after normalisation", () => {
    const py: CommandCapture = { exitCode: 0, stdout: "", stderr: "Downloading uv\n" };
    const ts: CommandCapture = { exitCode: 0, stdout: "", stderr: "" };
    expect(diffCase(py, ts, "x").stderrMismatch).toBe(false);
  });
});

describe("renderReport", () => {
  it("renders CLEAN when ok", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("renders DIVERGENCE details", () => {
    const text = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "x",
          exitMismatch: true,
          stdoutMismatch: true,
          stderrMismatch: true,
          pythonExit: 1,
          tsExit: 0,
        },
      ],
    });
    expect(text).toContain("DIVERGENCE");
    expect(text).toContain("stdout mismatch");
    expect(text).toContain("stderr mismatch");
  });
});

describe("buildFixtureRepo", () => {
  it("creates vbrief/.eval parent", () => {
    const root = buildFixtureRepo();
    expect(root.length).toBeGreaterThan(0);
  });
});

describe("PARITY_CASES", () => {
  it("defines at least four scenarios", () => {
    expect(PARITY_CASES.length).toBeGreaterThanOrEqual(4);
  });
});
