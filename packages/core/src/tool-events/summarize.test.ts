import { describe, expect, it } from "vitest";
import {
  countToolEventBuckets,
  detectToolEventAnomalies,
  emptyBucketCounts,
  formatToolEventAnomalyLine,
  formatToolEventStatusLine,
  summarizeToolEvents,
} from "./summarize.js";
import type { ToolEventInput } from "./types.js";

describe("summarizeToolEvents (#2967)", () => {
  it("counts buckets and builds a status line", () => {
    const events: ToolEventInput[] = [
      { name: "Read" },
      { name: "Grep" },
      { name: "Write" },
      { name: "Shell", command: "vitest run" },
      { name: "Task" },
      { name: "Mystery" },
    ];
    const summary = summarizeToolEvents(events);
    expect(summary.total).toBe(6);
    expect(summary.counts).toEqual({
      explore: 2,
      commit: 1,
      verify: 1,
      coordinate: 1,
      unknown: 1,
    });
    expect(summary.statusLine).toBe("tools: explore=2 commit=1 verify=1 coordinate=1 unknown=1");
    expect(summary.anomalies).toEqual([]);
  });

  it("flags commit-without-explore and verify-skipped", () => {
    const events: ToolEventInput[] = [
      { name: "Write" },
      { name: "Shell", command: "git commit -m x" },
    ];
    const summary = summarizeToolEvents(events);
    expect(summary.counts.commit).toBe(2);
    expect(summary.counts.explore).toBe(0);
    expect(summary.counts.verify).toBe(0);
    const codes = summary.anomalies.map((a) => a.code);
    expect(codes).toContain("commit-without-explore");
    expect(codes).toContain("verify-skipped");
    expect(summary.statusLine).toContain("anomalies: commit-without-explore,verify-skipped");
  });

  it("flags explore-only thrash when enough explore and no commit/verify", () => {
    const events: ToolEventInput[] = [{ name: "Read" }, { name: "Grep" }, { name: "Glob" }];
    const summary = summarizeToolEvents(events);
    expect(summary.anomalies.map((a) => a.code)).toEqual(["explore-only"]);
  });

  it("does not flag explore-only for tiny sessions", () => {
    const events: ToolEventInput[] = [{ name: "Read" }, { name: "Grep" }];
    const summary = summarizeToolEvents(events);
    expect(summary.anomalies).toEqual([]);
  });

  it("healthy explore+commit+verify has no anomalies", () => {
    const events: ToolEventInput[] = [
      { name: "Read" },
      { name: "Write" },
      { name: "Shell", command: "task check" },
    ];
    expect(summarizeToolEvents(events).anomalies).toEqual([]);
  });
});

describe("format helpers", () => {
  it("emptyBucketCounts is all zeros", () => {
    expect(emptyBucketCounts()).toEqual({
      explore: 0,
      commit: 0,
      verify: 0,
      coordinate: 0,
      unknown: 0,
    });
  });

  it("formatToolEventStatusLine uses stable bucket order", () => {
    const counts = countToolEventBuckets([{ name: "Write" }]);
    expect(formatToolEventStatusLine(counts)).toBe(
      "tools: explore=0 commit=1 verify=0 coordinate=0 unknown=0",
    );
  });

  it("formatToolEventAnomalyLine is empty without anomalies", () => {
    expect(formatToolEventAnomalyLine([])).toBe("");
  });

  it("detectToolEventAnomalies is pure over counts", () => {
    const a = detectToolEventAnomalies({
      explore: 0,
      commit: 1,
      verify: 0,
      coordinate: 0,
      unknown: 0,
    });
    expect(a.map((x) => x.code)).toEqual(["commit-without-explore", "verify-skipped"]);
  });
});
