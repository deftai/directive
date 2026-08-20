/**
 * Field-artifact replay for #3559: missing ambiguity attestation is config-error
 * on every verify path (standalone, check-composed, complete walk, restamp).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AMBIGUITY_ATTESTATION_REMEDIATION,
  applyClauseQualityToPlan,
  MISSING_AMBIGUITY_ATTESTATION_CAUSE,
  maybeEmitAcceptanceStampFromChange,
} from "../intake/clause-derivation.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import { evaluateScopeCompleteAcceptanceWalk } from "../scope/acceptance-evidence.js";
import { resolveAcceptanceGateProfile } from "./acceptance-resolver.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

const FIELD_CLAUSES = [
  {
    id: 1,
    text: "shipped-a.txt exists at the stated path",
    artifact_path: "shipped-a.txt",
    ambiguous: false as const,
  },
  {
    id: 2,
    text: "shipped-b.txt exists at the stated path",
    artifact_path: "shipped-b.txt",
    ambiguous: false as const,
  },
];

function fieldAcceptance(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commands: [],
    none_stated: true,
    source_rung: "derived",
    clauses: FIELD_CLAUSES,
    ...extra,
  };
}

function fieldPlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "3559-field",
    title: "field stamp",
    acceptance: fieldAcceptance(extra),
    items: [],
  };
}

function writeFieldRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-3559-"));
  writeFileSync(join(root, "shipped-a.txt"), "a\n", "utf8");
  writeFileSync(join(root, "shipped-b.txt"), "b\n", "utf8");
  return root;
}

function parseAcceptanceEvents(
  summary: string,
): { event: string; payload: { outcome?: string; cause?: string } }[] {
  return summary
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { event: string; payload: { outcome?: string; cause?: string } },
    )
    .filter((row) => row.event === "acceptance");
}

describe("ambiguity attestation on every verify path (#3559)", () => {
  it("fails closed on standalone, check-composed, complete walk, and restamp", () => {
    const root = writeFieldRoot();
    const plan = fieldPlan();
    const summary = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: summary };
    const base = {
      projectRoot: root,
      captureFromNarratives: false,
      hasSuiteFloor: true,
      bankOnPass: false,
      env,
    };

    const standalone = evaluateVerifyAcFromPlan(plan, {
      ...base,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
    });
    expect(standalone.ok).toBe(false);
    expect(standalone.code).toBe(2);
    expect(standalone.resolution).toBe("config");
    expect(standalone.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);
    expect(standalone.message).toContain(AMBIGUITY_ATTESTATION_REMEDIATION);

    const quiet = evaluateVerifyAcFromPlan(plan, {
      ...base,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
      quiet: true,
    });
    expect(quiet.code).toBe(2);
    expect(quiet.message).toBe("");
    expect(quiet.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);

    const path = join(root, "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2), "utf8");
    const fromPath = evaluateVerifyAcFromPath(path, {
      ...base,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
    });
    expect(fromPath.code).toBe(2);
    expect(fromPath.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);

    const check = evaluateVerifyAcFromPlan(plan, {
      ...base,
      ...resolveAcceptanceGateProfile("check"),
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe(2);
    expect(check.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);

    const completeProfile = resolveAcceptanceGateProfile("complete");
    const complete = evaluateVerifyAcFromPlan(plan, {
      ...base,
      ...completeProfile,
    });
    expect(complete.code).toBe(2);
    expect(complete.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);

    const completeWalk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...base,
      ...completeProfile,
    });
    expect(completeWalk.ok).toBe(false);
    expect(completeWalk.message).toContain(AMBIGUITY_ATTESTATION_REMEDIATION);

    maybeEmitAcceptanceStampFromChange(root, undefined, plan.acceptance, env);
    const afterRestamp = evaluateVerifyAcFromPlan(plan, {
      ...base,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
    });
    expect(afterRestamp.code).toBe(2);
    expect(afterRestamp.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);

    const events = parseAcceptanceEvents(readFileSync(summary, "utf8"));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((row) => row.payload.outcome === "config-error")).toBe(true);
    expect(events.every((row) => row.payload.cause === MISSING_AMBIGUITY_ATTESTATION_CAUSE)).toBe(
      true,
    );
  });

  it("passes a stamp with ambiguity_attestation none_found", () => {
    const root = writeFieldRoot();
    const result = evaluateVerifyAcFromPlan(fieldPlan({ ambiguity_attestation: "none_found" }), {
      projectRoot: root,
      captureFromNarratives: false,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.resolution).toBe("verified-pass");
  });

  it("passes a stamp with an ambiguous clause and readings", () => {
    const root = writeFieldRoot();
    const result = evaluateVerifyAcFromPlan(
      fieldPlan({
        clauses: [
          {
            id: 1,
            text: "shipped-a.txt or shipped-b.txt exists at the stated path",
            artifact_path: "shipped-a.txt",
            ambiguous: true,
            readings: [
              { text: "shipped-a.txt", artifact_path: "shipped-a.txt" },
              { text: "shipped-b.txt", artifact_path: "shipped-b.txt" },
            ],
            chosen_reading: 0,
          },
        ],
      }),
      {
        projectRoot: root,
        captureFromNarratives: false,
        hasSuiteFloor: true,
        bankOnPass: false,
        reuseMode: "never",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it("passes after a quality restamp that attests none_found", () => {
    const root = writeFieldRoot();
    const plan = {
      ...fieldPlan(),
      narratives: {
        Overview:
          "## Acceptance sketch\n- shipped-a.txt exists at the stated path\n- shipped-b.txt exists at the stated path\n",
      },
    };
    applyClauseQualityToPlan(plan);
    expect((plan.acceptance as { ambiguity_attestation?: string }).ambiguity_attestation).toBe(
      "none_found",
    );
    const result = evaluateVerifyAcFromPlan(plan, {
      projectRoot: root,
      captureFromNarratives: false,
      hasSuiteFloor: true,
      bankOnPass: false,
      reuseMode: "never",
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });
});
