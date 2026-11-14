import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import {
  evaluateMintLevelRecord,
  evaluateOnePrScopeProofGate,
  formatMintLevelAdmitBlock,
  inspectOnePrScopeProof,
  MINT_LEVEL_CI_LIMIT_LINE,
  resolveOnePrScopeProof,
  resolveOnePrScopeProofFromPlan,
  setOnePrScopeProof,
} from "./one-pr-scope-proof.js";

function pd(policy: Record<string, unknown> | null, legacyKey = false): string {
  const plan: Record<string, unknown> = { title: "T", status: "running", items: [] };
  if (policy !== null) plan[legacyKey ? "policy" : "x-directive/policy"] = policy;
  return JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan });
}

const MINT_ON = { onePrScopeProof: "mint", requireHumanMerge: true };

describe("resolveOnePrScopeProofFromPlan (#6273)", () => {
  it("defaults to off when absent or null", () => {
    expect(resolveOnePrScopeProofFromPlan({}).level).toBe("off");
    expect(resolveOnePrScopeProofFromPlan({ "x-directive/policy": {} }).source).toBe("default");
    expect(
      resolveOnePrScopeProofFromPlan({ "x-directive/policy": { onePrScopeProof: null } }).level,
    ).toBe("off");
  });

  it("reads typed levels, legacy key included", () => {
    expect(resolveOnePrScopeProofFromPlan({ "x-directive/policy": MINT_ON })).toEqual({
      level: "mint",
      source: "typed",
      error: null,
    });
    expect(resolveOnePrScopeProofFromPlan({ policy: { onePrScopeProof: "signed" } }).level).toBe(
      "signed",
    );
  });

  it("fails closed to off on a malformed value or block", () => {
    const bad = resolveOnePrScopeProofFromPlan({ "x-directive/policy": { onePrScopeProof: 3 } });
    expect(bad.level).toBe("off");
    expect(bad.source).toBe("default-on-error");
    expect(bad.error).toMatch(/off\|mint\|signed/);
    expect(resolveOnePrScopeProofFromPlan({ "x-directive/policy": [] }).source).toBe(
      "default-on-error",
    );
  });
});

describe("evaluateOnePrScopeProofGate (#6273)", () => {
  it("is off when the merge base has no level, level off, or no PROJECT-DEFINITION", () => {
    expect(evaluateOnePrScopeProofGate({ baseRaw: pd(null), headRaw: pd(MINT_ON) }).kind).toBe(
      "off",
    );
    expect(
      evaluateOnePrScopeProofGate({
        baseRaw: pd({ onePrScopeProof: "off", requireHumanMerge: true }),
        headRaw: pd(MINT_ON),
      }).kind,
    ).toBe("off");
    expect(evaluateOnePrScopeProofGate({ baseRaw: null, headRaw: pd(MINT_ON) }).kind).toBe("off");
    expect(evaluateOnePrScopeProofGate({ baseRaw: "{not json", headRaw: null }).kind).toBe("off");
  });

  it("opens the mint level only with typed merge-base requireHumanMerge true", () => {
    expect(evaluateOnePrScopeProofGate({ baseRaw: pd(MINT_ON), headRaw: pd(MINT_ON) })).toEqual({
      kind: "mint",
    });
    for (const rhm of [false, undefined, "true"]) {
      const base = pd({ onePrScopeProof: "mint", requireHumanMerge: rhm });
      const gate = evaluateOnePrScopeProofGate({ baseRaw: base, headRaw: base });
      expect(gate.kind).toBe("refuse");
    }
  });

  it("refuses signed (#5862) and malformed merge-base levels", () => {
    const signed = pd({ onePrScopeProof: "signed", requireHumanMerge: true });
    const gate = evaluateOnePrScopeProofGate({ baseRaw: signed, headRaw: signed });
    expect(gate.kind === "refuse" && gate.reason).toMatch(/#5862/);
    const odd = pd({ onePrScopeProof: "yes", requireHumanMerge: true });
    expect(evaluateOnePrScopeProofGate({ baseRaw: odd, headRaw: odd }).kind).toBe("refuse");
  });

  it("refuses a head that changes either field or cannot be read", () => {
    for (const head of [
      pd({ onePrScopeProof: "mint", requireHumanMerge: false }),
      pd({ onePrScopeProof: "off", requireHumanMerge: true }),
      pd({ requireHumanMerge: true }),
      null,
      "[]",
    ]) {
      expect(evaluateOnePrScopeProofGate({ baseRaw: pd(MINT_ON), headRaw: head }).kind).toBe(
        "refuse",
      );
    }
    // Moving the block between the legacy and namespaced key is not a change.
    expect(
      evaluateOnePrScopeProofGate({ baseRaw: pd(MINT_ON), headRaw: pd(MINT_ON, true) }).kind,
    ).toBe("mint");
  });
});

describe("evaluateMintLevelRecord (#6273)", () => {
  const REL = "xbrief/active/s.xbrief.json";
  const SCOPE = [
    "src/a.ts",
    ".deft/approved-scope/s-1.json",
    ".deft/approved-scope/s-1.intent.json",
  ];

  function brief(scope: readonly string[]): Record<string, unknown> {
    return {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "s-1",
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: scope } },
      },
    };
  }

  function input(overrides: Partial<Parameters<typeof evaluateMintLevelRecord>[0]> = {}) {
    const payload = brief(SCOPE);
    const raw = JSON.stringify(payload);
    const extracted = extractIntentFromRaw(raw, {});
    if (!extracted.ok) throw new Error(extracted.error);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: REL,
        payload,
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-13T00:00:00Z" },
        intentDigest: computeIntentDigest(extracted.preimage),
        digestAlgo: "intent-extract-v1",
      }),
      authHashV1: computeAuthHashV1(payload, REL) ?? "",
    };
    return {
      record,
      intentRaw: JSON.stringify(extracted.preimage),
      xbriefRelPath: REL,
      headPayload: payload,
      headRaw: raw,
      ...overrides,
    };
  }

  it("admits an exact match", () => {
    const verdict = evaluateMintLevelRecord(input());
    expect(verdict.kind).toBe("admit");
    expect(verdict.kind === "admit" && verdict.fileScope).toEqual(
      [...SCOPE].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("rejects a missing record, a missing plan.id and a missing intentDigest", () => {
    expect(evaluateMintLevelRecord(input({ record: null }))).toMatchObject({ kind: "reject" });
    const noPlan = { xBRIEFInfo: { version: "0.8" }, plan: { title: "x" } };
    expect(evaluateMintLevelRecord(input({ headPayload: noPlan }))).toMatchObject({
      reason: "head brief has no plan.id",
    });
    const base = input();
    const { intentDigest: _drop, ...rest } = base.record;
    expect(evaluateMintLevelRecord({ ...base, record: rest })).toMatchObject({
      reason: "record has no intentDigest",
    });
  });

  it("rejects an unreadable preimage or head brief", () => {
    expect(evaluateMintLevelRecord(input({ intentRaw: "{}" }))).toMatchObject({
      reason: "same-PR intent preimage is malformed",
    });
    expect(evaluateMintLevelRecord(input({ headRaw: '{"plan":{},"plan":{}}' }))).toMatchObject({
      kind: "reject",
    });
  });
});

describe("formatMintLevelAdmitBlock (#6273)", () => {
  it("names the plan id, the admitted scope, the production count and the CI limit", () => {
    const block = formatMintLevelAdmitBlock({
      planId: "s-1",
      xbriefRelPath: "xbrief/active/s.xbrief.json",
      fileScope: ["src/a.ts", "src/a.test.ts"],
      productionFileCount: 1,
    });
    expect(block).toContain("plan id: s-1");
    expect(block).toContain("production files: 1");
    expect(block).toContain("    - src/a.ts");
    expect(block).toContain(MINT_LEVEL_CI_LIMIT_LINE);
    expect(MINT_LEVEL_CI_LIMIT_LINE).toBe(
      "CI cannot tell this mint from a file an agent wrote; the human merge is the control",
    );
  });
});

describe("setOnePrScopeProof (#6273)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function project(): string {
    const r = mkdtempSync(join(tmpdir(), "one-pr-scope-proof-"));
    roots.push(r);
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      pd({ requireHumanMerge: true }),
    );
    return r;
  }

  function readLevel(r: string): unknown {
    const data = JSON.parse(
      readFileSync(join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as {
      plan: Record<string, Record<string, unknown>>;
    };
    return data.plan["x-directive/policy"]?.onePrScopeProof;
  }

  it("refuses signed with a pointer to #5862 and writes nothing", () => {
    const r = project();
    const result = setOnePrScopeProof(r, { level: "signed", confirm: true });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("#5862");
    expect(readLevel(r)).toBeUndefined();
  });

  it("refuses an unknown level and a missing --confirm", () => {
    const r = project();
    expect(setOnePrScopeProof(r, { level: "on", confirm: true }).exitCode).toBe(2);
    const dry = setOnePrScopeProof(r, { level: "mint" });
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout).toContain("--confirm");
    expect(readLevel(r)).toBeUndefined();
  });

  it("writes mint, is a no-op on repeat, and reads back through the inspector", () => {
    const r = project();
    const first = setOnePrScopeProof(r, { level: "mint", confirm: true, actor: "t", note: "n" });
    expect(first.exitCode).toBe(0);
    expect(first.changed).toBe(true);
    expect(first.stdout).toContain("requireHumanMerge=true");
    expect(readLevel(r)).toBe("mint");
    const again = setOnePrScopeProof(r, { level: "mint", confirm: true });
    expect(again.changed).toBe(false);
    expect(resolveOnePrScopeProof(r).level).toBe("mint");
    expect(inspectOnePrScopeProof(null, r).current).toBe("mint");
    expect(setOnePrScopeProof(r, { level: "off", confirm: true }).exitCode).toBe(0);
    expect(readLevel(r)).toBe("off");
  });

  it("reports a missing PROJECT-DEFINITION as a config error", () => {
    const r = mkdtempSync(join(tmpdir(), "one-pr-scope-proof-missing-"));
    roots.push(r);
    expect(setOnePrScopeProof(r, { level: "mint", confirm: true }).exitCode).toBe(2);
    expect(resolveOnePrScopeProof(r).level).toBe("off");
    expect(inspectOnePrScopeProof(null).current).toBe("off");
  });
});
