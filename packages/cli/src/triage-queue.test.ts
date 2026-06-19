import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./triage-queue.js";
import {
  augmentParityArgv,
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./triage-queue-parity.js";

const temps: string[] = [];

afterAll(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
});

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

describe("triage-queue CLI", () => {
  it("parseArgs defaults limit to 25", () => {
    const args = parseArgs(["queue", "--repo", "owner/repo"]);
    expect(args.limit).toBe(25);
    expect(args.repo).toBe("owner/repo");
  });

  it("parseArgs handles equals-form flags", () => {
    const args = parseArgs([
      "queue",
      "--project-root=/tmp/root",
      "--repo=owner/repo",
      "--limit=3",
      "--audit-log=/tmp/audit.jsonl",
      "--slices-log=/tmp/slices.jsonl",
      "--cache-root=/tmp/cache",
    ]);
    expect(args).toMatchObject({
      projectRoot: "/tmp/root",
      repo: "owner/repo",
      limit: 3,
      auditLog: "/tmp/audit.jsonl",
      slicesLog: "/tmp/slices.jsonl",
      cacheRoot: "/tmp/cache",
    });
  });
  it("parseArgs handles spaced flags", () => {
    const args = parseArgs([
      "queue",
      "--project-root",
      "/tmp/root",
      "--repo",
      "owner/repo",
      "--limit",
      "0",
      "--include-blocked",
      "--audit-log",
      "/tmp/audit.jsonl",
      "--slices-log",
      "/tmp/slices.jsonl",
    ]);
    expect(args).toMatchObject({
      projectRoot: "/tmp/root",
      limit: 0,
      includeBlocked: true,
      auditLog: "/tmp/audit.jsonl",
      slicesLog: "/tmp/slices.jsonl",
    });
  });

  it("parseArgs rejects invalid limit values", () => {
    const args = parseArgs(["queue", "--limit", "many"]);
    expect(args.error).toContain("invalid int value");
  });
  it("parseArgs rejects unknown flags", () => {
    const args = parseArgs(["queue", "--unknown"]);
    expect(args.error).toContain("unrecognized argument");
  });

  it("run returns 2 when repo cannot be resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-queue-cli-"));
    temps.push(root);
    expect(silentRun(["queue", "--project-root", root])).toBe(2);
  });

  it("run returns 2 on parse errors", () => {
    expect(silentRun(["queue", "--limit"])).toBe(2);
  });

  it("run prints ranked queue for seeded fixture", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 1, title: "Urgent", updatedAt: "2026-05-15T10:00:00Z" },
        { number: 2, title: "Untriaged", updatedAt: "2026-05-17T10:00:00Z" },
      ],
      auditEntries: [{ issueNumber: 1, decision: "needs-ac" }],
    });
    temps.push(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(run(["queue", "--project-root", root, "--repo", "owner/repo", "--limit", "0"])).toBe(
        0,
      );
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("#1");
      expect(output).toContain("#2");
      expect(output).toContain("[untriaged]");
      expect(output.indexOf("#2")).toBeLessThan(output.indexOf("#1"));
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("triage-queue-parity helpers", () => {
  it("normalizeOutput strips volatile project_root paths", () => {
    expect(normalizeOutput("project_root=/tmp/foo")).toBe("project_root=<ROOT>");
  });

  it("diffCase detects stdout and exit mismatches", () => {
    const clean = diffCase(
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      "case",
    );
    expect(clean.exitMismatch).toBe(false);
    expect(clean.stdoutMismatch).toBe(false);

    const diverged = diffCase(
      { exitCode: 0, stdout: "a\n", stderr: "" },
      { exitCode: 1, stdout: "b\n", stderr: "" },
      "case",
    );
    expect(diverged.exitMismatch).toBe(true);
    expect(diverged.stdoutMismatch).toBe(true);
  });

  it("renderReport prints CLEAN summary", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("diffCase detects stderr mismatch", () => {
    const diff = diffCase(
      { exitCode: 2, stdout: "", stderr: "err-a" },
      { exitCode: 2, stdout: "", stderr: "err-b" },
      "stderr-case",
    );
    expect(diff.stderrMismatch).toBe(true);
  });

  it("renderReport includes stderr-only divergence", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "missing-repo",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: true,
          pythonExit: 2,
          tsExit: 2,
        },
      ],
    });
    expect(report).toContain("stderr mismatch");
  });
  it("renderReport prints divergence details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "group-order",
          exitMismatch: true,
          stdoutMismatch: true,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("group-order");
  });

  it("buildFixtureRepo supports blocked and slice fixtures", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 70, title: "Blocked", state: "open" },
        { number: 71, title: "Open", state: "open" },
      ],
      blockedIssueNumbers: [70],
      sliceRecords: [
        {
          slice_id: "slice-x",
          umbrella: 10,
          children: [{ n: 11, url: "https://github.com/owner/repo/issues/11" }],
        },
      ],
      activeIssueNumbers: [71],
    });
    temps.push(root);
    expect(root.length).toBeGreaterThan(0);
  });
  it("renderReport skips clean diffs in divergence output", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "clean-case",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 0,
        },
        {
          caseName: "bad-case",
          exitMismatch: true,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
        },
      ],
    });
    expect(report).toContain("bad-case");
    expect(report).not.toContain("clean-case");
  });
  it("augmentParityArgv leaves skipFixture argv unchanged", () => {
    const argv = augmentParityArgv(
      { name: "missing", argv: ["--project-root", "<ROOT>"], skipFixture: true },
      "/tmp/x",
    );
    expect(argv).toEqual(["--project-root", "/tmp/x"]);
  });

  it("augmentParityArgv adds audit and slice hooks for fixtures", () => {
    const root = "/tmp/fixture";
    const testCase = {
      name: "fixture",
      argv: ["--project-root", "<ROOT>", "--repo", "owner/repo"],
      fixture: {
        auditEntries: [{ issueNumber: 1, decision: "accept" }],
        sliceRecords: [{ slice_id: "s1", umbrella: 1, children: [] }],
      },
    };
    const argv = augmentParityArgv(testCase, root);
    expect(argv).toContain(join(root, "vbrief", ".eval", "candidates.jsonl"));
    expect(argv).toContain(join(root, "vbrief", ".eval", "slices.jsonl"));
  });

  it("buildFixtureRepo writes cache and audit artifacts", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 9, title: "Nine" }],
      auditEntries: [{ issueNumber: 9, decision: "accept" }],
      rankingLabels: ["urgent"],
    });
    temps.push(root);
    expect(PARITY_CASES.length).toBeGreaterThan(5);
    const definition = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    expect(definition.length).toBeGreaterThan(0);
  });
});
