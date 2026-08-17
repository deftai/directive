/**
 * No-op denylist + stated-span provenance (#3396).
 *
 * Field sequence: real commands fail the walk, then a no-op restamp is refused.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAcceptanceFromIntakeCapture,
  evaluateVerifyAcFromPlan,
  stampAcceptanceFromLiteralCapture,
} from "../product-first-done-gate/index.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  captureLiteralAcceptanceCommandsDetailed,
  evaluateCommandSafety,
  evaluateNoopDenylist,
  evaluateStampAcceptanceSafety,
  isVerbatimStatementSpan,
  NOOP_ACCEPTANCE_REMEDIATION,
  REJECTED_NOOP_OUTCOME,
} from "./index.js";

const REAL_COMMAND = "pnpm exec vitest run packages/core/src/literal-acceptance";

describe("no-op denylist (#3396)", () => {
  it.each([
    "true",
    ":",
    "false",
    "exit",
    "echo",
    "echo ok",
    "printf hi",
    "test 1 -eq 1",
    "test a = a",
  ])("refuses %s at capture safety", (command) => {
    const result = evaluateCommandSafety(command);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(REJECTED_NOOP_OUTCOME);
    expect(result.reason).toBe(NOOP_ACCEPTANCE_REMEDIATION);
    expect(evaluateNoopDenylist(command).ok).toBe(false);
  });

  it("leaves empty strings to the empty-command gate", () => {
    expect(evaluateNoopDenylist("").ok).toBe(true);
    expect(evaluateNoopDenylist("   ").ok).toBe(true);
  });

  it("fails closed when intake stamp is given a no-op command list", () => {
    expect(() => buildAcceptanceFromIntakeCapture([{ command: "true" }])).toThrow(
      /must be able to fail/,
    );
  });

  it("does not treat file-test assertions as no-ops", () => {
    expect(evaluateNoopDenylist("test -f src/product.ts").ok).toBe(true);
    expect(evaluateCommandSafety("test -f src/product.ts").ok).toBe(false);
    expect(evaluateCommandSafety("test -f src/product.ts").reason).not.toBe(
      NOOP_ACCEPTANCE_REMEDIATION,
    );
  });

  it("capture records denylisted no-ops on the rejected ledger", () => {
    const captured = captureLiteralAcceptanceCommandsDetailed("verify: true\nverify: task check");
    expect(captured.commands.map((c) => c.command)).toEqual(["task check"]);
    expect(captured.rejected.some((r) => r.command === "true")).toBe(true);
    expect(captured.rejected[0]?.reason).toBe(NOOP_ACCEPTANCE_REMEDIATION);
  });
});

describe("stated requires a verbatim statement span (#3396)", () => {
  it("recognizes capture spans and rejects metadata mirrors", () => {
    expect(isVerbatimStatementSpan("fence@L12:bash")).toBe(true);
    expect(isVerbatimStatementSpan("labeled@L3")).toBe(true);
    expect(isVerbatimStatementSpan("prompt@L8")).toBe(true);
    expect(isVerbatimStatementSpan("inline@L2")).toBe(true);
    expect(isVerbatimStatementSpan("plan.acceptance.commands")).toBe(false);
    expect(isVerbatimStatementSpan("metadata.literal_acceptance")).toBe(false);
    expect(isVerbatimStatementSpan(null)).toBe(false);
  });

  it("stamps stated only when capture recorded a statement span", () => {
    const stated = evaluateStampAcceptanceSafety({
      commands: [
        {
          command: REAL_COMMAND,
          source: "task_statement",
          sourceSpan: "fence@L10:bash",
        },
      ],
    });
    expect(stated.ok).toBe(true);
    expect(stated.sourceRung).toBe("stated");
    expect(stated.hasVerbatimStatementSpan).toBe(true);

    const derived = evaluateStampAcceptanceSafety({
      commands: [{ command: REAL_COMMAND, source: "explicit" }],
    });
    expect(derived.ok).toBe(true);
    expect(derived.sourceRung).toBe("derived");
    expect(derived.hasVerbatimStatementSpan).toBe(false);
  });

  it("does not raise the rung on a restamp without new provenance", () => {
    const restamp = evaluateStampAcceptanceSafety({
      commands: [
        { command: "task check", source: "explicit", sourceSpan: "plan.acceptance.commands" },
      ],
      previousRung: "project_floor",
    });
    expect(restamp.ok).toBe(true);
    expect(restamp.sourceRung).toBe("derived");
    expect(restamp.sourceRung).not.toBe("stated");
  });
});

describe("field sequence: fail then no-op restamp (#3396)", () => {
  it("refuses a no-op restamp after a failing real-command walk", () => {
    const first = evaluateStampAcceptanceSafety({
      commands: [
        {
          command: REAL_COMMAND,
          source: "task_statement",
          sourceSpan: "labeled@L4",
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(first.sourceRung).toBe("stated");

    const walk = evaluateVerifyAcFromPlan(
      {
        title: "field trial",
        acceptance: {
          commands: [{ command: REAL_COMMAND }],
          none_stated: false,
          source_rung: "stated",
        },
        metadata: {
          literal_acceptance_commands: [{ command: REAL_COMMAND, source: "explicit" }],
        },
      },
      {
        projectRoot: process.cwd(),
        captureFromNarratives: false,
        runner: () => ({ exitCode: 1, stdout: "", stderr: "product wrong" }),
      },
    );
    expect(walk.ok).toBe(false);
    expect(walk.resolution).toBe("fail");

    const restamp = evaluateStampAcceptanceSafety({
      commands: [{ command: "true" }],
      previousRung: walk.sourceRung,
    });
    expect(restamp.ok).toBe(false);
    expect(restamp.outcome).toBe(REJECTED_NOOP_OUTCOME);
    expect(restamp.reason).toBe(NOOP_ACCEPTANCE_REMEDIATION);

    const fromStrings = stampAcceptanceFromLiteralCapture({
      title: "string list",
      metadata: { literal_acceptance_commands: ["task check"] },
    });
    expect(fromStrings.acceptance).toMatchObject({ source_rung: "derived" });

    expect(() =>
      stampAcceptanceFromLiteralCapture({
        title: "field trial restamp",
        acceptance: {
          commands: [{ command: "true" }],
          none_stated: false,
          source_rung: "stated",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "true", source: "explicit" }],
        },
      }),
    ).toThrow(/must be able to fail/);

    const dir = mkdtempSync(join(tmpdir(), "deft-3396-seq-"));
    const summary = join(dir, "summary.jsonl");
    writeFileSync(summary, "", "utf8");
    const refused = evaluateVerifyAcFromPlan(
      {
        title: "field trial restamp",
        acceptance: {
          commands: [{ command: "true" }],
          none_stated: false,
          source_rung: "stated",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "true", source: "explicit" }],
        },
      },
      {
        projectRoot: dir,
        captureFromNarratives: false,
        env: { [ENV_RUN_SUMMARY_PATH]: summary },
        runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    );
    expect(refused.ok).toBe(false);
    expect(refused.resolution).toBe("rejected-noop");
    expect(refused.message).toMatch(/must be able to fail/);

    const last = readFileSync(summary, "utf8").trim().split(/\r?\n/).pop() ?? "{}";
    const line = JSON.parse(last) as { event?: string; payload?: { outcome?: string } };
    expect(line.event).toBe("acceptance");
    expect(line.payload?.outcome).toBe("rejected-noop");
  });
});
