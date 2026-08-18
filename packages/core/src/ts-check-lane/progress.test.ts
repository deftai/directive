import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROGRESS_BAND_PERCENT as EXPORTED_BAND } from "./index.js";
import {
  formatProgressLine,
  nextProgressTick,
  PROGRESS_BAND_PERCENT,
  PROGRESS_REPORTER_RELATIVE_PATH,
  resolveTestLaneCommand,
  writeFlushedLine,
} from "./progress.js";

describe("resolveTestLaneCommand", () => {
  it("omits the reporter when the source file is absent", () => {
    expect(resolveTestLaneCommand("/consumer", () => false)).toEqual(["run", "test"]);
  });

  it("wires the reporter when the source file exists", () => {
    expect(resolveTestLaneCommand("/repo", () => true)).toEqual([
      "run",
      "test",
      "--reporter",
      PROGRESS_REPORTER_RELATIVE_PATH,
      "--reporter",
      "default",
    ]);
  });
});

describe("nextProgressTick", () => {
  it("re-exports the band from the barrel", () => {
    expect(EXPORTED_BAND).toBe(PROGRESS_BAND_PERCENT);
  });

  it("skips empty or incomplete work", () => {
    expect(nextProgressTick(0, 10, 0)).toBeNull();
    expect(nextProgressTick(1, 0, 0)).toBeNull();
    expect(nextProgressTick(-1, 10, 0)).toBeNull();
    expect(nextProgressTick(1, 10, 0, 0)).toBeNull();
    expect(nextProgressTick(Number.NaN, 10, 0)).toBeNull();
  });

  it("emits the first crossed band and ignores intra-band updates", () => {
    expect(nextProgressTick(1, 10, 0)).toBeNull();
    expect(nextProgressTick(2, 10, 0)).toEqual({ percent: 20, completed: 2, total: 10 });
    expect(nextProgressTick(3, 10, 20)).toBeNull();
    expect(nextProgressTick(4, 10, 20)).toEqual({ percent: 40, completed: 4, total: 10 });
  });

  it("clamps completed-over-total to 100%", () => {
    expect(nextProgressTick(12, 10, 80)).toEqual({ percent: 100, completed: 12, total: 10 });
  });

  it("never emits a decreasing or duplicate band for 50 totals", () => {
    for (let i = 0; i < 50; i += 1) {
      const total = 1 + ((i * 37) % 200);
      let last = 0;
      for (let completed = 0; completed <= total + 3; completed += 1) {
        const tick = nextProgressTick(completed, total, last);
        if (tick === null) {
          continue;
        }
        expect(tick.percent).toBeGreaterThan(last);
        expect(tick.percent % PROGRESS_BAND_PERCENT).toBe(0);
        expect(tick.percent).toBeLessThanOrEqual(100);
        last = tick.percent;
      }
    }
  });
});

describe("formatProgressLine / writeFlushedLine", () => {
  it("formats the issue example and flushes immediately", () => {
    const writes: string[] = [];
    let flushes = 0;
    const line = formatProgressLine({ percent: 20, completed: 412, total: 2060 });
    expect(line).toBe("ts:check-lane 20% (412/2060 files)");
    writeFlushedLine(line, {
      write: (chunk: string) => {
        writes.push(chunk);
      },
      flush: () => {
        flushes += 1;
      },
    });
    expect(writes).toEqual(["ts:check-lane 20% (412/2060 files)\n"]);
    expect(flushes).toBe(1);
  });

  it("falls back to writeSync when sink.write is missing", () => {
    const calls: Array<[number, string]> = [];
    writeFlushedLine("ts:check-lane 20% (1/5 files)", {} as never, {
      syncWrite: (fd, payload) => {
        calls.push([fd, payload]);
      },
    });
    expect(calls).toEqual([[1, "ts:check-lane 20% (1/5 files)\n"]]);
  });

  it("writeSyncs to stdout when no sink is given", () => {
    const calls: Array<[number, string]> = [];
    writeFlushedLine("ts:check-lane 20% (1/5 files)", undefined, {
      syncWrite: (fd, payload) => {
        calls.push([fd, payload]);
      },
    });
    expect(calls).toEqual([[1, "ts:check-lane 20% (1/5 files)\n"]]);
  });

  it("keeps an existing trailing newline and writeSyncs to the given fd", () => {
    const path = join(tmpdir(), `3470-progress-${process.pid}.txt`);
    const fd = openSync(path, "w");
    try {
      writeFlushedLine("already-terminated\n", undefined, { fd });
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, "utf8")).toBe("already-terminated\n");
    unlinkSync(path);
  });
});
