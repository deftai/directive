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
});
