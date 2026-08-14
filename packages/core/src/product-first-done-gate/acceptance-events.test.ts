/**
 * Field-stream acceptance telemetry (#3355).
 *
 * Hand-authored briefs never call issue:ingest. verify:ac must still emit
 * acceptance_stamp from observed plan.acceptance and an acceptance outcome
 * on every terminal path.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import { evaluateAcceptanceActivateGate } from "../scope/acceptance-activate-gate.js";
import { runTransition } from "../scope/transition.js";
import { formatBriefJson } from "../scope/vbrief-json.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

function parseJsonl(path: string): { event: string; payload: Record<string, unknown> }[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown> });
}

function writeBrief(path: string, data: unknown): void {
  writeFileSync(path, formatBriefJson(data), "utf8");
}

describe("verify:ac terminal acceptance outcomes (#3355)", () => {
  it("emits config-error, soft-missing, soft_empty, run-pass, and run-fail", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3355-outcomes-"));
    const cases: {
      readonly name: string;
      readonly outcome: string;
      readonly run: (summary: string) => void;
    }[] = [
      {
        name: "config-error",
        outcome: "config-error",
        run: (summary) => {
          evaluateVerifyAcFromPlan(
            {
              title: "bad",
              acceptance: {
                commands: [{ command: "true" }],
                none_stated: true,
                source_rung: "stated",
              },
            },
            { captureFromNarratives: false, env: { [ENV_RUN_SUMMARY_PATH]: summary } },
          );
        },
      },
      {
        name: "soft-missing",
        outcome: "soft-missing",
        run: (summary) => {
          evaluateVerifyAcFromPath(join(root, "missing.xbrief.json"), {
            projectRoot: root,
            softMissingXbrief: true,
            env: { [ENV_RUN_SUMMARY_PATH]: summary },
          });
        },
      },
      {
        name: "soft-empty",
        outcome: "soft_empty",
        run: (summary) => {
          evaluateVerifyAcFromPlan(
            {
              title: "empty consumer",
              acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
              items: [],
            },
            {
              projectRoot: root,
              captureFromNarratives: false,
              env: { [ENV_RUN_SUMMARY_PATH]: summary },
            },
          );
        },
      },
      {
        name: "run-pass",
        outcome: "verified-pass",
        run: (summary) => {
          evaluateVerifyAcFromPlan(
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
              projectRoot: root,
              captureFromNarratives: false,
              runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
              env: { [ENV_RUN_SUMMARY_PATH]: summary },
            },
          );
        },
      },
      {
        name: "run-fail",
        outcome: "fail",
        run: (summary) => {
          evaluateVerifyAcFromPlan(
            {
              title: "wrong",
              acceptance: {
                commands: [{ command: "false" }],
                none_stated: false,
                source_rung: "derived",
              },
              metadata: {
                literal_acceptance_commands: [{ command: "false", source: "explicit" }],
              },
            },
            {
              projectRoot: root,
              captureFromNarratives: false,
              runner: () => ({ exitCode: 1, stdout: "", stderr: "no" }),
              env: { [ENV_RUN_SUMMARY_PATH]: summary },
            },
          );
        },
      },
    ];

    for (const row of cases) {
      const summary = join(root, `${row.name}.jsonl`);
      row.run(summary);
      const acceptance = parseJsonl(summary).filter((line) => line.event === "acceptance");
      expect(acceptance, row.name).toHaveLength(1);
      expect(acceptance[0]?.payload.outcome, row.name).toBe(row.outcome);
    }
  });
});

describe("trial-shaped hand-authored acceptance stream (#3355)", () => {
  it("hand-authored brief → #3334 refuse → stamp → verify emits both event kinds", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3355-trial-"));
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    const summary = join(root, "summary.jsonl");
    const path = join(root, "xbrief", "pending", "trial.xbrief.json");
    writeBrief(path, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "plain trial",
        status: "pending",
        narratives: {
          Test: "manual steps live only in this narrative",
          Overview: "narrative without a list or path",
        },
        items: [],
      },
    });

    const refused = runTransition("activate", path);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/#3334/);
    expect(evaluateAcceptanceActivateGate({ narratives: { Test: "manual" } }).ok).toBe(false);

    writeBrief(path, {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "plain trial",
        status: "pending",
        narratives: {
          Test: "manual steps live only in this narrative",
          Overview: "narrative without a list or path",
        },
        acceptance: {
          commands: [{ command: "true" }],
          none_stated: true,
          source_rung: "derived",
          derived_reason: "hand-stamped mid-run (#3355)",
        },
        items: [],
      },
    });

    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: root,
      captureFromNarratives: false,
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      env: { [ENV_RUN_SUMMARY_PATH]: summary },
    });
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("verified-pass");

    const lines = parseJsonl(summary);
    const stamps = lines.filter((line) => line.event === "acceptance_stamp");
    const outcomes = lines.filter((line) => line.event === "acceptance");
    expect(stamps.length).toBeGreaterThanOrEqual(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload.outcome).toBe("verified-pass");
    expect(stamps[0]?.payload.rung).toBe("derived");
    expect(stamps[0]?.payload.command_count).toBe(1);
  });
});
