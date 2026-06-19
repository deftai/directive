import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";
import { evaluateRules } from "./evaluate.js";
import * as scopeIndex from "./index.js";
import {
  collectMilestoneSubscribedNames,
  evaluateMilestoneRuleInto,
  inferRepoFromIssues,
  rulesRequestIsOpen,
} from "./milestone.js";
import { extractReferencedIssues, renderList } from "./renderers.js";
import { resolveScopeIgnores, resolveScopeRules } from "./resolve.js";
import {
  validateScopeIgnores,
  validateScopeRules,
  validateTriageScopeIgnoresOnPlan,
  validateTriageScopeOnPlan,
} from "./validate.js";

const upstream = [
  { number: 1, state: "open", labels: [{ name: "bug" }, { name: "regression" }] },
  { number: 2, state: "open", labels: [{ name: "epic" }], milestone: { title: "S1" } },
];

describe("validate hooks and rule matrix", () => {
  it("validateTriageScopeOnPlan tags errors", () => {
    expect(validateTriageScopeOnPlan({}, "f.json")).toEqual([]);
    const out = validateTriageScopeOnPlan(
      { policy: { triageScope: [{ rule: "milestone" }] } },
      "f.json",
    );
    expect(out[0]).toContain("(#1131)");
  });

  it("validateTriageScopeIgnoresOnPlan tags #1182 for rule shape", () => {
    const out = validateTriageScopeIgnoresOnPlan(
      { policy: { triageScopeIgnores: [{ rule: "author" }] } },
      "f.json",
    );
    expect(out[0]).toContain("#1182");
  });

  it("covers referenced-by-vbrief and sliced-from validation", () => {
    expect(
      validateScopeRules([{ rule: "referenced-by-vbrief", scope: "bad" }]).errors[0],
    ).toContain("referenced-by-vbrief.scope");
    expect(validateScopeRules([{ rule: "sliced-from", scope: "bad" }]).errors[0]).toContain(
      "sliced-from.scope",
    );
    expect(validateScopeRules([{ rule: "labels", "all-of": ["a"] }]).errors).toEqual([]);
    expect(validateScopeRules([{ rule: "milestone", "any-of": ["a"] }]).errors).toEqual([]);
    expect(validateScopeIgnores([{ label: "" }]).errors[0]).toContain("must be a non-empty string");
    expect(validateScopeIgnores({}).errors[0]).toContain("must be a list");
  });
});

describe("evaluate and render paths", () => {
  it("evaluates labels all-of and sliced-from", () => {
    expect(
      evaluateRules([{ rule: "labels", "all-of": ["bug", "regression"] }], upstream).map(
        (i) => i.number,
      ),
    ).toEqual([1]);
    expect(
      evaluateRules([{ rule: "sliced-from", scope: "any-umbrella-in-cache" }], upstream, {
        umbrellaSlices: new Set([2]),
      }).map((i) => i.number),
    ).toEqual([2]);
    expect(
      evaluateRules([{ rule: "referenced-by-vbrief", scope: "active" }], upstream, {
        vbriefActiveReferenced: new Set([2]),
      }).map((i) => i.number),
    ).toEqual([2]);
  });

  it("extractReferencedIssues walks vbrief graph", () => {
    const root = mkdtempSync(join(tmpdir(), "refs-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "story.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/42/" }],
        },
      }),
      "utf8",
    );
    const refs = extractReferencedIssues(root);
    expect(refs.any.has(42)).toBe(true);
    expect(refs.active.has(42)).toBe(true);
  });

  it("renderList handles milestone variants", () => {
    const out = renderList([
      { rule: "milestone", name: "v1" },
      { rule: "milestone", "any-of": ["a", "b"] },
      { rule: "milestone", "is-open": true },
      { rule: "opened-since", duration: "7d" },
    ]);
    expect(out).toContain("milestone name=");
    expect(out).toContain("milestone any-of=");
    expect(out).toContain("is-open=true");
  });
});

describe("milestone helpers", () => {
  it("collects subscribed names and is-open flag", () => {
    const rules = [
      { rule: "milestone", name: "A" },
      { rule: "milestone", "any-of": ["B"] },
      { rule: "milestone", "is-open": true },
    ];
    expect(collectMilestoneSubscribedNames(rules)).toEqual(new Set(["A", "B"]));
    expect(rulesRequestIsOpen(rules)).toBe(true);
  });

  it("evaluateMilestoneRuleInto name and any-of", () => {
    const matched = new Map<number, Record<string, unknown>>();
    evaluateMilestoneRuleInto({ rule: "milestone", name: "S1" }, upstream, matched, {
      getOpenMilestones: () => new Set(),
      isOpenIssue: (i) => i.state === "open",
      issueNumber: (i) => Number(i.number),
      milestoneName: (i) => String((i.milestone as { title: string })?.title ?? ""),
    });
    expect([...matched.keys()]).toEqual([2]);
  });

  it("inferRepoFromIssues html_url forms", () => {
    expect(inferRepoFromIssues([{ html_url: "https://github.com/o/r/issues/1" }])).toBe("o/r");
    expect(inferRepoFromIssues([{ html_url: "https://github.com/o/r" }])).toBe("o/r");
  });
});

describe("resolve and duration exports", () => {
  it("resolveScopeIgnores empty and parseDuration object", () => {
    const root = mkdtempSync(join(tmpdir(), "res-"));
    expect(resolveScopeIgnores(root).labels.size).toBe(0);
    expect(parseDuration("1h").ms).toBeGreaterThan(0);
    expect(resolveScopeRules(root)).toEqual([{ rule: "all-open" }]);
  });

  it("re-exports index surface", () => {
    expect(scopeIndex.subscriptionHash([{ rule: "all-open" }])).toHaveLength(16);
    expect(scopeIndex.CLI_HELP).toContain("triage_scope.py");
  });
});
