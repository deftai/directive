import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./triage-classify.js";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./triage-classify-parity.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function buildRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-triage-classify-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (plan !== undefined) {
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], ...plan },
      }),
      "utf8",
    );
  }
  return root;
}

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("parseArgs", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      doList: false,
      doValidate: false,
    });
  });

  it("parses --list and --validate", () => {
    expect(parseArgs(["--list", "--project-root", "/tmp/x"])).toMatchObject({
      doList: true,
      projectRoot: "/tmp/x",
    });
    expect(parseArgs(["--validate"])).toMatchObject({ doValidate: true });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });
});

describe("run", () => {
  it("lists effective rules when no project definition", () => {
    const root = buildRepo();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--list", "--project-root", root])).toBe(0);
    expect(out.mock.calls.some((c) => String(c[0]).includes("universal:hold-marker"))).toBe(true);
    out.mockRestore();
  });

  it("validates missing project definition", () => {
    const root = buildRepo();
    expect(silentRun(["--validate", "--project-root", root])).toBe(0);
  });

  it("returns 2 for missing project root", () => {
    expect(silentRun(["--validate", "--project-root", "/does/not/exist"])).toBe(2);
  });

  it("returns 1 for invalid classify rules", () => {
    const root = buildRepo({
      policy: { triageAutoClassify: [{ match: {}, action: "defer", reason: "??" }] },
    });
    expect(silentRun(["--validate", "--project-root", root])).toBe(1);
  });
});

describe("triage-classify-parity helpers", () => {
  it("normalizeOutput strips temp paths", () => {
    expect(normalizeOutput("/tmp/deft-triage-classify-parity-abc/vbrief/foo")).toContain(
      "<TMPROOT>",
    );
  });

  it("diffCase detects mismatches", () => {
    const clean = diffCase(
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      "same",
    );
    expect(clean.exitMismatch).toBe(false);
    expect(clean.stdoutMismatch).toBe(false);

    const bad = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 1, stdout: "b", stderr: "" },
      "diff",
    );
    expect(bad.exitMismatch).toBe(true);
    expect(bad.stdoutMismatch).toBe(true);
  });

  it("renderReport reports CLEAN", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("buildFixtureRepo creates project definition", () => {
    const root = buildFixtureRepo({ plan: { policy: { wipCap: 5 } } });
    temps.push(root);
    expect(silentRun(["--validate", "--project-root", root])).toBe(0);
  });

  it("exports parity cases", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
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
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("stdout mismatch");
  });
});
