import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import { deriveAcceptanceClauses } from "../verify-ac/clauses.js";
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
    expect(EMPTY_AC_REMEDY).toMatch(/via clause derivation/);
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
    const suiteLines = readFileSync(suitePath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            payload: { outcome?: string; resolved_command_count?: number };
          },
      );
    const suiteLine = suiteLines.find((l) => l.event === "acceptance");
    expect(suiteLine?.event).toBe("acceptance");
    expect(suiteLine?.payload.outcome).toBe("empty-pass");
    expect(suiteLine?.payload.resolved_command_count).toBe(0);
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

describe("verify:ac check-integrated narrative recapture (#3323)", () => {
  it("does not fail the check graph on backtick verify:ac prose when the stamped ledger is empty", () => {
    const result = evaluateVerifyAcFromPlan(
      {
        title: "prose",
        narratives: {
          Overview: "Done-time clause walk. `verify:ac` walks every clause. none_stated: true.",
        },
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
        metadata: { literal_acceptance_commands: [], literal_acceptance_rejected: [] },
        items: [],
      },
      { checkIntegrated: true, captureFromNarratives: undefined, hasSuiteFloor: true },
    );
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("empty-pass");
    expect(result.message).not.toMatch(/safety-rejected/);
  });
});

describe("verify:ac clause walk (#3323)", () => {
  it("walks stamped clauses and leads the done report with failed/unverifiable", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-ac-eval-"));
    writeFileSync(join(root, "shipped.ts"), "export const ok = true;\n", "utf8");
    const clauses = deriveAcceptanceClauses(`
## Acceptance Criteria
- shipped.ts exists at the stated path
- behavioral contract with no machine check against shipped.ts
- missing.ts must exist
`);
    const result = evaluateVerifyAcFromPlan(
      {
        title: "derived",
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
          clauses,
        },
        items: [],
      },
      { projectRoot: root, captureFromNarratives: false },
    );
    expect(result.clauseWalked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("fail");
    expect(result.message).toMatch(/\[failed\]/);
    expect(result.message).toMatch(/\[unverifiable\]/);
    expect(result.message.indexOf("[failed]")).toBeLessThan(result.message.indexOf("[verified]"));
    expect(result.clauseOutcomes?.map((c) => c.outcome)).toEqual([
      "verified",
      "unverifiable",
      "failed",
    ]);
  });

  it("does not treat a successful clause walk as #3334 empty resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "clause-ac-pass-"));
    writeFileSync(join(root, "CHANGELOG.md"), "- cites #3323\n", "utf8");
    const clauses = deriveAcceptanceClauses(
      "## Acceptance Criteria\n- CHANGELOG.md exists and cites the issue\n",
    );
    const summary = join(root, "summary.jsonl");
    const result = evaluateVerifyAcFromPlan(
      {
        title: "derived pass",
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
          clauses,
        },
        items: [],
      },
      {
        projectRoot: root,
        captureFromNarratives: false,
        env: { [ENV_RUN_SUMMARY_PATH]: summary },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("verified-pass");
    expect(result.message).not.toMatch(/soft_empty/);
    const lines = readFileSync(summary, "utf8")
      .trim()
      .split(/\r?\n/)
      .map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            payload: { source_rung?: string; clause_count?: number };
          },
      );
    const acceptance = lines.find((l) => l.event === "acceptance");
    expect(acceptance?.payload.source_rung).toBe("derived");
    expect(acceptance?.payload.clause_count).toBe(1);
  });
});
