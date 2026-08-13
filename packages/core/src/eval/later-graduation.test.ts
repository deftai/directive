import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RUN_SUMMARY_BASENAME, ENV_RUN_SUMMARY_PATH } from "../run-summary/types.js";
import {
  evaluateLaterGraduationTrigger,
  LATER_GRADUATION_SHARE_THRESHOLD,
  laterGraduationFromShare,
  resolveRunSummaryReadPath,
} from "./later-graduation.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("laterGraduationFromShare (#3320)", () => {
  it("graduates at or above the 25% threshold", () => {
    const trigger = laterGraduationFromShare({
      evaluable: true,
      ritualGateCount: 8,
      totalToolTurns: 32,
      share: 0.25,
    });
    expect(trigger.verdict).toBe("graduate");
    expect(trigger.evaluable).toBe(true);
    expect(trigger.summary).toMatch(/ritual\+gate share 25\.0%/);
    expect(trigger.threshold).toBe(LATER_GRADUATION_SHARE_THRESHOLD);
  });

  it("declines below the threshold without inventing a different ratio", () => {
    const trigger = laterGraduationFromShare({
      evaluable: true,
      ritualGateCount: 2,
      totalToolTurns: 20,
      share: 0.1,
    });
    expect(trigger.verdict).toBe("do-not-graduate");
    expect(trigger.summary).toMatch(/10\.0%/);
    expect(trigger.summary).toMatch(/2\/20/);
  });

  it("treats evaluable=true with a null share as unevaluable", () => {
    const trigger = laterGraduationFromShare({
      evaluable: true,
      ritualGateCount: 1,
      totalToolTurns: null,
      share: null,
    });
    expect(trigger.verdict).toBe("unevaluable");
  });

  it("reports trigger unevaluable when the denominator is missing", () => {
    const trigger = laterGraduationFromShare({
      evaluable: false,
      ritualGateCount: 6,
      totalToolTurns: null,
      share: null,
    });
    expect(trigger.verdict).toBe("unevaluable");
    expect(trigger.summary).toMatch(/trigger unevaluable/);
    expect(trigger.share).toBeNull();
  });
});

describe("evaluateLaterGraduationTrigger (#3320)", () => {
  it("reads share from a run-summary file and does not invent one from counts", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-later-grad-"));
    temps.push(root);
    const withDenom = join(root, "with.jsonl");
    writeFileSync(
      withDenom,
      `${JSON.stringify({ event: "check_invocation", session_id: "s", payload: {} })}\n${JSON.stringify({ event: "tool_turn_denominator", session_id: "s", payload: { total_tool_turns: 4 } })}\n`,
      "utf8",
    );
    const present = evaluateLaterGraduationTrigger({
      projectRoot: root,
      runSummaryPath: withDenom,
      env: {},
    });
    expect(present.evaluable).toBe(true);
    expect(present.share).toBe(0.25);
    expect(present.verdict).toBe("graduate");

    const countsOnly = join(root, "counts.jsonl");
    writeFileSync(
      countsOnly,
      `${JSON.stringify({ event: "check_invocation", session_id: "s", payload: {} })}\n${JSON.stringify({ event: "check_invocation", session_id: "s", payload: {} })}\n`,
      "utf8",
    );
    const absent = evaluateLaterGraduationTrigger({
      projectRoot: root,
      runSummaryPath: countsOnly,
      env: {},
    });
    expect(absent.verdict).toBe("unevaluable");
    expect(absent.share).toBeNull();
  });

  it("is unevaluable when DEFT_RUN_SUMMARY_PATH is unset and no default file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-later-unset-"));
    temps.push(root);
    const trigger = evaluateLaterGraduationTrigger({ projectRoot: root, env: {} });
    expect(trigger.verdict).toBe("unevaluable");
  });

  it("resolves env path, stdout dest, default file, and missing explicit file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-later-paths-"));
    temps.push(root);
    expect(resolveRunSummaryReadPath(root, { env: { [ENV_RUN_SUMMARY_PATH]: "-" } })).toBeNull();
    expect(resolveRunSummaryReadPath(root, { runSummaryPath: "   ", env: {} })).toBeNull();
    const rel = resolveRunSummaryReadPath(root, { env: { [ENV_RUN_SUMMARY_PATH]: "out.jsonl" } });
    expect(rel).toBe(join(root, "out.jsonl"));
    const abs = join(root, "abs.jsonl");
    expect(resolveRunSummaryReadPath(root, { env: { [ENV_RUN_SUMMARY_PATH]: abs } })).toBe(abs);
    writeFileSync(join(root, DEFAULT_RUN_SUMMARY_BASENAME), "{}\n", "utf8");
    expect(resolveRunSummaryReadPath(root, { env: {} })).toBe(
      join(root, DEFAULT_RUN_SUMMARY_BASENAME),
    );
    const missing = evaluateLaterGraduationTrigger({
      projectRoot: root,
      runSummaryPath: join(root, "does-not-exist.jsonl"),
      env: {},
    });
    expect(missing.verdict).toBe("unevaluable");
  });
});
