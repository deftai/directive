import { describe, expect, it } from "vitest";
import {
  BRANCH_GATE_BYPASS_ENV,
  COVERAGE_DEBT_ENV,
  RELEASE_PREFLIGHT_ENV,
} from "../release/constants.js";
import {
  buildTestLaneCommand,
  formatProgressLine,
  nextProgressTick,
  PROGRESS_REPORTER_RELATIVE_PATH,
  writeFlushedLine,
} from "./progress.js";
import { TsCheckLaneProgressReporter } from "./progress-reporter.js";
import {
  LANE_COMMANDS,
  resolvePnpm,
  runTsLane,
  SKIP_NOTICE,
  sanitizeTsLaneEnv,
  shouldUseShellForCommand,
} from "./run-lane.js";

/** Records invocations and returns a scripted exit code per call. */
class Runner {
  private codes: number[];
  public calls: Array<{ argv: readonly string[]; cwd: string }> = [];

  constructor(codes: number[]) {
    this.codes = [...codes];
  }

  run = (argv: readonly string[], cwd: string): { status: number | null } => {
    this.calls.push({ argv, cwd });
    const code = this.codes.length > 0 ? (this.codes.shift() as number) : 0;
    return { status: code };
  };
}

describe("sanitizeTsLaneEnv", () => {
  it("removes release Step-5 bypass vars while preserving other env", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      [BRANCH_GATE_BYPASS_ENV]: "1",
      [RELEASE_PREFLIGHT_ENV]: "1",
    };

    const sanitized = sanitizeTsLaneEnv(base);

    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/user");
    expect(sanitized[BRANCH_GATE_BYPASS_ENV]).toBeUndefined();
    expect(sanitized[RELEASE_PREFLIGHT_ENV]).toBeUndefined();
  });

  it("does not mutate the input env object", () => {
    const base = {
      [BRANCH_GATE_BYPASS_ENV]: "1",
      [RELEASE_PREFLIGHT_ENV]: "1",
    };

    sanitizeTsLaneEnv(base);

    expect(base[BRANCH_GATE_BYPASS_ENV]).toBe("1");
    expect(base[RELEASE_PREFLIGHT_ENV]).toBe("1");
  });
});

describe("runTsLane", () => {
  it("skips with a notice when pnpm is absent", () => {
    const messages: string[] = [];
    const runner = new Runner([]);

    const rc = runTsLane("/repo", { pnpm: null, runner: runner.run, out: (m) => messages.push(m) });

    expect(rc).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(messages.some((m) => m.includes("skipping the TypeScript lane"))).toBe(true);
    expect(messages[0]).toBe(SKIP_NOTICE);
  });

  it("runs all lane commands in order when pnpm is present", () => {
    const runner = new Runner([0, 0, 0]);

    const rc = runTsLane("/repo", {
      pnpm: "/usr/bin/pnpm",
      runner: runner.run,
      out: () => undefined,
      reporterExists: () => true,
    });

    expect(rc).toBe(0);
    expect(runner.calls.map((c) => c.argv)).toEqual(
      LANE_COMMANDS.map((cmd) => ["/usr/bin/pnpm", ...cmd]),
    );
    expect(runner.calls.every((c) => c.cwd === "/repo")).toBe(true);
  });

  it("stamps DEFT_TS_LANE_COVERAGE_DEBT for test when release Step-5 env is set (#2618 / vitest 3)", () => {
    const runner = new Runner([0, 0, 0]);
    const seenDebt: Array<string | undefined> = [];
    const prior = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    const wrapped = (argv: readonly string[], cwd: string) => {
      seenDebt.push(process.env.DEFT_TS_LANE_COVERAGE_DEBT);
      return runner.run(argv, cwd);
    };

    try {
      const rc = runTsLane("/repo", {
        pnpm: "/usr/bin/pnpm",
        runner: wrapped,
        out: () => undefined,
        reporterExists: () => true,
        env: {
          [COVERAGE_DEBT_ENV]: "2618",
          [RELEASE_PREFLIGHT_ENV]: "1",
        },
      });

      expect(rc).toBe(0);
      expect(runner.calls.map((c) => c.argv)).toEqual([
        ["/usr/bin/pnpm", "run", "lint"],
        ["/usr/bin/pnpm", "run", "build"],
        ["/usr/bin/pnpm", ...buildTestLaneCommand()],
      ]);
      // Debt env is only active during the test step.
      expect(seenDebt).toEqual([undefined, undefined, "2618"]);
      expect(process.env.DEFT_TS_LANE_COVERAGE_DEBT).toBeUndefined();
    } finally {
      if (prior === undefined) {
        delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
      } else {
        process.env.DEFT_TS_LANE_COVERAGE_DEBT = prior;
      }
    }
  });

  it("restores a prior DEFT_TS_LANE_COVERAGE_DEBT after the test step", () => {
    const runner = new Runner([0, 0, 0]);
    const prior = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    process.env.DEFT_TS_LANE_COVERAGE_DEBT = "keep-me";
    try {
      const rc = runTsLane("/repo", {
        pnpm: "/usr/bin/pnpm",
        runner: runner.run,
        out: () => undefined,
        env: {
          [COVERAGE_DEBT_ENV]: "2618",
          [RELEASE_PREFLIGHT_ENV]: "1",
        },
      });
      expect(rc).toBe(0);
      expect(process.env.DEFT_TS_LANE_COVERAGE_DEBT).toBe("keep-me");
    } finally {
      if (prior === undefined) {
        delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
      } else {
        process.env.DEFT_TS_LANE_COVERAGE_DEBT = prior;
      }
    }
  });

  it("omits the reporter when the checkout has no reporter source file", () => {
    const runner = new Runner([0, 0, 0]);
    const rc = runTsLane("/consumer", {
      pnpm: "/usr/bin/pnpm",
      runner: runner.run,
      out: () => undefined,
      reporterExists: () => false,
    });
    expect(rc).toBe(0);
    expect(runner.calls[2]?.argv).toEqual(["/usr/bin/pnpm", "run", "test"]);
  });

  it("wires a flushed vitest progress reporter onto the test command (#3470)", () => {
    expect(LANE_COMMANDS[2]).toEqual([
      "run",
      "test",
      "--reporter",
      PROGRESS_REPORTER_RELATIVE_PATH,
      "--reporter",
      "default",
    ]);
  });

  it("fails fast on the first non-zero exit", () => {
    // lint passes, build fails -> test must NOT run, exit code propagates.
    const runner = new Runner([0, 2, 0]);
    const messages: string[] = [];

    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: runner.run,
      out: (m) => messages.push(m),
    });

    expect(rc).toBe(2);
    expect(runner.calls).toHaveLength(2); // lint + build only; test skipped
    expect(messages.some((m) => m.includes("build` failed (exit 2)"))).toBe(true);
  });

  it("treats a null status (signal kill / OOM) as a hard failure", () => {
    const messages: string[] = [];
    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: () => ({ signal: "SIGTERM", status: null }),
      out: (m) => messages.push(m),
    });
    expect(rc).toBe(1);
    expect(messages.some((m) => m.includes("killed by SIGTERM"))).toBe(true);
  });

  it("treats a null status without a signal name as a generic kill", () => {
    const messages: string[] = [];
    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: () => ({ status: null }),
      out: (m) => messages.push(m),
    });
    expect(rc).toBe(1);
    expect(messages.some((m) => m.includes("killed by a signal"))).toBe(true);
  });

  it("reports subprocess start errors separately from signal kills", () => {
    const messages: string[] = [];
    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: () => ({ error: new Error("spawn EINVAL"), status: null }),
      out: (m) => messages.push(m),
    });
    expect(rc).toBe(1);
    expect(messages.some((m) => m.includes("failed to start: spawn EINVAL"))).toBe(true);
  });
});

describe("shouldUseShellForCommand", () => {
  it("uses a shell for Windows command shims", () => {
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.CMD", "win32")).toBe(true);
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.bat", "win32")).toBe(true);
  });

  it("does not use a shell for native executables or non-Windows platforms", () => {
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.EXE", "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/bin/pnpm", "linux")).toBe(false);
  });
});

describe("resolvePnpm", () => {
  it("returns null when PATH is empty", () => {
    expect(resolvePnpm({ env: { PATH: "" }, platform: "linux" })).toBeNull();
  });

  it("returns null when PATH is unset", () => {
    expect(resolvePnpm({ env: {}, platform: "linux" })).toBeNull();
  });

  it("finds pnpm on a posix PATH", () => {
    const found = resolvePnpm({
      env: { PATH: "/empty:/usr/local/bin" },
      platform: "linux",
      exists: (p) => p === "/usr/local/bin/pnpm",
    });
    expect(found).toBe("/usr/local/bin/pnpm");
  });

  it("returns null when pnpm is not on any PATH entry", () => {
    const found = resolvePnpm({
      env: { PATH: "/a:/b" },
      platform: "linux",
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it("uses PATHEXT and ; separator on win32", () => {
    const found = resolvePnpm({
      env: { Path: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      exists: (p) => p.endsWith(".CMD"),
    });
    expect(found?.endsWith("pnpm.CMD")).toBe(true);
  });

  it("falls back to a default PATHEXT on win32 when unset", () => {
    const found = resolvePnpm({
      env: { Path: "C:\\bin" },
      platform: "win32",
      exists: (p) => p.endsWith(".EXE"),
    });
    expect(found?.endsWith("pnpm.EXE")).toBe(true);
  });

  it("skips empty PATH segments", () => {
    const found = resolvePnpm({
      env: { PATH: "::/usr/bin" },
      platform: "linux",
      exists: (p) => p === "/usr/bin/pnpm",
    });
    expect(found).toBe("/usr/bin/pnpm");
  });
});

describe("ts:check-lane progress ticks (#3470)", () => {
  it("emits at least two flushed band lines without test names", () => {
    const writes: string[] = [];
    let flushes = 0;
    const sink = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
      flush: () => {
        flushes += 1;
      },
    };

    const first = nextProgressTick(412, 2060, 0);
    const second = nextProgressTick(824, 2060, first?.percent ?? 0);
    expect(first).toEqual({ percent: 20, completed: 412, total: 2060 });
    expect(second).toEqual({ percent: 40, completed: 824, total: 2060 });
    if (first === null || second === null) {
      throw new Error("expected two progress ticks");
    }
    expect(formatProgressLine(first)).toBe("ts:check-lane 20% (412/2060 files)");
    expect(formatProgressLine(second)).toBe("ts:check-lane 40% (824/2060 files)");

    writeFlushedLine(formatProgressLine(first), sink);
    writeFlushedLine(formatProgressLine(second), sink);

    expect(writes).toEqual([
      "ts:check-lane 20% (412/2060 files)\n",
      "ts:check-lane 40% (824/2060 files)\n",
    ]);
    expect(flushes).toBe(2);
    expect(writes.every((line) => !line.includes("should") && !line.includes(".test.ts"))).toBe(
      true,
    );
  });

  it("drives two flushed ticks from the vitest reporter hooks", () => {
    const writes: string[] = [];
    let flushes = 0;
    const reporter = new TsCheckLaneProgressReporter({
      write: (chunk: string) => {
        writes.push(chunk);
      },
      flush: () => {
        flushes += 1;
      },
    });

    reporter.onTestRunStart(Array.from({ length: 10 }, () => ({})));
    reporter.onTestModuleEnd();
    reporter.onTestModuleEnd();
    reporter.onTestModuleEnd();
    reporter.onTestModuleEnd();

    expect(writes).toEqual([
      "ts:check-lane 20% (2/10 files)\n",
      "ts:check-lane 40% (4/10 files)\n",
    ]);
    expect(flushes).toBe(2);
  });
});
