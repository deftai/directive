/**
 * AC-pass banking checkpoint tests (#3285).
 *
 * Tags: banking, surplus — matched by xBRIEF verify_commands -t filters.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SURPLUS_THRESHOLD,
  ENV_SURPLUS_THRESHOLD,
  parseSurplusThreshold,
  resolveAcPassBanking,
  validateAcPassBanking,
} from "../policy/ac-pass-banking.js";
import {
  appendBankEventToRunSummary,
  bankAcPass,
  decidePostBankFinding,
  ENV_RUN_SUMMARY_PATH,
  evaluateAcPassBanking,
  evaluateSurplus,
  formatBankEventLine,
  maybeBankOnAcPass,
  readAcPassBank,
  recordPostBankFinding,
  recoverFindingsFromLedgerText,
  sanitizeScopeIdForFilename,
  simulateSurplusInsufficientRun,
} from "./ac-pass-banking.js";
import {
  detectHardEffortBudget,
  ENV_MAX_BUDGET,
  ENV_MAX_TURNS,
  ENV_REMAINING_BUDGET,
  ENV_REMAINING_TURNS,
} from "./effort-budget.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ac-pass-bank-"));
  tempRoots.push(root);
  return root;
}

describe("surplus policy (#3285)", () => {
  it("defaults surplusThreshold to 0.2", () => {
    const resolved = resolveAcPassBanking(null, {});
    expect(resolved.surplusThreshold).toBe(DEFAULT_SURPLUS_THRESHOLD);
    expect(resolved.enabled).toBe(true);
    expect(resolved.source).toBe("default");
  });

  it("parses fraction and percent surplus thresholds", () => {
    expect(parseSurplusThreshold(0.25)).toBe(0.25);
    expect(parseSurplusThreshold(20)).toBe(0.2);
    expect(parseSurplusThreshold("30%")).toBe(0.3);
    expect(parseSurplusThreshold("0.15")).toBe(0.15);
    expect(parseSurplusThreshold("nope")).toBeNull();
  });

  it("validates acPassBanking object shape", () => {
    expect(validateAcPassBanking({ enabled: true, surplusThreshold: 0.3 })).toEqual([]);
    expect(validateAcPassBanking("bad").length).toBeGreaterThan(0);
    expect(validateAcPassBanking({ surplusThreshold: 999 }).length).toBeGreaterThan(0);
  });

  it("reads surplus from env DEFT_AC_PASS_SURPLUS_THRESHOLD", () => {
    const resolved = resolveAcPassBanking(null, {
      [ENV_SURPLUS_THRESHOLD]: "25%",
    });
    expect(resolved.source).toBe("env");
    expect(resolved.surplusThreshold).toBe(0.25);
  });
});

describe("evaluateSurplus banking gate (#3285)", () => {
  it("unbounded budget reports surplus active (gate inactive)", () => {
    const budget = detectHardEffortBudget({ environ: {} });
    const s = evaluateSurplus({ budget });
    expect(s.hasSurplus).toBe(true);
    expect(s.axis).toBe("unknown");
  });

  it("refuses surplus when remaining fraction below threshold", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "10",
      },
    });
    const s = evaluateSurplus({ budget, surplusThreshold: 0.2 });
    expect(s.hasSurplus).toBe(false);
    expect(s.remainingFraction).toBeCloseTo(0.1);
    expect(s.reason).toContain("insufficient");
  });

  it("allows surplus when remaining fraction meets threshold", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "30",
      },
    });
    const s = evaluateSurplus({ budget, surplusThreshold: 0.2 });
    expect(s.hasSurplus).toBe(true);
    expect(s.remainingFraction).toBeCloseTo(0.3);
  });

  it("both axes must clear surplus (cost tight)", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "50",
        [ENV_MAX_BUDGET]: "20",
        [ENV_REMAINING_BUDGET]: "2",
      },
    });
    const s = evaluateSurplus({ budget, surplusThreshold: 0.2 });
    expect(s.hasSurplus).toBe(false);
    expect(s.axis).toBe("both");
  });

  it("fail-safe: hard flag without max+remaining → no surplus", () => {
    const budget = detectHardEffortBudget({
      environ: { DEFT_HARD_BUDGET: "1" },
    });
    const s = evaluateSurplus({ budget });
    expect(s.hasSurplus).toBe(false);
    expect(s.reason).toContain("fail-safe");
  });
});

describe("finalize-on-first-ac-pass banking (#3285)", () => {
  it("AC open → still_open; deepen refused", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "80" },
    });
    const d = evaluateAcPassBanking({
      budget,
      statedAcceptanceMet: false,
    });
    expect(d.nextAction).toBe("still_open");
    expect(d.deepeningAllowed).toBe(false);
    expect(d.depthPolicy).toBe("stated-only");
  });

  it("AC met + surplus → finalize_and_deepen", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "40",
      },
    });
    const d = evaluateAcPassBanking({
      budget,
      statedAcceptanceMet: true,
    });
    expect(d.nextAction).toBe("finalize_and_deepen");
    expect(d.deepeningAllowed).toBe(true);
    expect(d.notes.some((n) => n.includes("checkpoint"))).toBe(true);
  });

  it("AC met + insufficient surplus → finalize_and_ship", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "12",
      },
    });
    const d = evaluateAcPassBanking({
      budget,
      statedAcceptanceMet: true,
    });
    expect(d.nextAction).toBe("finalize_and_ship");
    expect(d.deepeningAllowed).toBe(false);
    expect(d.notes.some((n) => n.includes("deepening_skipped=true"))).toBe(true);
  });
});

describe("post-bank report not chase (#3285)", () => {
  it("out-of-scope finding without surplus → report", () => {
    const f = decidePostBankFinding({
      findingSummary: "self-check found out-of-scope lint debt",
      regressesStatedAc: false,
      hasSurplus: false,
      now: "2026-08-11T12:00:00Z",
    });
    expect(f.action).toBe("report");
  });

  it("out-of-scope finding with surplus → chase permitted", () => {
    const f = decidePostBankFinding({
      findingSummary: "extra suite found edge case",
      regressesStatedAc: false,
      hasSurplus: true,
    });
    expect(f.action).toBe("chase");
  });

  it("finding that regresses stated AC → fix-regression always", () => {
    const f = decidePostBankFinding({
      findingSummary: "verify:ac now fails",
      regressesStatedAc: true,
      hasSurplus: false,
    });
    expect(f.action).toBe("fix-regression");
  });
});

describe("bank event telemetry (#3285)", () => {
  it("formatBankEventLine is JSON with ac_pass_bank type", () => {
    const line = formatBankEventLine({
      type: "ac_pass_bank",
      schemaVersion: 1,
      scopeId: "story-3285",
      bankedAt: "2026-08-11T12:00:00Z",
      nextAction: "finalize_and_ship",
      hadSurplus: false,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.type).toBe("ac_pass_bank");
    expect(parsed.issue).toBe(3285);
    expect(parsed.source).toBe("ac-pass-banking");
  });

  it("appendBankEventToRunSummary is silent when path unset", () => {
    const result = appendBankEventToRunSummary({
      environ: {},
      event: { type: "ac_pass_bank", schemaVersion: 1 },
    });
    expect(result.written).toBe(false);
    expect(result.path).toBeNull();
  });

  it("appendBankEventToRunSummary writes when path set", () => {
    const root = tempProject();
    const summary = join(root, "run-summary.jsonl");
    const lines: string[] = [];
    const result = appendBankEventToRunSummary({
      environ: { [ENV_RUN_SUMMARY_PATH]: summary },
      event: {
        type: "ac_pass_bank",
        schemaVersion: 1,
        scopeId: "s1",
        nextAction: "finalize_and_ship",
      },
      writeLine: (_path, line) => {
        lines.push(line);
      },
    });
    expect(result.written).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ac_pass_bank");
  });

  it("bankAcPass persists durable checkpoint and survives re-read", () => {
    const root = tempProject();
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "50",
        [ENV_REMAINING_TURNS]: "8",
      },
    });
    const surplus = evaluateSurplus({ budget });
    const bank = bankAcPass({
      projectRoot: root,
      scopeId: "story-3285-ac-pass-banking-checkpoint",
      budget,
      surplus,
      nextAction: "finalize_and_ship",
      headSha: "abc123",
      now: "2026-08-11T15:00:00Z",
      environ: {},
    });
    expect(bank.hadSurplus).toBe(false);
    expect(bank.nextAction).toBe("finalize_and_ship");
    const reloaded = readAcPassBank(root, "story-3285-ac-pass-banking-checkpoint");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.headSha).toBe("abc123");
    expect(reloaded?.bankedAt).toBe("2026-08-11T15:00:00Z");
  });
});

describe("re-bank preserves findings + production bridge (#3285)", () => {
  it("re-banking keeps prior postBankFindings", () => {
    const root = tempProject();
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "10",
      },
    });
    const surplus = evaluateSurplus({ budget });
    bankAcPass({
      projectRoot: root,
      scopeId: "rebank-scope",
      budget,
      surplus,
      nextAction: "finalize_and_ship",
      now: "2026-08-11T17:00:00Z",
      environ: {},
    });
    const finding = decidePostBankFinding({
      findingSummary: "out-of-scope debt",
      regressesStatedAc: false,
      hasSurplus: false,
      now: "2026-08-11T17:01:00Z",
    });
    recordPostBankFinding(root, "rebank-scope", finding);
    bankAcPass({
      projectRoot: root,
      scopeId: "rebank-scope",
      budget,
      surplus,
      nextAction: "finalize_and_ship",
      now: "2026-08-11T17:02:00Z",
      environ: {},
    });
    const reloaded = readAcPassBank(root, "rebank-scope");
    expect(reloaded?.postBankFindings).toHaveLength(1);
    expect(reloaded?.postBankFindings[0]?.summary).toContain("out-of-scope");
    expect(reloaded?.bankedAt).toBe("2026-08-11T17:02:00Z");
  });

  it("maybeBankOnAcPass banks only when executableRuns > 0", () => {
    const root = tempProject();
    const skipped = maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "no-runs",
      executableRuns: 0,
      environ: { [ENV_MAX_TURNS]: "50" },
    });
    expect(skipped.banked).toBe(false);

    const banked = maybeBankOnAcPass({
      projectRoot: root,
      scopeId: "with-runs",
      executableRuns: 2,
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "50",
      },
      now: "2026-08-11T18:00:00Z",
    });
    expect(banked.banked).toBe(true);
    expect(banked.bank?.scopeId).toBe("with-runs");
    expect(banked.notes.some((n) => n.includes("banked scope="))).toBe(true);
  });

  it("sanitizeScopeIdForFilename collapses unsafe chars without ReDoS", () => {
    expect(sanitizeScopeIdForFilename("a---b!!c")).toBe("a-b-c");
    expect(sanitizeScopeIdForFilename("!!!")).toBe("scope");
    expect(sanitizeScopeIdForFilename("-leading-")).toBe("leading");
  });

  it("evaluateAcPassBanking respects disabled config and cost surplus", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_BUDGET]: "10",
        [ENV_REMAINING_BUDGET]: "5",
      },
    });
    const disabled = evaluateAcPassBanking({
      budget,
      statedAcceptanceMet: true,
      config: { enabled: false, surplusThreshold: 0.9 },
    });
    expect(disabled.nextAction).toBe("finalize_and_deepen");

    const tightCost = evaluateAcPassBanking({
      budget: detectHardEffortBudget({
        environ: {
          [ENV_MAX_BUDGET]: "10",
          [ENV_REMAINING_BUDGET]: "1",
        },
      }),
      statedAcceptanceMet: true,
      config: { enabled: true, surplusThreshold: 0.2 },
    });
    expect(tightCost.nextAction).toBe("finalize_and_ship");
  });

  it("appendBankEventToRunSummary fail-open warns without throwing", () => {
    const warnings: string[] = [];
    const result = appendBankEventToRunSummary({
      environ: { [ENV_RUN_SUMMARY_PATH]: join(tempProject(), "nested", "sum.jsonl") },
      event: { type: "ac_pass_bank", schemaVersion: 1 },
      writeLine: () => {
        throw new Error("disk full");
      },
      warn: (m) => {
        warnings.push(m);
      },
    });
    expect(result.written).toBe(false);
    expect(warnings.some((w) => w.includes("run-summary write failed"))).toBe(true);
  });

  it("readAcPassBank returns null for missing/corrupt records", () => {
    const root = tempProject();
    expect(readAcPassBank(root, "missing")).toBeNull();
  });

  it("recoverFindingsFromLedgerText salvages truncated bank JSON", () => {
    const truncated =
      '{\n  "scopeId": "x",\n  "postBankFindings": [{"summary":"kept","action":"report","recordedAt":"t","regressesStatedAc":false}],\n  "nextActio';
    const findings = recoverFindingsFromLedgerText(truncated);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.summary).toBe("kept");
  });
});

describe("surplus-insufficient simulation (#3285)", () => {
  it("banks green state, ships, and reports post-bank finding", () => {
    const root = tempProject();
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "10",
      },
    });
    const summaryPath = join(root, "summary.jsonl");
    const result = simulateSurplusInsufficientRun({
      projectRoot: root,
      scopeId: "sim-surplus-insufficient",
      budget,
      findingSummary: "self-built check found out-of-scope flaky timer",
      surplusThreshold: 0.2,
      headSha: "deadbeef",
      now: "2026-08-11T16:00:00Z",
      environ: { [ENV_RUN_SUMMARY_PATH]: summaryPath },
    });

    expect(result.decision.nextAction).toBe("finalize_and_ship");
    expect(result.decision.deepeningAllowed).toBe(false);
    expect(result.shipped).toBe(true);
    expect(result.findingAction).toBe("report");
    expect(result.finding.summary).toContain("out-of-scope");
    expect(result.bank.nextAction).toBe("finalize_and_ship");

    const reloaded = readAcPassBank(root, "sim-surplus-insufficient");
    expect(reloaded?.postBankFindings).toHaveLength(1);
    expect(reloaded?.postBankFindings[0]?.action).toBe("report");

    const summary = readFileSync(summaryPath, { encoding: "utf8" });
    expect(summary).toContain("ac_pass_bank");
    expect(summary).toContain("finalize_and_ship");
  });
});
