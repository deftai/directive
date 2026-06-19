import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, runCliCapture } from "./cli.js";
import {
  coveragePath,
  coverageTtlHours,
  formatCoverageDisplay,
  readCoverageDenominator,
  writeCoverageDenominator,
} from "./coverage.js";
import { parseDurationMs } from "./duration.js";
import { evaluateRules } from "./evaluate.js";
import { validateMilestoneRule } from "./milestone.js";
import { computeDiffFromUpstream } from "./mutations.js";
import { addIgnore, subscribe } from "./mutations-core.js";
import { subscriptionHash } from "./normalize.js";
import { pythonTypeName } from "./python-repr.js";
import { renderIgnores } from "./renderers.js";
import { resolveScopeRules } from "./resolve.js";
import { validateScopeIgnores, validateScopeRules } from "./validate.js";

describe("branch coverage boosters", () => {
  it("parseDurationMs covers all units and rejects", () => {
    expect(parseDurationMs("1s")).toBe(1000);
    expect(parseDurationMs("1m")).toBe(60_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
    expect(parseDurationMs("P1DT1H")).toBe(86_400_000 + 3_600_000);
    expect(() => parseDurationMs(7)).toThrow(/must be a string/);
    expect(() => parseDurationMs("")).toThrow(/non-empty/);
    expect(() => parseDurationMs("7x")).toThrow(/invalid duration/);
  });

  it("pythonTypeName covers primitive branches", () => {
    expect(pythonTypeName(null)).toBe("None");
    expect(pythonTypeName(true)).toBe("bool");
    expect(pythonTypeName(1)).toBe("int");
    expect(pythonTypeName(1.5)).toBe("float");
    expect(pythonTypeName("x")).toBe("str");
    expect(pythonTypeName({})).toBe("dict");
    expect(pythonTypeName([])).toBe("list");
  });

  it("coverage read rejects malformed and ttl stale", () => {
    const root = mkdtempSync(join(tmpdir(), "covb-"));
    const path = coveragePath("github-issue", "o/r", { cacheRoot: root });
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not-json", "utf8");
    expect(readCoverageDenominator(path, { currentHash: "x" })).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ count: -1, fetched_at: "x", subscription_hash: "y" }),
      "utf8",
    );
    expect(readCoverageDenominator(path, { currentHash: "y" })).toBeNull();
    const h = subscriptionHash([{ rule: "all-open" }]);
    const old = new Date("2020-01-01T00:00:00Z");
    writeCoverageDenominator(path, { count: 1, subscriptionHashValue: h, fetchedAt: old });
    const stale = readCoverageDenominator(path, { currentHash: h, ttlHours: 1, now: new Date() });
    expect(stale?.stale).toBe(true);
    expect(formatCoverageDisplay(1, stale)).toBe("1/?");
    expect(coverageTtlHours()).toBeGreaterThan(0);
  });

  it("evaluateRules handles empty label lists and closed issues", () => {
    const issues = [{ number: 9, state: "closed", labels: [] }];
    expect(evaluateRules([{ rule: "all-open" }], issues)).toEqual([]);
    expect(
      evaluateRules(
        [{ rule: "labels", "any-of": ["missing"] }],
        [{ number: 1, state: "open", labels: [] }],
      ),
    ).toEqual([]);
  });

  it("runCliCapture handles add-label and list combo", () => {
    const root = mkdtempSync(join(tmpdir(), "clib-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      `${JSON.stringify({ plan: { title: "T", status: "running", items: [] } })}\n`,
      "utf8",
    );
    const result = runCliCapture(["--project-root", root, "--add-label=bug", "--list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("bug");
  });

  it("coveragePath rejects malformed repo", () => {
    expect(() => coveragePath("github-issue", "bad")).toThrow(/owner\/name/);
  });

  it("validate and milestone error branches", () => {
    const errors: string[] = [];
    const warnings: string[] = [];
    validateMilestoneRule({ rule: "milestone", name: " ", "any-of": ["x"] }, "p", errors, warnings);
    expect(errors.some((e) => e.includes("mutually exclusive"))).toBe(true);
    expect(validateScopeRules([{ rule: "labels", "any-of": [""] }]).errors[0]).toContain(
      "non-empty string",
    );
    expect(validateScopeIgnores([{ label: "ok", milestone: "bad" }]).errors[0]).toContain(
      "mutually exclusive",
    );
    expect(
      validateScopeIgnores([{ rule: "author", "any-of": ["", 1 as unknown as string] }]).errors
        .length,
    ).toBeGreaterThan(0);
  });

  it("mutations-core throws on malformed project definition", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), '{"plan": []}', "utf8");
    expect(() => subscribe(root, { label: "x" })).toThrow(/non-object 'plan'/);
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      '{"plan": {"policy": []}}',
      "utf8",
    );
    expect(() => addIgnore(root, "x")).toThrow(/non-object 'plan.policy'/);
  });

  it("computeDiff includes is-open milestone snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "diffb-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: { triageScope: [{ rule: "milestone", "is-open": true }] },
        },
      }),
      "utf8",
    );
    const report = computeDiffFromUpstream(root, {
      upstreamLabels: new Set(),
      upstreamMilestones: new Set(["OpenMs"]),
      openMilestonesSnapshot: new Set(["OpenMs"]),
    });
    expect(report.subscribedMilestones.has("OpenMs")).toBe(true);
  });

  it("renderIgnores handles malformed entries", () => {
    expect(renderIgnores([null as unknown as Record<string, unknown>, { unknown: 1 }])).toContain(
      "unrecognised",
    );
  });

  it("resolveScopeRules handles non-object plan branches", () => {
    const root = mkdtempSync(join(tmpdir(), "resb-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: null }),
      "utf8",
    );
    expect(resolveScopeRules(root)).toEqual([{ rule: "all-open" }]);
  });

  it("evaluateRules opened and updated since branches", () => {
    const now = new Date("2026-05-17T20:00:00Z");
    const issues = [
      {
        number: 1,
        state: "open",
        created_at: "2026-05-17T00:00:00Z",
        updated_at: "2026-05-17T00:00:00Z",
      },
      {
        number: 2,
        state: "open",
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
    ];
    expect(
      evaluateRules([{ rule: "opened-since", duration: "7d" }], issues, { now }).map(
        (i) => i.number,
      ),
    ).toEqual([1]);
    expect(
      evaluateRules([{ rule: "updated-since", duration: "7d" }], issues, { now }).map(
        (i) => i.number,
      ),
    ).toEqual([1]);
  });

  it("run() entry returns process exit code", () => {
    expect(run(["--project-root", "/missing-deft-path-xyz", "--list"])).toBe(2);
  });

  it("runCliCapture ignore-label no-op goes to stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "clin-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: { triageScopeIgnores: [{ label: "wontfix" }] },
        },
      }),
      "utf8",
    );
    const result = runCliCapture(["--project-root", root, "--ignore-label=wontfix"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no-op");
  });
});
