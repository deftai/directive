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
import {
  evaluateVerifyAcFromPath,
  evaluateVerifyAcFromPlan,
  isVerifyAcRequiredAtCeremonyDepth,
  resolveOracleScopeKey,
} from "./evaluate.js";
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
    const stated = buildAcceptanceFromIntakeCapture([{ command: "pnpm test" }], {
      hasVerbatimStatementSpan: true,
    });
    expect(stated.none_stated).toBe(false);
    expect(stated.source_rung).toBe("stated");
    expect(stated.commands).toHaveLength(1);
    const derived = buildAcceptanceFromIntakeCapture([{ command: "pnpm test" }]);
    expect(derived.source_rung).toBe("derived");

    const floor = buildAcceptanceFromIntakeCapture([]);
    expect(floor.none_stated).toBe(true);
    expect(floor.source_rung).toBe("project_floor");
  });

  it("stampAcceptanceFromLiteralCapture writes plan.acceptance", () => {
    const plan = stampAcceptanceFromLiteralCapture({
      title: "t",
      metadata: {
        literal_acceptance_commands: [
          {
            command: "task verify:ac",
            source: "task_statement",
            sourceSpan: "labeled@L1",
          },
        ],
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
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "derived",
        derived_reason: "agent-authored AC",
      },
    );
    const acc = readPlanAcceptance(plan);
    expect(acc.source_rung).toBe("derived");
    expect(acc.none_stated).toBe(true);
    expect(acc.commands[0]?.command).toBe("task check");
  });
});

describe("verify:ac evaluation (#3284)", () => {
  it("fails when product command fails even if hygiene would pass", () => {
    const plan = {
      title: "wrong product",
      acceptance: {
        commands: [{ command: "task check", expectedExitCode: 0 }],
        none_stated: false,
        source_rung: "derived",
      },
      metadata: {
        // Executable peer so #3267 promotion gate is satisfied.
        literal_acceptance_commands: [
          { command: "task check", source: "explicit", expectedExitCode: 0 },
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
        commands: [{ command: "task check" }],
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
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.resolution).toBe("soft_empty");
    expect(result.sourceRung).toBe("project_floor");
    const suite = evaluateVerifyAcFromPath(path, {
      projectRoot: dir,
      quiet: false,
      hasSuiteFloor: true,
    });
    expect(suite.ok).toBe(true);
    expect(suite.resolution).toBe("empty-pass");
  });

  it("schema error on contradictory acceptance is config exit 2", () => {
    const plan = {
      title: "bad",
      acceptance: {
        commands: [{ command: "task check" }],
        none_stated: true,
        source_rung: "stated",
      },
    };
    const result = evaluateVerifyAcFromPlan(plan, { captureFromNarratives: false });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });

  it("runs stated plan.acceptance.commands when the literal ledger is empty (#3449)", () => {
    const command = "pnpm exec vitest run packages/core/src/check";
    const ran: string[] = [];
    const result = evaluateVerifyAcFromPlan(
      {
        title: "stated ledger-empty",
        acceptance: {
          commands: [{ command }],
          none_stated: false,
          source_rung: "stated",
        },
        metadata: {},
      },
      {
        projectRoot: process.cwd(),
        runner: ({ command: cmd }) => {
          ran.push(cmd);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        captureFromNarratives: false,
        hasSuiteFloor: true,
        bankOnPass: false,
        reuseMode: "never",
      },
    );
    expect(ran).toEqual([command]);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.runs).toHaveLength(1);
  });

  it("runs stated plan.acceptance.commands even when the ledger is unpromoted (#3449)", () => {
    const command = "pnpm exec vitest run packages/core/src";
    const plan = {
      title: "mid-flight story",
      acceptance: {
        commands: [{ command }],
        none_stated: false,
        source_rung: "stated",
      },
      metadata: {
        literal_acceptance_commands: [{ command, source: "task_statement" }],
      },
    };
    const runner = () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const standalone = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      runner,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(standalone.ok).toBe(true);
    expect(standalone.code).toBe(0);
    expect(standalone.runs.length).toBe(1);
    const integrated = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      checkIntegrated: true,
      runner,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(integrated.ok).toBe(true);
    expect(integrated.runs.length).toBe(1);
  });

  it("check-integrated still soft-passes ledger-only unpromoted capture (#3449)", () => {
    const plan = {
      title: "ledger only",
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "project_floor",
      },
      metadata: {
        literal_acceptance_commands: [
          { command: "pnpm exec vitest run packages/core/src", source: "task_statement" },
        ],
      },
    };
    const standalone = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(standalone.ok).toBe(false);
    const integrated = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      checkIntegrated: true,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(integrated.ok).toBe(true);
    expect(integrated.message).toMatch(/check-integrated|capture-only/i);
  });

  it("check-integrated does NOT soft-pass safety-rejected AC (#3284 P1)", () => {
    const plan = {
      title: "rejected only",
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "project_floor",
      },
      metadata: {
        literal_acceptance_commands: [],
        literal_acceptance_rejected: [
          { command: "rm -rf /", reason: "shell metacharacter not allowed" },
        ],
      },
    };
    const integrated = evaluateVerifyAcFromPlan(plan, {
      captureFromNarratives: false,
      checkIntegrated: true,
    });
    expect(integrated.ok).toBe(false);
    expect(integrated.code).toBe(1);
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

describe("coverage boost for product-first helpers (#3284)", () => {
  it("validates schema edge cases and attach with rich fields", () => {
    expect(validatePlanAcceptance(null)).toEqual([]);
    expect(validatePlanAcceptance("x").join(" ")).toMatch(/must be an object/);
    expect(validatePlanAcceptance({ commands: "nope" }).length).toBeGreaterThan(0);
    expect(validatePlanAcceptance({ none_stated: "yes" }).length).toBeGreaterThan(0);
    expect(validatePlanAcceptance({ source_rung: "nope" }).length).toBeGreaterThan(0);
    expect(
      validatePlanAcceptance({
        commands: [],
        none_stated: true,
        clauses: [{ text: "" }, "nope"],
      }).some((e) => e.includes("clauses[")),
    ).toBe(true);

    expect(() =>
      attachPlanAcceptance(
        { title: "t" },
        { commands: [], none_stated: false, source_rung: "stated" },
      ),
    ).toThrow(/none_stated/);

    const attached = attachPlanAcceptance(
      { title: "t", metadata: {} },
      {
        commands: [
          {
            command: "task check",
            cwd: "sub",
            expectedStdout: "ok",
            expectedExitCode: 1,
          },
        ],
        none_stated: true,
        source_rung: "derived",
        derived_reason: "agent wrote AC",
      },
    );
    const acc = readPlanAcceptance(attached);
    expect(acc.commands[0]?.cwd).toBe("sub");
    expect(acc.commands[0]?.expectedStdout).toBe("ok");
    expect(acc.derived_reason).toMatch(/agent/);

    // Coerce shapes on read (string list, expected_stdout snake, etc.)
    const coerced = readPlanAcceptance({
      acceptance: {
        commands: [
          "echo hi",
          {
            cmd: "true",
            expected_stdout: "y",
            expected_exit_code: 2,
            cwd: "d",
          },
        ],
        none_stated: false,
        source_rung: "stated",
        derivedReason: "camel",
      },
    });
    expect(coerced.commands.length).toBe(2);
    expect(coerced.derived_reason).toBe("camel");

    // none_stated + commands + stated rung reclassifies to derived on read
    const reclass = readPlanAcceptance({
      acceptance: {
        commands: [{ command: "true" }],
        none_stated: true,
        source_rung: "stated",
      },
    });
    expect(reclass.source_rung).toBe("derived");

    // stamp with empty literal → floor + derived_reason
    const stampedEmpty = stampAcceptanceFromLiteralCapture({ title: "e", metadata: {} });
    expect(readPlanAcceptance(stampedEmpty).source_rung).toBe("project_floor");
    expect(readPlanAcceptance(stampedEmpty).derived_reason).toBeTruthy();

    // stamp with cwd/stdout/exit on literal rows
    const stampedRich = stampAcceptanceFromLiteralCapture({
      title: "r",
      metadata: {
        literal_acceptance_commands: [
          {
            command: "task check",
            source: "explicit",
            cwd: "x",
            expectedStdout: "o",
            expectedExitCode: 3,
          },
        ],
      },
    });
    const rich = readPlanAcceptance(stampedRich);
    expect(rich.commands[0]?.cwd).toBe("x");
    expect(rich.commands[0]?.expectedExitCode).toBe(3);
  });

  it("covers check-mode token variants, projectRoot audit, and gate helpers", () => {
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_CHECK_MODE]: "degraded" },
        hardBudgetDetected: false,
      }).mode,
    ).toBe("pressure");
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_CHECK_MODE]: "standard" },
        hardBudgetDetected: false,
      }).mode,
    ).toBe("full");
    expect(
      resolveProductFirstCheckMode({
        environ: { [ENV_CHECK_MODE]: "not-a-mode" },
        hardBudgetDetected: false,
        ceremonyDepth: "standard",
      }).mode,
    ).toBe("full");
    // projectRoot without ritual-state falls through
    const root = mkdtempSync(join(tmpdir(), "pf-mode-"));
    expect(
      resolveProductFirstCheckMode({
        environ: {},
        projectRoot: root,
        hardBudgetDetected: false,
      }).mode,
    ).toBe("full");

    // rapid with empty ac list still returns filtered list
    expect(applyProductFirstGateMode(["verify:branch"] as const, "rapid")).toEqual([]);
    expect(applyProductFirstGateMode([{ task: "verify:ac" }] as const, "rapid")).toEqual([
      { task: "verify:ac" },
    ]);
  });

  it("covers evaluate path error branches and annotate/quiet paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-eval-"));
    // missing without soft
    expect(evaluateVerifyAcFromPath(join(dir, "no.json")).code).toBe(2);
    // unreadable
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not-json", "utf8");
    expect(evaluateVerifyAcFromPath(bad).code).toBe(2);
    // not object
    writeFileSync(bad, "[1]", "utf8");
    expect(evaluateVerifyAcFromPath(bad).code).toBe(2);
    // missing plan
    writeFileSync(bad, JSON.stringify({ x: 1 }), "utf8");
    expect(evaluateVerifyAcFromPath(bad).code).toBe(2);

    // quiet empty pass
    const quietPass = evaluateVerifyAcFromPlan(
      {
        acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
      },
      { quiet: true, captureFromNarratives: false },
    );
    expect(quietPass.message).toBe("");

    // soft skip quiet
    expect(
      evaluateVerifyAcFromPath(join(dir, "missing2.json"), {
        softMissingXbrief: true,
        quiet: true,
      }).message,
    ).toBe("");

    // check-integrated quiet
    const integratedQuiet = evaluateVerifyAcFromPlan(
      {
        acceptance: {
          commands: [{ command: "pnpm test" }],
          none_stated: false,
          source_rung: "stated",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "pnpm test", source: "task_statement" }],
        },
      },
      {
        checkIntegrated: true,
        quiet: true,
        captureFromNarratives: false,
        runner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    );
    expect(integratedQuiet.ok).toBe(true);
    expect(integratedQuiet.message).toBe("");

    // annotate path with executable failure message containing #3267
    const failed = evaluateVerifyAcFromPlan(
      {
        acceptance: {
          commands: [{ command: "task check" }],
          none_stated: true,
          source_rung: "derived",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
        },
      },
      {
        runner: () => ({ exitCode: 1, stdout: "", stderr: "nope" }),
        captureFromNarratives: false,
      },
    );
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/#3284/);

    // isVerifyAcRequired always true
    expect(isVerifyAcRequiredAtCeremonyDepth("rapid")).toBe(true);
    expect(isVerifyAcRequiredAtCeremonyDepth(null)).toBe(true);
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
          commands: [{ command: "task check" }],
          none_stated: false,
          source_rung: "derived",
        },
        metadata: {
          literal_acceptance_commands: [{ command: "task check", source: "explicit" }],
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
            commands: [{ command: "task check" }],
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

describe("resolveOracleScopeKey (#3337)", () => {
  it("disambiguates same plan.id and same stem across active roots", () => {
    const root = mkdtempSync(join(tmpdir(), "oracle-scope-key-"));
    const plan = { id: "story-a" };
    const xPath = join(root, "xbrief", "active", "foo.xbrief.json");
    const vPath = join(root, "vbrief", "active", "foo.xbrief.json");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(xPath, "{}", "utf8");
    writeFileSync(vPath, "{}", "utf8");
    const a = resolveOracleScopeKey(plan, xPath, root);
    const b = resolveOracleScopeKey(plan, vPath, root);
    expect(a).not.toBe(b);
    expect(a).toContain("story-a@");
    expect(a).toContain("xbrief/active/foo.xbrief.json");
    expect(b).toContain("vbrief/active/foo.xbrief.json");
    expect(resolveOracleScopeKey({}, xPath, root)).toBe("xbrief/active/foo.xbrief.json");
  });
});
