import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-wip-cap.js";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./wip-cap-parity.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
}

function writeVbrief(root: string, folder: "pending" | "active", name: string): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { status: "approved", title: "T", items: [] },
    }),
    "utf8",
  );
}

function buildRepo(options: { plan?: Record<string, unknown>; pendingFiles?: number }): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-wip-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  for (let i = 0; i < (options.pendingFiles ?? 0); i += 1) {
    writeVbrief(root, "pending", `pending-${i}.vbrief.json`);
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
      allowOverCap: false,
      quiet: false,
    });
  });

  it("parses all flags", () => {
    expect(parseArgs(["--project-root", "/root", "--allow-over-cap", "--quiet"])).toMatchObject({
      projectRoot: "/root",
      allowOverCap: true,
      quiet: true,
    });
  });

  it("parses = form for project-root", () => {
    expect(parseArgs(["--project-root=/tmp/x"]).projectRoot).toBe("/tmp/x");
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
  });
});

describe("run", () => {
  it("returns 0 when within cap", () => {
    const root = buildRepo({ plan: { policy: { wipCap: 5 } }, pendingFiles: 1 });
    expect(silentRun(["--project-root", root])).toBe(0);
  });

  it("returns 1 when over cap", () => {
    const root = buildRepo({ plan: { policy: { wipCap: 1 } }, pendingFiles: 2 });
    expect(silentRun(["--project-root", root])).toBe(1);
  });

  it("returns 0 with --allow-over-cap when over cap", () => {
    const root = buildRepo({ plan: { policy: { wipCap: 1 } }, pendingFiles: 2 });
    expect(silentRun(["--project-root", root, "--allow-over-cap"])).toBe(0);
  });

  it("returns 2 for malformed wipCap", () => {
    const root = buildRepo({ plan: { policy: { wipCap: "bad" } } });
    expect(silentRun(["--project-root", root])).toBe(2);
  });

  it("returns 2 for bad args", () => {
    expect(silentRun(["--bogus"])).toBe(2);
  });

  it("writes success banner to stdout", () => {
    const root = buildRepo({ plan: { policy: { wipCap: 5 } } });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root])).toBe(0);
      const written = out.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("✓ verify:wip-cap:");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("suppresses stdout when --quiet", () => {
    const root = buildRepo({ plan: { policy: { wipCap: 5 } } });
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["--project-root", root, "--quiet"])).toBe(0);
      expect(out.mock.calls.length).toBe(0);
      expect(err.mock.calls.length).toBe(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("wip-cap-parity helpers", () => {
  it("normalizeOutput replaces project_root paths", () => {
    expect(normalizeOutput("over cap; project_root=/tmp/foo/bar")).toContain("project_root=<ROOT>");
  });

  it("diffCase flags mismatches", () => {
    const py = { exitCode: 1, stdout: "", stderr: "err" };
    const ts = { exitCode: 1, stdout: "", stderr: "err" };
    expect(diffCase(py, ts, "x").exitMismatch).toBe(false);

    const ts2 = { exitCode: 0, stdout: "ok", stderr: "" };
    expect(diffCase(py, ts2, "x").exitMismatch).toBe(true);
  });

  it("renderReport describes clean and divergent results", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
    expect(
      renderReport({
        ok: false,
        diffs: [
          {
            caseName: "over-cap-refusal",
            exitMismatch: true,
            stdoutMismatch: false,
            stderrMismatch: true,
            pythonExit: 1,
            tsExit: 0,
          },
        ],
      }),
    ).toContain("DIVERGENCE");
  });

  it.each(
    PARITY_CASES.map((c) => [c.name, c] as const),
  )("buildFixtureRepo handles case %s", (_name, testCase) => {
    const root = buildFixtureRepo(testCase.fixture);
    temps.push(root);
    expect(root.length).toBeGreaterThan(0);
  });
});
