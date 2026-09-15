import { describe, expect, it } from "vitest";
import { TsCheckLaneProgressReporter } from "./progress-reporter.js";

describe("TsCheckLaneProgressReporter", () => {
  it("emits flushed 20% bands as modules finish", () => {
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

    reporter.onTestRunStart(Array.from({ length: 5 }, () => ({})));
    for (let i = 0; i < 5; i += 1) {
      reporter.onTestModuleEnd();
    }

    expect(writes).toEqual([
      "ts:check-lane 20% (1/5 files)\n",
      "ts:check-lane 40% (2/5 files)\n",
      "ts:check-lane 60% (3/5 files)\n",
      "ts:check-lane 80% (4/5 files)\n",
      "ts:check-lane 100% (5/5 files)\n",
    ]);
    expect(flushes).toBe(5);
    expect(writes.some((line) => line.includes("describe") || line.includes("it("))).toBe(false);
  });

  it("ignores vitest reporter options that are not a write sink", () => {
    const reporter = new TsCheckLaneProgressReporter({ outputFile: "unused.json" });
    expect(() => reporter.onTestRunStart([{}])).not.toThrow();
  });

  it("stays silent when the file total is unknown", () => {
    const writes: string[] = [];
    const reporter = new TsCheckLaneProgressReporter({
      write: (chunk: string) => {
        writes.push(chunk);
      },
    });
    reporter.onTestRunStart([]);
    reporter.onTestModuleEnd();
    expect(writes).toEqual([]);
  });

  it("emits a last-completed-file heartbeat before the 20% band (#4567)", () => {
    const writes: string[] = [];
    const reporter = new TsCheckLaneProgressReporter({
      write: (chunk: string) => {
        writes.push(chunk);
      },
    });
    reporter.onTestRunStart(Array.from({ length: 1218 }, () => ({})));
    reporter.onTestModuleEnd({ moduleId: "packages/core/src/hooks/a.test.ts" });
    expect(writes).toEqual([
      "ts:check-lane last-file packages/core/src/hooks/a.test.ts (1/1218 files)\n",
    ]);
  });

  it("emits a time-based last-file tick before 20% of files (#4567)", () => {
    const writes: string[] = [];
    let now = 1_000;
    const reporter = new TsCheckLaneProgressReporter(
      {
        write: (chunk: string) => {
          writes.push(chunk);
        },
      },
      { now: () => now, everyN: 10, heartbeatMs: 30_000 },
    );
    reporter.onTestRunStart(Array.from({ length: 1218 }, () => ({})));
    reporter.onTestModuleEnd({ moduleId: "one.test.ts" });
    now = 32_000;
    reporter.onTestModuleEnd({ moduleId: "two.test.ts" });
    expect(writes).toEqual([
      "ts:check-lane last-file one.test.ts (1/1218 files)\n",
      "ts:check-lane last-file two.test.ts (2/1218 files)\n",
    ]);
  });
});
