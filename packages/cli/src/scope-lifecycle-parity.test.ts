import { describe, expect, it, vi } from "vitest";
import {
  buildArgv,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
  runParity,
} from "./scope-lifecycle-parity.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    status: 2,
    stdout: "usage: scope_lifecycle.py <action> <file>",
    stderr: "usage: scope_lifecycle.py <action> <file>",
  })),
}));

describe("scope-lifecycle-parity helpers", () => {
  it("normalizes output", () => {
    expect(normalizeOutput("  hello   world  ")).toBe("hello world");
    expect(normalizeOutput("root --project-root /tmp/x")).toContain("<ROOT>");
  });

  it("diffCase detects mismatches", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "ok", stderr: "" },
      { exitCode: 1, stdout: "bad", stderr: "err" },
      "x",
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.stdoutMismatch).toBe(true);
    expect(diff.stderrMismatch).toBe(true);
  });

  it("renderReport clean and divergence", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "a",
            exitMismatch: true,
            stdoutMismatch: true,
            stderrMismatch: false,
            pythonExit: 1,
            tsExit: 2,
            pythonStdout: "x",
            pythonStderr: "",
            tsStdout: "y",
            tsStderr: "",
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });

  it("buildArgv resolves file placeholder", () => {
    const repo = "/tmp/repo";
    const argv = buildArgv(repo, PARITY_CASES[2] as { argv: readonly string[]; fileRel?: string });
    expect(argv[1]).toContain("proposed");
  });

  it("runParity with mocked subprocess", () => {
    const result = runParity();
    expect(result.diffs.length).toBe(PARITY_CASES.length);
    expect(result.ok).toBe(true);
  });

  it("renderReport includes stderr mismatch details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "x",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: true,
          pythonExit: 1,
          tsExit: 1,
          pythonStdout: "",
          pythonStderr: "err a",
          tsStdout: "",
          tsStderr: "err b",
        },
      ],
    });
    expect(report).toContain("python stderr");
  });

  it("renderReport includes exit mismatch details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "y",
          exitMismatch: true,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
          pythonStdout: "",
          pythonStderr: "",
          tsStdout: "",
          tsStderr: "",
        },
      ],
    });
    expect(report).toContain("exit mismatch");
  });
});
