import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gcStaleSha12Dirs, teardownSink, writeInvocationSink } from "./sink.js";
import type { EvaluateResult } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sampleResult(projectRoot: string): EvaluateResult {
  return {
    sha12: "abc123def456",
    invocationId: "inv",
    originSha: "abc123def4567890",
    sinkDir: join(projectRoot, ".deft-scratch", "issue-eval", "abc123def456", "inv"),
    concurrency: 4,
    verdicts: [
      {
        issue: 1,
        sha12: "abc123def456",
        invocationId: "inv",
        validity: null,
        wip: [],
        github: null,
        openPulls: [],
        duplicates: [],
        value: { "critique-recommend": false, reason: "none" },
        error: null,
      },
    ],
  };
}

describe("issue-eval sink", () => {
  it("writes manifest and per-issue verdicts then GCs stale sha12 dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "sink-"));
    temps.push(root);
    const stale = join(root, ".deft-scratch", "issue-eval", "deadbeefdead");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "old.json"), "{}", "utf8");
    const dir = writeInvocationSink(root, sampleResult(root));
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "issue-1.json"), "utf8")).issue).toBe(1);
    expect(gcStaleSha12Dirs(root, "abc123def456")).toEqual(["deadbeefdead"]);
    expect(existsSync(stale)).toBe(false);
    teardownSink(root, "abc123def456", "inv");
    expect(existsSync(dir)).toBe(false);
  });
});
