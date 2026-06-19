import { describe, expect, it } from "vitest";
import { coverageTtlHours } from "./coverage.js";
import { evaluateRules } from "./evaluate.js";
import { evaluateMilestoneRuleInto } from "./milestone.js";
import { renderList } from "./renderers.js";
import {
  validateScopeIgnores,
  validateScopeRules,
  validateTriageScopeIgnoresOnPlan,
  validateTriageScopeOnPlan,
} from "./validate.js";

describe("validate exhaustive branches", () => {
  it("covers rule object shape errors", () => {
    expect(validateScopeRules([null]).errors[0]).toContain("must be an object");
    expect(validateScopeRules([{ rule: "" }]).errors[0]).toContain("non-empty string");
  });

  it("covers labels all-of and empty list errors", () => {
    expect(validateScopeRules([{ rule: "labels", "all-of": [] }]).errors[0]).toContain("non-empty");
    expect(validateScopeRules([{ rule: "labels", "any-of": ["ok"] }]).errors).toEqual([]);
  });

  it("covers referenced and sliced scope errors with python repr", () => {
    const ref = validateScopeRules([{ rule: "referenced-by-vbrief", scope: "bad" }]).errors[0];
    expect(ref).toContain("'any'");
    expect(ref).toContain("'active'");
    expect(ref).toContain("'bad'");
  });

  it("covers milestone validation matrix", () => {
    expect(validateScopeRules([{ rule: "milestone", "any-of": [] }]).errors[0]).toContain(
      "non-empty",
    );
    expect(validateScopeRules([{ rule: "milestone", "any-of": [""] }]).errors[0]).toContain(
      "non-empty string",
    );
    expect(validateScopeRules([{ rule: "milestone", "is-open": "yes" }]).errors[0]).toContain(
      "boolean",
    );
    expect(
      validateScopeRules([{ rule: "milestone", name: "a", "any-of": ["b"] }]).errors[0],
    ).toContain("mutually exclusive");
  });

  it("covers ignore validator branches", () => {
    expect(
      validateScopeIgnores([{ rule: "author", "any-of": ["ok", ""] }]).errors.length,
    ).toBeGreaterThan(0);
    expect(validateScopeIgnores([{ milestone: "" }]).errors[0]).toContain("milestone");
    expect(validateScopeIgnores([{}]).errors[0]).toContain("must have");
  });

  it("validate hooks return tagged errors", () => {
    expect(
      validateTriageScopeOnPlan({ policy: { triageScope: [{ rule: "labels" }] } }, "f.json")[0],
    ).toContain("(#1131)");
    const ignoreErrors = validateTriageScopeIgnoresOnPlan(
      { policy: { triageScopeIgnores: [{ label: "" }] } },
      "f.json",
    );
    expect(ignoreErrors[0]).toContain("#1133");
  });
});

describe("milestone evaluate empty open set", () => {
  it("skips is-open matches when snapshot empty", () => {
    const matched = new Map<number, Record<string, unknown>>();
    evaluateMilestoneRuleInto(
      { rule: "milestone", "is-open": true },
      [{ number: 1, state: "open", milestone: { title: "S" } }],
      matched,
      {
        getOpenMilestones: () => new Set(),
        isOpenIssue: (i) => i.state === "open",
        issueNumber: (i) => Number(i.number),
        milestoneName: (i) => String((i.milestone as { title?: string })?.title ?? ""),
      },
    );
    expect(matched.size).toBe(0);
  });
});

describe("render and env branches", () => {
  it("renders malformed milestone and labels rules", () => {
    const out = renderList([{ rule: "labels" }, { rule: "milestone" }, { rule: "unknown" }]);
    expect(out).toContain("malformed");
    expect(out).toContain("unknown rule type");
  });

  it("coverage ttl reads env override", () => {
    process.env.DEFT_COVERAGE_MAX_AGE_HOURS = "12";
    expect(coverageTtlHours()).toBe(12);
    process.env.DEFT_COVERAGE_MAX_AGE_HOURS = "-1";
    expect(coverageTtlHours()).toBe(24);
    delete process.env.DEFT_COVERAGE_MAX_AGE_HOURS;
  });

  it("evaluate handles invalid timestamps", () => {
    expect(
      evaluateRules(
        [{ rule: "opened-since", duration: "1d" }],
        [{ number: 1, state: "open", created_at: "not-a-date" }],
      ),
    ).toEqual([]);
  });
});
