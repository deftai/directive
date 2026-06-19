import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliCapture } from "./cli.js";
import { coveragePath, readCoverageDenominator, writeCoverageDenominator } from "./coverage.js";
import { validateMilestoneRule } from "./milestone.js";
import {
  addLabelToIgnores,
  addLabelToScope,
  addMilestoneToScope,
  computeDiffFromUpstream,
  renderDiffReport,
} from "./mutations.js";
import { addIgnore, subscribe } from "./mutations-core.js";
import { subscriptionHash } from "./normalize.js";
import { renderIgnores } from "./renderers.js";
import { resolveScopeIgnores } from "./resolve.js";
import { validateScopeIgnores, validateScopeRules } from "./validate.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "T", status: "running", items: [], policy } }, null, 2)}\n`,
    "utf8",
  );
}

describe("validateScopeRules extended", () => {
  it("warns on extra all-open keys", () => {
    const { warnings } = validateScopeRules([{ rule: "all-open", extra: "x" }]);
    expect(warnings[0]).toContain("ignoring extra keys");
  });

  it("rejects labels mutex and missing duration", () => {
    expect(
      validateScopeRules([{ rule: "labels", "any-of": ["a"], "all-of": ["b"] }]).errors[0],
    ).toContain("mutually exclusive");
    expect(validateScopeRules([{ rule: "opened-since", duration: "bad" }]).errors[0]).toContain(
      "invalid duration",
    );
    expect(
      validateScopeRules([{ rule: "explicit-watch", issues: [{ n: 1 }] }]).errors[0],
    ).toContain("note");
  });

  it("validates milestone variants", () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    validateMilestoneRule({ rule: "milestone" }, "plan.policy.triageScope[0]", errors, warnings);
    expect(errors[0]).toContain("requires one of");
    expect(validateScopeRules([{ rule: "milestone", "is-open": false }]).errors[0]).toContain(
      "false is meaningless",
    );
  });
});

describe("validateScopeIgnores", () => {
  it("accepts author rule and rejects unknown", () => {
    expect(validateScopeIgnores([{ rule: "author", "any-of": ["bot"] }]).errors).toEqual([]);
    expect(validateScopeIgnores([{ rule: "sunset-on", "any-of": ["x"] }]).errors[0]).toContain(
      "not a recognised ignore-rule",
    );
  });
});

describe("mutations", () => {
  it("subscribe label idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "mut-"));
    writePd(root);
    const [c1] = addLabelToScope(root, "bug");
    const [c2] = addLabelToScope(root, "bug");
    expect(c1).toBe(true);
    expect(c2).toBe(false);
  });

  it("add milestone and ignore label", () => {
    const root = mkdtempSync(join(tmpdir(), "mut-"));
    writePd(root);
    expect(addMilestoneToScope(root, "v1")[0]).toBe(true);
    expect(addLabelToIgnores(root, "wontfix")[0]).toBe(true);
    const ignores = resolveScopeIgnores(root);
    expect(ignores.labels.has("wontfix")).toBe(true);
  });

  it("computeDiffFromUpstream partitions sets", () => {
    const root = mkdtempSync(join(tmpdir(), "mut-"));
    writePd(root, {
      triageScope: [{ rule: "labels", "any-of": ["bug"] }],
      triageScopeIgnores: [{ label: "wontfix" }],
    });
    const report = computeDiffFromUpstream(root, {
      upstreamLabels: new Set(["bug", "wontfix", "new"]),
      upstreamMilestones: new Set(["M1"]),
      repo: "o/r",
    });
    expect(report.subscribedLabels.has("bug")).toBe(true);
    expect(report.ignoredLabels.has("wontfix")).toBe(true);
    expect(report.neitherLabels.has("new")).toBe(true);
    expect(renderDiffReport(report)).toContain("neither");
  });
});

describe("renderIgnores", () => {
  it("renders grouped ignores and empty state", () => {
    expect(renderIgnores([])).toContain("(none)");
    const text = renderIgnores([
      { label: "wontfix" },
      { milestone: "future" },
      { rule: "author", "any-of": ["dependabot[bot]"] },
    ]);
    expect(text).toContain("wontfix");
    expect(text).toContain("dependabot[bot]");
  });
});

describe("runCliCapture", () => {
  it("returns help when no action flags", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    writePd(root);
    const result = runCliCapture(["--project-root", root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("triage_scope.py");
  });

  it("rejects bad project root", () => {
    const result = runCliCapture(["--project-root", "/no/such/path", "--list"]);
    expect(result.code).toBe(2);
  });

  it("rejects mutually exclusive mutations", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    writePd(root);
    const result = runCliCapture([
      "--project-root",
      root,
      "--add-label=bug",
      "--ignore-label=wontfix",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("refresh denominator requires repo and count", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    writePd(root);
    expect(
      runCliCapture(["--project-root", root, "--refresh-denominator", "--count", "1"]).code,
    ).toBe(2);
    expect(
      runCliCapture(["--project-root", root, "--refresh-denominator", "--repo", "o/r"]).code,
    ).toBe(2);
  });

  it("writes coverage denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    const cache = mkdtempSync(join(tmpdir(), "cache-"));
    writePd(root, { triageScope: [{ rule: "all-open" }] });
    const result = runCliCapture([
      "--project-root",
      root,
      "--refresh-denominator",
      "--repo",
      "deftai/directive",
      "--count",
      "247",
      "--cache-root",
      cache,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote coverage denominator");
  });

  it("surfaces schema errors", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    writePd(root, { triageScope: [{ rule: "bogus" }] });
    const result = runCliCapture(["--project-root", root, "--list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("validation error");
  });

  it("diff-from-upstream requires repo", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-"));
    writePd(root);
    const result = runCliCapture(["--project-root", root, "--diff-from-upstream"]);
    expect(result.code).toBe(2);
  });
});

describe("coverage stale paths", () => {
  it("marks stale on hash mismatch and ttl", () => {
    const root = mkdtempSync(join(tmpdir(), "cov2-"));
    const path = coveragePath("github-issue", "o/r", { cacheRoot: root });
    const old = subscriptionHash([{ rule: "all-open" }]);
    const neu = subscriptionHash([{ rule: "labels", "any-of": ["bug"] }]);
    writeCoverageDenominator(path, { count: 10, subscriptionHashValue: old });
    expect(readCoverageDenominator(path, { currentHash: neu })?.stale).toBe(true);
  });
});

describe("subscribe errors", () => {
  it("requires project definition", () => {
    const root = mkdtempSync(join(tmpdir(), "sub-"));
    expect(() => subscribe(root, { label: "x" })).toThrow(/PROJECT-DEFINITION not found/);
  });

  it("addIgnore idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "sub-"));
    writePd(root);
    expect(addIgnore(root, "x")[0]).toBe(true);
    expect(addIgnore(root, "x")[0]).toBe(false);
  });
});
