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
} from "./triage-classify-fixtures.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function buildRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-triage-classify-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  if (plan !== undefined) {
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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
      doMirror: false,
      apply: false,
    });
  });

  it("parses --list and --validate", () => {
    expect(parseArgs(["--list", "--project-root", "/tmp/x"])).toMatchObject({
      doList: true,
      projectRoot: "/tmp/x",
    });
    expect(parseArgs(["--validate"])).toMatchObject({ doValidate: true });
  });

  it("parses --mirror and --apply", () => {
    expect(parseArgs(["--mirror", "--apply", "--repo", "o/r"])).toMatchObject({
      doMirror: true,
      apply: true,
      repo: "o/r",
    });
  });

  it("parses Wave 2 bootstrap filters and batch flags", () => {
    expect(
      parseArgs([
        "--mirror",
        "--include-closed",
        "--batch-size",
        "5",
        "--delay-ms=100",
        "--sample-limit=3",
      ]),
    ).toMatchObject({
      doMirror: true,
      includeClosed: true,
      batchSize: 5,
      delayMs: 100,
      sampleLimit: 3,
    });
  });

  it("rejects --apply without --mirror", () => {
    expect(parseArgs(["--apply"]).error).toContain("--mirror");
  });

  it("rejects --include-closed without --mirror", () => {
    expect(parseArgs(["--include-closed"]).error).toContain("--mirror");
  });

  it("rejects --batch-size 0 (no silent default override)", () => {
    expect(parseArgs(["--mirror", "--batch-size", "0"]).error).toMatch(/batch-size/);
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

  it("dry-run --mirror prints digest without network (#1423 Wave 2)", () => {
    const root = buildRepo();
    const cacheDir = join(root, ".deft-cache", "github-issue", "acme", "demo", "7");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "raw.json"),
      JSON.stringify({
        number: 7,
        state: "open",
        body: "BLOCKED pending design",
        labels: [],
        updated_at: "2026-08-01T00:00:00Z",
      }),
      "utf8",
    );
    const closedDir = join(root, ".deft-cache", "github-issue", "acme", "demo", "8");
    mkdirSync(closedDir, { recursive: true });
    writeFileSync(
      join(closedDir, "raw.json"),
      JSON.stringify({
        number: 8,
        state: "closed",
        body: "closed archive stamp candidate",
        labels: [],
        updated_at: "2026-01-01T00:00:00Z",
      }),
      "utf8",
    );
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--mirror", "--project-root", root])).toBe(0);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("dry-run");
    expect(text).toContain("open-only");
    expect(text).toContain("By state");
    expect(text).toMatch(/planned=1|Samples/);
    expect(text).toMatch(/closed_skipped=1/);
    out.mockRestore();
  });

  it("--mirror --json emits structured outcome with digest", () => {
    const root = buildRepo();
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--mirror", "--json", "--project-root", root])).toBe(0);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(text) as {
      dry_run: boolean;
      scanned: number;
      skipped_closed: number;
      digest: { by_state: Record<string, number> };
      filters: { include_closed: boolean };
    };
    expect(parsed.dry_run).toBe(true);
    expect(typeof parsed.scanned).toBe("number");
    expect(parsed.filters.include_closed).toBe(false);
    expect(parsed.digest).toBeDefined();
    out.mockRestore();
  });
});

describe("triage-classify-parity helpers", () => {
  it("normalizeOutput strips temp paths", () => {
    expect(normalizeOutput("/tmp/deft-triage-classify-parity-abc/xbrief/foo")).toContain(
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
