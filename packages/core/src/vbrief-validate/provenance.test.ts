import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_VALUES,
  extractLeadingConfidenceToken,
  isSourceToken,
  parseSourceTokens,
  requireCanonicalConfidence,
  SOURCE_CLASSES,
  sourceTokenClass,
  validatePlanNarrativesProvenance,
  validateReferenceTrustLevels,
} from "./provenance.js";
import { validateVbriefSchema } from "./schema.js";

const MINIMAL_V08 = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "xBRIEF v0.8 fixture",
    status: "draft",
    items: [],
  },
} as const;

describe("Plan.narratives source provenance (#479)", () => {
  it("parses semicolon-separated source tokens and named classes", () => {
    expect(parseSourceTokens("verified:task-check; inferred:code-read")).toEqual([
      "verified:task-check",
      "inferred:code-read",
    ]);
    expect(sourceTokenClass("verified: task check")).toBe("verified");
    expect(isSourceToken("assumed")).toBe(true);
    expect(isSourceToken("scoping-comment:#2197")).toBe(false);
    expect(SOURCE_CLASSES).toContain("propagated");
    expect(CONFIDENCE_VALUES).toEqual(["high", "medium", "low"]);
  });

  it("grandfathers historical Source strings that are not named-class tokens", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source:
          "verified:codebase-read-resolution-2026-07-04; verified:issue-2197-body; scoping-comment:#2197",
        Confidence: "medium",
      },
      "hist: plan.narratives",
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("requires Evidence, Verifier, and VerifiedAt when Source is named class verified even if those keys are absent", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance({ Source: "verified:task-check" }, "n", errors);
    expect(errors.some((e) => e.includes("Evidence is required"))).toBe(true);
    expect(errors.some((e) => e.includes("Verifier is required"))).toBe(true);
    expect(errors.some((e) => e.includes("VerifiedAt is required"))).toBe(true);
  });

  it("warns on legacy Confidence strings and hard-fails non-string (#5385)", () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    validatePlanNarrativesProvenance({ Confidence: "pretty-sure" }, "n", errors, { warnings });
    expect(errors.some((e) => e.includes("Confidence invalid"))).toBe(false);
    expect(warnings.some((w) => w.includes("Confidence-compat"))).toBe(true);

    const proseErrors: string[] = [];
    const proseWarnings: string[] = [];
    validatePlanNarrativesProvenance(
      { Confidence: "High. The defect was reproduced locally." },
      "n",
      proseErrors,
      { warnings: proseWarnings },
    );
    expect(proseErrors).toEqual([]);
    expect(proseWarnings.some((w) => w.includes("Confidence-compat"))).toBe(true);

    const nonString: string[] = [];
    validatePlanNarrativesProvenance({ Confidence: 1 }, "n", nonString);
    expect(nonString.some((e) => e.includes("Confidence invalid"))).toBe(true);
  });

  it("requireCanonicalConfidence admits only high|medium|low for writers", () => {
    expect(requireCanonicalConfidence("high")).toEqual({ ok: true, value: "high" });
    expect(requireCanonicalConfidence("High. prose")).toEqual({
      ok: false,
      error: expect.stringMatching(/MUST emit/),
    });
  });

  it("extractLeadingConfidenceToken maps unambiguous prose and declines ambiguous", () => {
    expect(extractLeadingConfidenceToken("High. The defect was reproduced.")).toEqual({
      confidence: "high",
      residual: "The defect was reproduced.",
    });
    expect(extractLeadingConfidenceToken("Highly uncertain")).toBeNull();
    expect(extractLeadingConfidenceToken("High uncertainty")).toBeNull();
    expect(extractLeadingConfidenceToken("Not assessed")).toBeNull();
    expect(extractLeadingConfidenceToken("High or medium")).toBeNull();
    expect(extractLeadingConfidenceToken("Medium-low")).toBeNull();
    expect(extractLeadingConfidenceToken("high/medium")).toBeNull();
    expect(extractLeadingConfidenceToken("High-low")).toBeNull();
    expect(extractLeadingConfidenceToken("High to medium")).toBeNull();
    expect(extractLeadingConfidenceToken("High, medium")).toBeNull();
    expect(extractLeadingConfidenceToken("High medium")).toBeNull();
  });

  it("treats Evidence-only as a narrative section, not an atomic claim", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance(
      { Confidence: "high", Evidence: "mission outcome pointer" },
      "n",
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("requires Source when Verifier or VerifiedAt keys are present, including empty strings", () => {
    const verifierEmpty: string[] = [];
    validatePlanNarrativesProvenance({ Verifier: "" }, "n", verifierEmpty);
    expect(verifierEmpty.some((e) => e.includes("Source is required"))).toBe(true);

    const verifiedAtEmpty: string[] = [];
    validatePlanNarrativesProvenance({ VerifiedAt: "" }, "n", verifiedAtEmpty);
    expect(verifiedAtEmpty.some((e) => e.includes("Source is required"))).toBe(true);

    const evidencePlusVerifier: string[] = [];
    validatePlanNarrativesProvenance(
      { Evidence: "mission outcome pointer", Verifier: "" },
      "n",
      evidencePlusVerifier,
    );
    expect(evidencePlusVerifier.some((e) => e.includes("Source is required"))).toBe(true);

    const evidencePlusVerifiedAt: string[] = [];
    validatePlanNarrativesProvenance(
      { Evidence: "mission outcome pointer", VerifiedAt: "2026-10-02T18:00:00Z" },
      "n",
      evidencePlusVerifiedAt,
    );
    expect(evidencePlusVerifiedAt.some((e) => e.includes("Source is required"))).toBe(true);
  });

  it("requires Source plus evidence, verifier, and time for a verified atomic claim", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance({ Confidence: "high", Verifier: "task check" }, "n", errors);
    expect(errors.some((e) => e.includes("Source is required"))).toBe(true);

    const verifiedMissing: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source: "verified:task-check",
        Confidence: "high",
        Evidence: "",
        Verifier: "",
        VerifiedAt: "",
      },
      "n",
      verifiedMissing,
    );
    expect(verifiedMissing.some((e) => e.includes("Confidence does not substitute"))).toBe(true);
    expect(verifiedMissing.some((e) => e.includes("Verifier is required"))).toBe(true);
    expect(verifiedMissing.some((e) => e.includes("VerifiedAt is required"))).toBe(true);

    const ok: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source: "verified:task-check",
        Confidence: "high",
        Evidence: "task check exit 0 at HEAD",
        Verifier: "task check",
        VerifiedAt: "2026-10-02T18:00:00Z",
      },
      "n",
      ok,
    );
    expect(ok).toEqual([]);
  });

  it("rejects a bad VerifiedAt on a verified atomic claim", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source: "verified:user",
        Evidence: "operator confirmed",
        Verifier: "operator",
        VerifiedAt: "yesterday",
      },
      "n",
      errors,
    );
    expect(errors.some((e) => e.includes("VerifiedAt invalid"))).toBe(true);

    const offset: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source: "verified:user",
        Evidence: "operator confirmed",
        Verifier: "operator",
        VerifiedAt: "2026-10-02T18:00:00+00:00",
      },
      "n",
      offset,
    );
    expect(offset).toEqual([]);
  });

  it("does not require evidence for inferred atomic claims", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance(
      {
        Source: "inferred:code-inspection",
        Confidence: "low",
        Verifier: "agent",
        VerifiedAt: "2026-10-02T18:00:00Z",
      },
      "n",
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("rejects unnamed Source tokens once the atomic claim unit is present", () => {
    const errors: string[] = [];
    validatePlanNarrativesProvenance(
      { Source: "scoping-comment:#2197", Evidence: "pointer" },
      "n",
      errors,
    );
    expect(errors.some((e) => e.includes("not a named class"))).toBe(true);

    const blank: string[] = [];
    validatePlanNarrativesProvenance({ Source: "   ;  ", Evidence: "pointer" }, "n", blank);
    expect(blank.some((e) => e.includes("at least one source-class token"))).toBe(true);

    const skipped: string[] = [];
    validatePlanNarrativesProvenance(null, "n", skipped);
    expect(skipped).toEqual([]);
    expect(sourceTokenClass("not-a-class:x")).toBeNull();
  });
});

describe("validateVbriefSchema provenance placement (#479)", () => {
  it("validates named vocabulary on Plan.narratives and leaves PlanItem.narrative free", () => {
    const planLevel = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        narratives: {
          Source: "verified:review",
          Confidence: "high",
          Evidence: "review comment 5779996092",
          Verifier: "pain-audit",
          VerifiedAt: "2026-10-02T17:00:00Z",
        },
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            narrative: { Source: "freeform item note", Confidence: "not-an-enum" },
          },
        ],
      },
    };
    expect(validateVbriefSchema(planLevel, "plan-ok.json")).toEqual([]);

    const completedHistorical = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        status: "completed",
        narratives: {
          Source: "verified:codebase-surface-map-2026-07-03; verified:umbrella-2203-current-shape",
          Confidence: "medium",
        },
      },
    };
    expect(validateVbriefSchema(completedHistorical, "completed-hist.json")).toEqual([]);

    const legacyConfidence = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        narratives: { Confidence: "unknown" },
      },
    };
    const legacyWarnings: string[] = [];
    expect(validateVbriefSchema(legacyConfidence, "conf-legacy.json", legacyWarnings)).toEqual([]);
    expect(legacyWarnings.some((w) => w.includes("Confidence-compat"))).toBe(true);

    const nonStringConfidence = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        narratives: { Confidence: 3 },
      },
    };
    expect(
      validateVbriefSchema(nonStringConfidence, "conf-bad.json").some((e) =>
        e.includes("plan.narratives.Confidence invalid"),
      ),
    ).toBe(true);

    const completedProse = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        status: "completed",
        narratives: {
          Confidence: "Not assessed against the suite",
          Source: "historical freeform note",
        },
      },
    };
    const completedWarnings: string[] = [];
    expect(validateVbriefSchema(completedProse, "completed-prose.json", completedWarnings)).toEqual(
      [],
    );
    expect(completedWarnings.some((w) => w.includes("Confidence-compat"))).toBe(true);
  });

  it("accepts TrustLevel verified and rejects unknown TrustLevel", () => {
    const ok = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/479",
            type: "x-xbrief/github-issue",
            TrustLevel: "verified",
          },
          {
            uri: "xbrief/completed/example.xbrief.json",
            type: "x-xbrief/plan",
            TrustLevel: "internal",
          },
        ],
      },
    };
    expect(validateVbriefSchema(ok, "trust-ok.json")).toEqual([]);

    const bad = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        references: [
          {
            uri: "https://example.invalid/x",
            type: "x-xbrief/external",
            TrustLevel: "trusted",
          },
        ],
      },
    };
    expect(
      validateVbriefSchema(bad, "trust-bad.json").some((e) => e.includes("TrustLevel invalid")),
    ).toBe(true);
  });

  it("refuses a failed plan item that has no invalidates edge", () => {
    const missing = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "clause.3", title: "Ruled out", status: "failed" }],
      },
    };
    expect(
      validateVbriefSchema(missing, "fail-no-edge.json").some((e) => e.includes("invalidates")),
    ).toBe(true);

    const edged = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          { id: "clause.3", title: "Ruled out", status: "failed" },
          { id: "clause.4", title: "Survivor", status: "completed" },
        ],
        edges: [{ from: "clause.4", to: "clause.3", type: "invalidates" }],
      },
    };
    expect(validateVbriefSchema(edged, "fail-edged.json")).toEqual([]);

    const ghostFrom = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          { id: "clause.3", title: "Ruled out", status: "failed" },
          { id: "clause.4", title: "Survivor", status: "completed" },
        ],
        edges: [{ from: "ghost", to: "clause.3", type: "invalidates" }],
      },
    };
    expect(
      validateVbriefSchema(ghostFrom, "fail-ghost.json").some((e) => e.includes("invalidates")),
    ).toBe(true);

    const emptyXClaim = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "clause.3",
            title: "Ruled out",
            status: "failed",
            metadata: { "x-claim": {} },
          },
        ],
      },
    };
    expect(
      validateVbriefSchema(emptyXClaim, "fail-empty-xclaim.json").some((e) =>
        e.includes("invalidates"),
      ),
    ).toBe(true);

    const nested = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "parent",
            title: "Parent",
            status: "pending",
            subItems: [{ title: "no-id-fail", status: "failed" }],
          },
        ],
      },
    };
    expect(validateVbriefSchema(nested, "fail-sub.json").some((e) => e.includes("<no-id>"))).toBe(
      true,
    );
  });

  it("skips invalidates on whole-story fail or cancel", () => {
    const failedPlan = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        status: "failed",
        items: [{ id: "clause.3", title: "Ruled out", status: "failed" }],
      },
    };
    expect(validateVbriefSchema(failedPlan, "plan-failed.json")).toEqual([]);

    const cancelledPlan = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        status: "cancelled",
        items: [{ id: "clause.3", title: "Ruled out", status: "failed" }],
      },
    };
    expect(validateVbriefSchema(cancelledPlan, "plan-cancelled.json")).toEqual([]);
  });
});

describe("validateReferenceTrustLevels", () => {
  it("skips missing TrustLevel and non-object entries", () => {
    const errors: string[] = [];
    validateReferenceTrustLevels(
      [null, "x", { uri: "u", type: "x-xbrief/plan" }, { TrustLevel: 1 }],
      "f.json",
      errors,
    );
    expect(errors.some((e) => e.includes("TrustLevel invalid"))).toBe(true);
    expect(errors).toHaveLength(1);

    const skipped: string[] = [];
    validateReferenceTrustLevels("nope", "f.json", skipped);
    expect(skipped).toEqual([]);
  });
});
