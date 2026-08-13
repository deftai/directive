import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  EMPTY_AC_CAUSE,
  EMPTY_AC_REMEDY,
  formatSoftEmptyMessage,
  isEmptyAcResolution,
  isSoftEmptyAcText,
  projectHasSuiteFloor,
} from "./empty-resolution.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

describe("empty verify:ac resolution (#3334)", () => {
  it("classifies zero-command results as empty and matches the soft_empty token", () => {
    expect(
      isEmptyAcResolution({
        ok: true,
        code: 0,
        runsLength: 0,
        commandCount: 0,
        rejectedCount: 0,
      }),
    ).toBe(true);
    expect(
      isEmptyAcResolution({
        ok: true,
        code: 0,
        runsLength: 0,
        commandCount: 1,
        rejectedCount: 0,
      }),
    ).toBe(false);
    expect(
      isEmptyAcResolution({
        ok: false,
        code: 2,
        runsLength: 0,
        commandCount: 0,
        rejectedCount: 0,
      }),
    ).toBe(false);
    expect(isSoftEmptyAcText("verify:ac soft_empty (#3334) [rung=project_floor]")).toBe(true);
    expect(isSoftEmptyAcText("verify:ac passed (#3284)")).toBe(false);
    const msg = formatSoftEmptyMessage({
      commands: [],
      none_stated: true,
      source_rung: "project_floor",
    });
    expect(msg).toContain(EMPTY_AC_CAUSE);
    expect(msg).toContain(EMPTY_AC_REMEDY);
    expect(msg).toMatch(/soft_empty \(#3334\)/);
  });

  it("fails closed on empty resolution when the project has no suite floor", () => {
    const root = mkdtempSync(join(tmpdir(), "empty-ac-consumer-"));
    const result = evaluateVerifyAcFromPlan(
      {
        title: "unstamped",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
      },
      { projectRoot: root, captureFromNarratives: false },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.resolution).toBe("soft_empty");
    expect(result.resolvedCommandCount).toBe(0);
    expect(result.message).toMatch(/soft_empty \(#3334\)/);
    expect(result.message).toContain(EMPTY_AC_CAUSE);
    expect(result.message).toContain(EMPTY_AC_REMEDY);
  });

  it("keeps the floor-pass when a suite floor exists", () => {
    const result = evaluateVerifyAcFromPlan(
      {
        title: "framework floor",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
      },
      { captureFromNarratives: false, hasSuiteFloor: true },
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.resolution).toBe("empty-pass");
    expect(result.resolvedCommandCount).toBe(0);
    expect(projectHasSuiteFloor(mkdtempSync(join(tmpdir(), "no-suite-")))).toBe(false);
  });

  it("classifies executed commands as verified-pass", () => {
    const result = evaluateVerifyAcFromPlan(
      {
        title: "ok",
        acceptance: {
          commands: [{ command: "true" }],
          none_stated: true,
          source_rung: "derived",
        },
        metadata: {},
      },
      {
        projectRoot: process.cwd(),
        runner: () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
        captureFromNarratives: false,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("verified-pass");
    expect(result.resolvedCommandCount).toBeGreaterThan(0);
  });

  it("emits an acceptance event that distinguishes verified-pass from empty-pass", () => {
    const root = mkdtempSync(join(tmpdir(), "empty-ac-tlm-"));
    const path = join(root, "summary.jsonl");
    evaluateVerifyAcFromPlan(
      {
        title: "empty consumer",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
      },
      {
        projectRoot: root,
        captureFromNarratives: false,
        env: { [ENV_RUN_SUMMARY_PATH]: path },
      },
    );
    const emptyLine = JSON.parse(
      (readFileSync(path, "utf8").trim().split(/\r?\n/).pop() ?? "{}") as string,
    ) as {
      event: string;
      payload: { outcome: string; resolved_command_count: number };
    };
    expect(emptyLine.event).toBe("acceptance");
    expect(emptyLine.payload.outcome).toBe("soft_empty");
    expect(emptyLine.payload.resolved_command_count).toBe(0);

    const suitePath = join(root, "suite.jsonl");
    evaluateVerifyAcFromPlan(
      {
        title: "framework empty",
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        items: [],
      },
      {
        captureFromNarratives: false,
        hasSuiteFloor: true,
        env: { [ENV_RUN_SUMMARY_PATH]: suitePath },
      },
    );
    const suiteLine = JSON.parse(readFileSync(suitePath, "utf8").trim()) as {
      event: string;
      payload: { outcome: string; resolved_command_count: number };
    };
    expect(suiteLine.event).toBe("acceptance");
    expect(suiteLine.payload.outcome).toBe("empty-pass");
    expect(suiteLine.payload.resolved_command_count).toBe(0);
  });

  it("emits acceptance from the path helper after the bank checkpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "empty-ac-bank-emit-"));
    const path = join(root, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [{ command: "true" }],
            none_stated: true,
            source_rung: "derived",
          },
          items: [],
        },
      }),
      "utf8",
    );
    const summary = join(root, "summary.jsonl");
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: root,
      captureFromNarratives: false,
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      env: { [ENV_RUN_SUMMARY_PATH]: summary },
    });
    expect(result.ok).toBe(true);
    const lines = readFileSync(summary, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l) as { event: string; payload: { outcome?: string } });
    const acceptance = lines.filter((l) => l.event === "acceptance");
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]?.payload.outcome).toBe("verified-pass");
  });
});
