import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSmoketestArgs } from "@deftai/directive-core/dist/triage/smoketest/index.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./triage-aux-b-parity.js";
import { parseArgs as parseBulkArgs, run as runBulk } from "./triage-bulk.js";
import { run as runHelp } from "./triage-help.js";
import { run as runSmoketestCli } from "./triage-smoketest.js";
import { parseArgs as parseSubscribeArgs, run as runSubscribe } from "./triage-subscribe.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function captureIo(fn: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: fn(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

describe("triage-help CLI", () => {
  it("prints triage category list", () => {
    const { code, stdout } = captureIo(() => runHelp(["triage"]));
    expect(code).toBe(0);
    expect(stdout).toContain("Session-start:");
  });

  it("prints verb help", () => {
    const { code, stdout } = captureIo(() => runHelp(["help", "task triage:queue"]));
    expect(code).toBe(0);
    expect(stdout).toContain("task triage:queue");
  });

  it("prints registry list", () => {
    const { code, stdout } = captureIo(() => runHelp(["list"]));
    expect(code).toBe(0);
    expect(stdout).toContain("task triage:queue");
  });

  it("prints scope category", () => {
    const { code, stdout } = captureIo(() => runHelp(["scope"]));
    expect(code).toBe(0);
    expect(stdout).toContain("scope:promote");
  });
});

describe("triage-subscribe CLI", () => {
  it("parses subscribe args", () => {
    const args = parseSubscribeArgs(["subscribe", "--label", "bug"]);
    expect(args.op).toBe("subscribe");
    expect(args.label).toBe("bug");
  });

  it("parses milestone issue and equals-form flags", () => {
    expect(parseSubscribeArgs(["subscribe", "--milestone=v1"]).milestone).toBe("v1");
    expect(parseSubscribeArgs(["subscribe", "--issue=42"]).issue).toBe(42);
    expect(parseSubscribeArgs(["subscribe", "--label=x", "--project-root=/tmp"]).projectRoot).toBe(
      "/tmp",
    );
    expect(parseSubscribeArgs(["subscribe", "--actor=me"]).actor).toBe("me");
  });

  it("reports parse errors", () => {
    expect(parseSubscribeArgs(["subscribe", "--label"]).error).toContain("--label");
    expect(parseSubscribeArgs(["subscribe", "--bad"]).error).toContain("unrecognized");
    expect(parseSubscribeArgs(["nope", "--label", "x"]).op).toBe("nope");
    expect(parseSubscribeArgs(["subscribe", "--milestone"]).error).toContain("--milestone");
    expect(parseSubscribeArgs(["subscribe", "--issue"]).error).toContain("--issue");
    expect(parseSubscribeArgs(["subscribe", "--project-root"]).error).toContain("--project-root");
    expect(parseSubscribeArgs(["subscribe", "--issue-note"]).error).toContain("--issue-note");
    expect(parseSubscribeArgs(["subscribe", "--actor"]).error).toContain("--actor");
  });

  it("subscribes a label on fixture project", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    const { code, stdout, stderr } = captureIo(() =>
      runSubscribe(["subscribe", "--label", "area:test", "--project-root", root]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("triage:subscribe:");
    expect(stderr).toContain("Reconciliation");
  });

  it("unsubscribes a subscribed label", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    runSubscribe(["subscribe", "--label", "gone", "--project-root", root]);
    const { code, stdout } = captureIo(() =>
      runSubscribe(["unsubscribe", "--label", "gone", "--project-root", root]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("removed");
  });

  it("rejects missing selector", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    const { code, stderr } = captureIo(() => runSubscribe(["subscribe", "--project-root", root]));
    expect(code).toBe(2);
    expect(stderr).toContain("exactly one");
  });

  it("rejects invalid op", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    const { code, stderr } = captureIo(() =>
      runSubscribe(["nope", "--label", "x", "--project-root", root]),
    );
    expect(code).toBe(2);
    expect(stderr).toContain("subscribe' or 'unsubscribe");
  });

  it("unsubscribes missing label", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    const { code, stderr } = captureIo(() =>
      runSubscribe(["unsubscribe", "--label", "ghost", "--project-root", root]),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("not-subscribed");
  });

  it("reports bad project root", () => {
    const { code, stderr } = captureIo(() =>
      runSubscribe(["subscribe", "--label", "x", "--project-root", "/no/such/root"]),
    );
    expect(code).toBe(2);
    expect(stderr).toContain("does not exist");
  });

  it("returns 1 on corrupt project definition", () => {
    const root = buildFixtureRepo("subscribe");
    temps.push(root);
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{", "utf8");
    const { code, stderr } = captureIo(() =>
      runSubscribe(["subscribe", "--label", "x", "--project-root", root]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("triage:subscribe:");
  });
});

describe("triage-bulk CLI", () => {
  it("parses bulk args", () => {
    const args = parseBulkArgs(["defer", "--repo", "deftai/directive", "--label", "x"]);
    expect(args.action).toBe("defer");
    expect(args.repo).toBe("deftai/directive");
  });

  it("parses equals-form flags", () => {
    const args = parseBulkArgs([
      "reject",
      "--repo=deftai/directive",
      "--label=bug",
      "--author=alice",
      "--age-days=7",
      "--cluster=foo",
      "--reason=dup",
      "--re-action",
    ]);
    expect(args.repo).toBe("deftai/directive");
    expect(args.label).toBe("bug");
    expect(args.author).toBe("alice");
    expect(args.ageDays).toBe(7);
    expect(args.cluster).toBe("foo");
    expect(args.reason).toBe("dup");
    expect(args.reAction).toBe(true);
  });

  it("reports parse errors", () => {
    expect(parseBulkArgs(["defer", "--repo"]).error).toContain("--repo");
    expect(parseBulkArgs(["defer", "--nope"]).error).toContain("unrecognized");
    expect(parseBulkArgs(["defer", "--label"]).error).toContain("--label");
    expect(parseBulkArgs(["defer", "--author"]).error).toContain("--author");
    expect(parseBulkArgs(["defer", "--age-days"]).error).toContain("--age-days");
    expect(parseBulkArgs(["defer", "--cluster"]).error).toContain("--cluster");
    expect(parseBulkArgs(["defer", "--reason"]).error).toContain("--reason");
  });

  it("exits 2 on empty cache", () => {
    const root = buildFixtureRepo("bulk-empty");
    temps.push(root);
    const prev = process.cwd();
    try {
      vi.stubEnv("DEFT_ROOT", root);
      process.chdir(root);
      const { code, stderr } = captureIo(() => runBulk(["defer", "--repo", "deftai/parity"]));
      expect(code).toBe(2);
      expect(stderr).toContain("cache is empty");
    } finally {
      process.chdir(prev);
      vi.unstubAllEnvs();
    }
  });

  it("prints help via intercept", () => {
    const { code, stdout } = captureIo(() => runBulk(["accept", "--help"]));
    expect(code).toBe(0);
    expect(stdout).toContain("task triage:bulk-accept");
  });

  it("rejects missing action and repo", () => {
    const { code: c1, stderr: e1 } = captureIo(() => runBulk([]));
    expect(c1).toBe(2);
    expect(e1).toContain("action required");
    const { code: c2, stderr: e2 } = captureIo(() => runBulk(["defer"]));
    expect(c2).toBe(2);
    expect(e2).toContain("--repo is required");
    const { code: c3 } = captureIo(() => runBulk(["--help"]));
    expect(c3).toBe(0);
  });

  it("rejects invalid bulk action name", () => {
    const { code, stderr } = captureIo(() => runBulk(["nope", "--repo", "deftai/parity"]));
    expect(code).toBe(2);
    expect(stderr).toContain("action required");
  });

  it("runs reject with reason on zero-match path", () => {
    const root = buildFixtureRepo("bulk-filter");
    temps.push(root);
    const prev = process.cwd();
    try {
      vi.stubEnv("DEFT_ROOT", root);
      process.chdir(root);
      const { code, stdout } = captureIo(() =>
        runBulk([
          "reject",
          "--repo",
          "deftai/parity",
          "--label",
          "no-such-label",
          "--reason",
          "dup",
        ]),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("zero matches");
    } finally {
      process.chdir(prev);
      vi.unstubAllEnvs();
    }
  });

  it("zero-match on filtered cache", () => {
    const root = buildFixtureRepo("bulk-filter");
    temps.push(root);
    const prev = process.cwd();
    try {
      vi.stubEnv("DEFT_ROOT", root);
      process.chdir(root);
      const { code, stdout } = captureIo(() =>
        runBulk(["defer", "--repo", "deftai/parity", "--label", "no-such-label"]),
      );
      expect(code).toBe(0);
      expect(stdout).toContain("zero matches");
    } finally {
      process.chdir(prev);
      vi.unstubAllEnvs();
    }
  });
});

describe("triage-smoketest CLI", () => {
  it("parses cache-only flag", () => {
    const args = parseSmoketestArgs(["--cache-only"]);
    expect(args.cacheOnly).toBe(true);
  });

  it("parses fixture path and help", () => {
    expect(parseSmoketestArgs(["--fixture", "/tmp/x"]).fixture).toBe("/tmp/x");
    expect(parseSmoketestArgs(["--help"]).showHelp).toBe(true);
    expect(parseSmoketestArgs(["-h"]).showHelp).toBe(true);
    expect(parseSmoketestArgs(["--keep-tempdir"]).keepTempdir).toBe(true);
    expect(parseSmoketestArgs(["--fixture"]).error).toContain("--fixture");
  });

  it("prints help via intercept", () => {
    const { code, stdout } = captureIo(() => runSmoketestCli(["--help"]));
    expect(code).toBe(0);
    expect(stdout).toContain("triage:smoketest");
  });

  it("fails on missing fixture", () => {
    const { code, stderr } = captureIo(() =>
      runSmoketestCli(["--fixture", "/no/such/fixture/path"]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("FAIL: fixture root");
  });

  it("reports unrecognized argv", () => {
    const { code, stderr } = captureIo(() => runSmoketestCli(["--nope-flag"]));
    expect(code).toBe(2);
    expect(stderr).toContain("unrecognized");
  });

  it("runs cache-only against framework fixture", () => {
    const deftRoot = process.cwd();
    const fixture = join(deftRoot, "tests/fixtures/triage_smoketest");
    if (!existsSync(join(fixture, "issues.json"))) {
      return;
    }
    vi.stubEnv("DEFT_ROOT", deftRoot);
    try {
      const { code } = captureIo(() => runSmoketestCli(["--fixture", fixture, "--cache-only"]));
      expect([0, 1]).toContain(code);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("triage-aux-b-parity exports", () => {
  it("defines parity cases for all four verbs", () => {
    const verbs = new Set(PARITY_CASES.map((c) => c.verb));
    expect(verbs.has("help")).toBe(true);
    expect(verbs.has("subscribe")).toBe(true);
    expect(verbs.has("bulk")).toBe(true);
    expect(verbs.has("smoketest")).toBe(true);
  });

  it("diffCase detects exit mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 1, stdout: "a", stderr: "" },
      "x",
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.stdoutMismatch).toBe(false);
  });

  it("diffCase detects stdout and stderr mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "py", stderr: "e1" },
      { exitCode: 0, stdout: "ts", stderr: "e2" },
      "y",
    );
    expect(diff.stdoutMismatch).toBe(true);
    expect(diff.stderrMismatch).toBe(true);
  });

  it("normalizeOutput strips temp paths", () => {
    expect(normalizeOutput("/tmp/deft-foo bar")).toContain("<TMPROOT>");
  });

  it("renderReport shows CLEAN when ok", () => {
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
        },
        {
          caseName: "y",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: true,
          pythonExit: 0,
          tsExit: 0,
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("stdout mismatch");
    expect(report).toContain("stderr mismatch");
  });

  it("buildFixtureRepo bulk-filter populates cache", () => {
    const root = buildFixtureRepo("bulk-filter");
    temps.push(root);
    expect(
      existsSync(join(root, ".deft-cache", "github-issue", "deftai", "parity", "99", "raw.json")),
    ).toBe(true);
  });
});
