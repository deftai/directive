import { describe, expect, it } from "vitest";
import {
  DECISION_SCHEMA_VERSION,
  datePrefixFromTimestamp,
  decisionFilename,
  normalizeTimestamp,
  slugifyDecision,
  validateDecisionRecord,
} from "./schema.js";

const validBase = {
  decision: "Use dual location for decision records",
  governingRule: {
    description: "Significant choices leave a durable rationale",
    path: "content/docs/decision-log.md",
    rfc2119: "MUST",
  },
  alternativesConsidered: [
    { option: "scope-only narratives", whyNot: "cross-cutting decisions orphan" },
    { option: "ADR-only", whyNot: "too heavy for process choices" },
  ],
  whyWinner: "Dual covers scope-bound and multi-scope cases without ADR noise",
  confidence: "high",
  activeScopeRefs: ["xbrief/active/example.xbrief.json"],
  timestamp: "2026-08-08T12:00:00Z",
  revisitTrigger: "If dual location causes discoverability pain, revisit folder layout",
};

describe("slugifyDecision", () => {
  it("kebab-cases free text", () => {
    expect(slugifyDecision("SCM Label Mirror First Apply")).toBe("scm-label-mirror-first-apply");
  });

  it("falls back for empty input", () => {
    expect(slugifyDecision("   ")).toBe("decision");
  });

  it("collapses punctuation linearly", () => {
    expect(slugifyDecision("---hello---world---")).toBe("hello-world");
    expect(slugifyDecision("a".repeat(80)).length).toBe(64);
  });
});

describe("sanitizeForTerminal", () => {
  it("strips control characters and bidi overrides", async () => {
    const { sanitizeForTerminal } = await import("./schema.js");
    expect(sanitizeForTerminal("ok\u001b[31mred\u0007bell")).toBe("ok[31mredbell");
    expect(sanitizeForTerminal("line\nbreak")).toBe("line break");
    expect(sanitizeForTerminal("safe\u202Eevil")).toBe("safeevil");
    expect(sanitizeForTerminal("a\u0080b\u009fc")).toBe("abc");
  });
});

describe("decisionFilename", () => {
  it("prefixes date and suffix", () => {
    expect(decisionFilename("scm-label-mirror", "2026-08-08T12:00:00Z")).toBe(
      "2026-08-08-scm-label-mirror.decision.json",
    );
  });
});

describe("normalizeTimestamp / datePrefixFromTimestamp", () => {
  it("normalizes to second precision Z", () => {
    expect(normalizeTimestamp("2026-08-08T12:00:00.123Z")).toBe("2026-08-08T12:00:00Z");
  });

  it("extracts date prefix", () => {
    expect(datePrefixFromTimestamp("2026-08-08T12:00:00Z")).toBe("2026-08-08");
  });
});

describe("validateDecisionRecord", () => {
  it("accepts a complete record", () => {
    const result = validateDecisionRecord(validBase);
    expect(result.ok).toBe(true);
    expect(result.record?.schemaVersion).toBe(DECISION_SCHEMA_VERSION);
    expect(result.record?.confidence).toBe("high");
    expect(result.record?.alternativesConsidered).toHaveLength(2);
  });

  it("accepts governingRule as a plain string", () => {
    const result = validateDecisionRecord({
      ...validBase,
      governingRule: "Leave ADRs alone",
    });
    expect(result.ok).toBe(true);
    expect(result.record?.governingRule.description).toBe("Leave ADRs alone");
  });

  it("rejects missing decision", () => {
    const { decision: _d, ...rest } = validBase;
    const result = validateDecisionRecord(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "decision")).toBe(true);
  });

  it("rejects empty alternatives", () => {
    const result = validateDecisionRecord({ ...validBase, alternativesConsidered: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "alternativesConsidered")).toBe(true);
  });

  it("rejects bad confidence", () => {
    const result = validateDecisionRecord({ ...validBase, confidence: "sure" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing revisit trigger", () => {
    const { revisitTrigger: _r, ...rest } = validBase;
    const result = validateDecisionRecord(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "revisitTrigger")).toBe(true);
  });

  it("derives id from decision when omitted", () => {
    const result = validateDecisionRecord(validBase);
    expect(result.record?.id).toContain("dual");
  });

  it("accepts alternatives as plain strings and snake_case keys", () => {
    const result = validateDecisionRecord({
      decision: "Keep ADRs",
      governingRule: "ADR lane stays heavyweight",
      alternatives: ["merge into decision log"],
      why_winner: "Different audience and cadence",
      confidence: "MEDIUM",
      active_scope_refs: "xbrief/active/a.xbrief.json",
      revisit_trigger: "If ADR volume collapses, revisit split",
      relatedIssues: [1396, "1513"],
      tags: ["adr", 1, ""],
      id: "keep-adrs",
    });
    expect(result.ok).toBe(true);
    expect(result.record?.confidence).toBe("medium");
    expect(result.record?.activeScopeRefs).toEqual(["xbrief/active/a.xbrief.json"]);
    expect(result.record?.relatedIssues).toEqual([1396, 1513]);
  });

  it("rejects bad rfc2119 and non-object root", () => {
    expect(validateDecisionRecord(null).ok).toBe(false);
    const badRfc = validateDecisionRecord({
      ...validBase,
      governingRule: { description: "x", rfc2119: "ALWAYS" },
    });
    expect(badRfc.ok).toBe(false);
  });

  it("rejects invalid timestamp and bad alternative entries", () => {
    const badTs = validateDecisionRecord({ ...validBase, timestamp: "not-a-date" });
    expect(badTs.ok).toBe(false);
    const badAlt = validateDecisionRecord({
      ...validBase,
      alternativesConsidered: [{ noOption: true }],
    });
    expect(badAlt.ok).toBe(false);
    const badScope = validateDecisionRecord({ ...validBase, activeScopeRefs: [""] });
    expect(badScope.ok).toBe(false);
    const badScopeType = validateDecisionRecord({ ...validBase, activeScopeRefs: 12 });
    expect(badScopeType.ok).toBe(false);
  });

  it("rejects wrong schemaVersion", () => {
    const result = validateDecisionRecord({ ...validBase, schemaVersion: "v0" });
    expect(result.ok).toBe(false);
  });
});
