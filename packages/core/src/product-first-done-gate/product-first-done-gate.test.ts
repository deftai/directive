/**
 * Product-first done-gate tests (#3284).
 *
 * Schema, verify:ac evaluation, check-mode (AC-first / pressure / rapid).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachPlanAcceptance,
  buildAcceptanceFromIntakeCapture,
  readPlanAcceptance,
  stampAcceptanceFromLiteralCapture,
  validatePlanAcceptance,
} from "./acceptance.js";
import {
  applyProductFirstGateMode,
  isHygieneGate,
  isProductAcGate,
  resolveProductFirstCheckMode,
} from "./check-mode.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
  PRODUCT_AC_GATE_ID,
} from "./types.js";

describe("plan.acceptance schema (#3284)", () => {
  it("rejects empty commands without none_stated", () => {
    const errors = validatePlanAcceptance({ commands: [], none_stated: false });
    expect(errors.some((e) => e.includes("none_stated"))).toBe(true);
  });

  it("allows empty commands with none_stated true", () => {
    expect(
      validatePlanAcceptance({
        commands: [],
        none_stated: true,
        source_rung: "project_floor",
      }),
    ).toEqual([]);
  });

  it("buildAcceptanceFromIntakeCapture marks stated vs floor", () => {
    const stated = buildAcceptanceFromIntakeCapture([{ command: "pnpm test" }]);
    expect(stated.none_stated).toBe(false);
    expect(stated.source_rung).toBe("stated");
    expect(stated.commands).toHaveLength(1);

    const floor = buildAcceptanceFromIntakeCapture([]);
    expect(floor.none_stated).toBe(true);
    expect(floor.source_rung).toBe("project_floor");
  });

  it("stampAcceptanceFromLiteralCapture writes plan.acceptance", () => {
    const plan = stampAcceptanceFromLiteralCapture({
      title: "t",
      metadata: {
        literal_acceptance_commands: [{ command: "task verify:ac", source: "task_statement" }],
      },
    });
    const acc = readPlanAcceptance(plan);
    expect(acc.commands.map((c) => c.command)).toContain("task verify:ac");
    expect(acc.none_stated).toBe(false);
    expect(acc.source_rung).toBe("stated");
  });

  it("attachPlanAcceptance mirrors derived commands for execution", () => {
    const plan = attachPlanAcceptance(
      { title: "t", metadata: {} },
      {
        commands: [{ command: "true" }],
        none_stated: true,
        source_rung: "derived",
        derived_reason: "agent-authored AC",
      },
    );
    const acc = readPlanAcceptance(plan);
    expect(acc.source_rung).toBe("derived");
    expect(acc.none_stated).toBe(true);
    expect(acc.commands[0]?.command).toBe("true");
  });
});

describe("verify:ac evaluation (#3284)", () => {
  it("fails when product command fails even if hygiene would pass", () => {
    const plan = {
      title: "wrong product",
      acceptance: {
        commands: [{ command: "false", expectedExitCode: 0 }],
        none_stated: false,
        source_rung: "derived",
      },
      metadata: {
        // Executable peer so #3267 promotion gate is satisfied.
        literal_acceptance_commands: [
          { command: "false", source: "explicit", expectedExitCode: 0 },
        ],
      },
    };
    const result = evaluateVerifyAcFromPlan(plan, {
      projectRoot: process.cwd(),
      runner: () => ({ exitCode: 1, stdout: "", stderr: "product wrong" }),
      captureFromNarratives: false,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.sourceRung).toBe("derived");
  });

  it("passes derived commands that exit 0", () => {
    const plan = {
      title: "ok",
      acceptance: {
        commands: [{ command: "true" }],
        none_stated: true,
        source_rung: "derived",
      },
      metadata: {},
    };
    const result = evaluateVerifyAcFromPlan(plan, {
      projectRoot: process.cwd(),
      runner: () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
      captureFromNarratives: false,
    });
    expect(result.ok).toBe(true);
    expect(result.sourceRung).toBe("derived");
    expect(result.message).toMatch(/rung=derived/);
  });

  it("soft-missing xbrief exits 0 in check mode", () => {
    const result = evaluateVerifyAcFromPath(join(tmpdir(), "no-such-xbrief-3284.json"), {
      softMissingXbrief: true,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it("reads acceptance from xBRIEF path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-xbrief-"));
    const path = join(dir, "story.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "project_floor",
          },
          items: [],
        },
      }),
      "utf8",
    );
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: dir,
      quiet: false,
    });
    expect(result.ok).toBe(true);
    expect(result.sourceRung).toBe("project_floor");
  });

  it("schema error on contradictory acceptance is config exit 2", () => {
    const plan = {
      title: "bad",
      acceptance: {
        commands: [{ command: "true" }],
        none_stated: true,
        source_rung: "stated",
      },
    };
    const result = evaluateVerifyAcFromPlan(plan, { captureFromNarratives: false });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });

  it("check-integrated soft-passes unpromoted task_statement capture-only", () => {
    const plan = {
      title: "mid-flight story",
      acceptance: {
        commands: [{ command: "pnpm exec vitest run packages/core/src" }],
        none_stated: false,
        source_rung: "stated",
      },
      metadata: {
        literal_acceptance_commands: [
          { command: "pnpm exec vitest run packages/core/src", source: "task_statement" },
        ],
      },
    };
    const standalone = evaluateVerifyAcFromPlan(plan, { captureFromNarratives: false });
    expect(standalone.ok).toBe(false);
    const integrated = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      checkIntegrated: true,
    });
    expect(integrated.ok).toBe(true);
    expect(integrated.message).toMatch(/check-integrated|capture-only/i);
  });
});

describe("check mode (#3284)", () => {
  it("defaults to full", () => {
    const r = resolveProductFirstCheckMode({
      environ: {},
      ceremonyDepth: null,
      hardBudgetDetected: false,
    });
    expect(r.mode).toBe("full");
    expect(r.acOnly).toBe(false);
    expect(r.hygieneAdvisory).toBe(false);
    expect(r.acMandatory).toBe(true);
  });

  it("DEFT_CHECK_AC_ONLY and rapid ceremony select rapid AC-only", () => {
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_CHECK_AC_ONLY]: "1" },
        hardBudgetDetected: false,
      }).mode,
    ).toBe("rapid");
    expect(
      resolveProductFirstCheckMode({
        environ: {},
        ceremonyDepth: "rapid",
        hardBudgetDetected: false,
      }).acOnly,
    ).toBe(true);
    expect(
      resolveProductFirstCheckMode({
        environ: {},
        ceremonyDepth: "minimal",
        hardBudgetDetected: false,
      }).mode,
    ).toBe("rapid");
  });

  it("pressure/degraded and hard budget make hygiene advisory", () => {
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_CHECK_MODE]: "pressure" },
        hardBudgetDetected: false,
      }).hygieneAdvisory,
    ).toBe(true);
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_HYGIENE_ADVISORY]: "yes" },
        hardBudgetDetected: false,
      }).mode,
    ).toBe("pressure");
    expect(
      resolveProductFirstCheckMode({
        environ: {},
        ceremonyDepth: "standard",
        hardBudgetDetected: true,
      }).mode,
    ).toBe("pressure");
  });

  it("applyProductFirstGateMode keeps only AC under rapid", () => {
    const gates = [PRODUCT_AC_GATE_ID, "verify:branch", "ts:check-lane"] as const;
    expect(applyProductFirstGateMode(gates, "rapid")).toEqual([PRODUCT_AC_GATE_ID]);
    expect(applyProductFirstGateMode(gates, "full")).toEqual([...gates]);
    expect(applyProductFirstGateMode(gates, "pressure")).toEqual([...gates]);
  });

  it("classifies product vs hygiene gates", () => {
    expect(isProductAcGate("verify:ac")).toBe(true);
    expect(isProductAcGate("verify:literal-ac")).toBe(true);
    expect(isHygieneGate("verify:branch")).toBe(true);
    expect(isHygieneGate("verify:ac")).toBe(false);
  });
});

describe("product-first gate ordering contract (#3284)", () => {
  it("PRODUCT_AC_GATE_ID is verify:ac", () => {
    expect(PRODUCT_AC_GATE_ID).toBe("verify:ac");
  });

  it("failing AC is ordered before hygiene in a simulated sequence", () => {
    // Simulate check composition: AC first; if AC fails, hygiene never runs.
    const order = applyProductFirstGateMode(
      ["verify:ac", "verify:branch", "doctor"] as const,
      "full",
    );
    expect(order[0]).toBe("verify:ac");

    const ac = evaluateVerifyAcFromPlan(
      {
        title: "bad product",
        acceptance: {
          commands: [{ command: "echo should-fail" }],
          none_stated: false,
          source_rung: "derived",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "echo should-fail", source: "explicit" }],
        },
      },
      {
        runner: () => ({ exitCode: 1, stdout: "wrong", stderr: "" }),
        captureFromNarratives: false,
      },
    );
    expect(ac.ok).toBe(false);
    // Hygiene would be green in this scenario — product still fails overall.
    const hygieneWouldPass = true;
    expect(hygieneWouldPass && !ac.ok).toBe(true);
  });

  it("finds single active xbrief layout for path evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-active-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, "s.xbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          acceptance: {
            commands: [{ command: "true" }],
            none_stated: true,
            source_rung: "derived",
          },
          metadata: {},
          items: [],
        },
      }),
      "utf8",
    );
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: root,
      runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      captureFromNarratives: false,
    });
    expect(result.ok).toBe(true);
  });
});
