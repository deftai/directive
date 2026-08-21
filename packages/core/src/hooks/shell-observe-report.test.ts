import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendShellObservation, buildShellObservation } from "./shell-observe.js";
import {
  formatShellObservationSummary,
  observedVerb,
  summarizeShellObservations,
  summarizeShellObservationsAt,
} from "./shell-observe-report.js";

const line = (over: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: 1,
    ts: "2026-08-21T00:00:00Z",
    host: "claude",
    toolName: "Bash",
    command: "true",
    commandTruncated: false,
    verdict: "allow",
    code: "shell-op-unclassifiable",
    destKinds: [],
    unresolvedDest: false,
    unrecognized: true,
    ...over,
  });

describe("shell observation report (#3438)", () => {
  it("separates the fail-open surface from the fail-closed one", () => {
    const summary = summarizeShellObservations([
      line({ command: "git reset --hard" }),
      line({ command: "mv a b" }),
      line({ command: "git status" }),
      line({
        command: "rm src/a.ts",
        verdict: "deny",
        code: "scope-not-ready",
        unrecognized: false,
        destKinds: ["rm"],
      }),
      line({
        command: "cd x && rm y",
        verdict: "deny",
        code: "scope-not-ready",
        unrecognized: false,
        unresolvedDest: true,
        destKinds: ["rm"],
      }),
      line({
        command: "rm /other/x",
        verdict: "allow",
        code: "write-ready",
        unrecognized: false,
        destKinds: ["rm"],
      }),
    ]);

    expect(summary).toMatchObject({
      total: 6,
      allowed: 4,
      denied: 2,
      allowedUnrecognized: 3,
      deniedUnresolved: 1,
      malformed: 0,
    });
    expect(summary.unrecognizedAllowRate).toBeCloseTo(0.75);
    expect(summary.unrecognizedVerbs).toEqual([
      ["git", 2],
      ["mv", 1],
    ]);
  });

  it("tolerates malformed and blank lines instead of throwing", () => {
    const summary = summarizeShellObservations([
      "",
      "not json",
      "{}",
      '{"verdict":"allow"}',
      line({ command: "rm -rf dist" }),
      "   ",
    ]);
    expect(summary.malformed).toBe(3);
    expect(summary.total).toBe(1);
    expect(summary.allowedUnrecognized).toBe(1);
  });

  it("ranks codes by frequency", () => {
    const summary = summarizeShellObservations([
      line({ code: "shell-op-unclassifiable" }),
      line({ code: "shell-op-unclassifiable" }),
      line({ code: "write-ready", unrecognized: false }),
    ]);
    expect(summary.byCode).toEqual([
      ["shell-op-unclassifiable", 2],
      ["write-ready", 1],
    ]);
  });

  it("skips leading env assignments when naming the verb", () => {
    expect(observedVerb("FOO=1 BAR=2 rm x")).toBe("rm");
    expect(observedVerb("  git reset --hard")).toBe("git");
    expect(observedVerb("")).toBe("");
  });

  it("summarizes a real log written by the observer, and an absent one as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-observe-report-"));
    expect(summarizeShellObservationsAt(root)).toMatchObject({ total: 0, allowed: 0 });

    appendShellObservation(
      root,
      buildShellObservation({
        ts: "2026-08-21T00:00:00Z",
        host: "claude",
        toolName: "Bash",
        command: "git clean -fd",
        verdict: "allow",
        code: "shell-op-unclassifiable",
        dests: [],
      }),
    );
    const summary = summarizeShellObservationsAt(root);
    expect(summary).toMatchObject({ total: 1, allowedUnrecognized: 1 });
    expect(summary.unrecognizedVerbs).toEqual([["git", 1]]);
  });

  it("renders a report naming the fail-open share", () => {
    const text = formatShellObservationSummary(
      summarizeShellObservations([
        line({ command: "git reset --hard" }),
        line({ command: "rm x", verdict: "deny", code: "scope-not-ready", unrecognized: false }),
      ]),
    );
    expect(text).toContain("fail-OPEN");
    // Denominator is ALLOWS, not total: the metric is "of what we let through,
    // how much did we not even recognize". One allow, unrecognized => 100%.
    expect(text).toContain("100.0% of allows");
    expect(text).toContain("git");
  });
});
