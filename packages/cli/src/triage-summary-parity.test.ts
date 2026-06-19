import { describe, expect, it } from "vitest";
import { parseArgs } from "./triage-summary.js";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
  runParity,
} from "./triage-summary-parity.js";

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      noHistory: false,
      json: false,
    });
  });

  it("parses all flags", () => {
    expect(
      parseArgs(["--project-root", "/tmp/p", "--cache-root", "/tmp/c", "--no-history", "--json"]),
    ).toMatchObject({
      projectRoot: "/tmp/p",
      cacheRoot: "/tmp/c",
      noHistory: true,
      json: true,
    });
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--bogus"]).error).toContain("unrecognized");
  });
});

describe("triage-summary-parity helpers", () => {
  it("normalizeOutput normalizes emitted_at", () => {
    expect(normalizeOutput('{"emitted_at": "2026-01-01T00:00:00Z"}\n')).toBe(
      '{"emitted_at": "<TS>"}',
    );
  });

  it("diffCase detects stdout mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a\n", stderr: "" },
      { exitCode: 0, stdout: "b\n", stderr: "" },
      "x",
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("renderReport CLEAN when ok", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("renderReport shows divergence details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "x",
          exitMismatch: true,
          stdoutMismatch: true,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
          pythonStdout: "py",
          tsStdout: "ts",
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("python stdout:");
  });

  it("buildFixtureRepo creates cache layout", () => {
    const root = buildFixtureRepo({
      cachedIssues: [{ repo: "deftai/directive", number: 1 }],
    });
    expect(root.length).toBeGreaterThan(0);
  });

  it("parity cases are non-empty", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });

  it("runParity returns structured result", () => {
    const result = runParity();
    expect(result.diffs).toHaveLength(PARITY_CASES.length);
  });
});
