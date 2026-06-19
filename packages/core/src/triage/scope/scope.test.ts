import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coveragePath,
  formatCoverageDisplay,
  readCoverageDenominator,
  writeCoverageDenominator,
} from "./coverage.js";
import { parseDurationMs } from "./duration.js";
import { evaluateRules } from "./evaluate.js";
import { inferRepoFromIssues } from "./milestone.js";
import { subscriptionHash } from "./normalize.js";
import { renderList } from "./renderers.js";
import { resolveScopeRules } from "./resolve.js";
import { validateScopeRules } from "./validate.js";

function writePd(root: string, plan: Record<string, unknown>): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    "utf8",
  );
}

const upstream = [
  {
    number: 1,
    state: "open",
    labels: [{ name: "bug" }, { name: "regression" }],
    created_at: "2026-05-15T00:00:00Z",
    updated_at: "2026-05-17T00:00:00Z",
  },
  {
    number: 2,
    state: "open",
    labels: [{ name: "epic" }],
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-12T00:00:00Z",
  },
  {
    number: 4,
    state: "closed",
    labels: [{ name: "bug" }],
    created_at: "2026-05-16T00:00:00Z",
    updated_at: "2026-05-16T00:00:00Z",
  },
];

const now = new Date("2026-05-17T20:00:00Z");

describe("validateScopeRules", () => {
  it("accepts none and empty list", () => {
    expect(validateScopeRules(null).errors).toEqual([]);
    expect(validateScopeRules([]).errors).toEqual([]);
  });

  it("rejects non-list", () => {
    const { errors } = validateScopeRules({ rule: "all-open" });
    expect(errors[0]).toContain("must be a list");
  });

  it("accepts milestone exact match", () => {
    const { errors } = validateScopeRules([{ rule: "milestone", name: "v2.0-blocker" }]);
    expect(errors).toEqual([]);
  });

  it("rejects unknown rule type", () => {
    const { errors } = validateScopeRules([{ rule: "bogus-type" }]);
    expect(errors[0]).toContain("not a valid rule type");
  });
});

describe("resolveScopeRules", () => {
  it("defaults when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-"));
    writePd(root, { title: "x", status: "running", items: [] });
    expect(resolveScopeRules(root)).toEqual([{ rule: "all-open" }]);
  });

  it("returns custom scope", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-"));
    const custom = [{ rule: "labels", "any-of": ["bug"] }];
    writePd(root, { title: "x", status: "running", items: [], policy: { triageScope: custom } });
    expect(resolveScopeRules(root)).toEqual(custom);
  });
});

describe("evaluateRules", () => {
  it("all-open returns open issues only", () => {
    const matched = evaluateRules([{ rule: "all-open" }], upstream, { now });
    expect(matched.map((m) => m.number)).toEqual([1, 2]);
  });

  it("labels any-of", () => {
    const matched = evaluateRules([{ rule: "labels", "any-of": ["bug"] }], upstream, { now });
    expect(matched.map((m) => m.number)).toEqual([1]);
  });

  it("explicit-watch includes closed", () => {
    const matched = evaluateRules(
      [{ rule: "explicit-watch", issues: [{ n: 4, note: "watch" }] }],
      upstream,
      { now },
    );
    expect(matched.map((m) => m.number)).toEqual([4]);
  });

  it("milestone is-open uses fetcher once", () => {
    let calls = 0;
    const matched = evaluateRules(
      [{ rule: "milestone", "is-open": true }],
      [
        {
          number: 10,
          state: "open",
          milestone: { title: "Sprint 1" },
          repository_url: "https://api.github.com/repos/o/r",
        },
      ],
      {
        now,
        openMilestonesFetcher: () => {
          calls += 1;
          return new Set(["Sprint 1"]);
        },
      },
    );
    expect(calls).toBe(1);
    expect(matched.map((m) => m.number)).toEqual([10]);
  });
});

describe("subscriptionHash", () => {
  it("is stable across key order", () => {
    const h1 = subscriptionHash([{ rule: "labels", "any-of": ["bug", "regression"] }]);
    const h2 = subscriptionHash([{ "any-of": ["regression", "bug"], rule: "labels" }]);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });
});

describe("parseDurationMs", () => {
  it("parses compact and iso forms", () => {
    expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs("PT24H")).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects invalid", () => {
    expect(() => parseDurationMs("abc")).toThrow(/invalid duration/);
  });
});

describe("coverage cache", () => {
  it("write then read fresh record", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-"));
    const path = coveragePath("github-issue", "owner/repo", { cacheRoot: root });
    const h = subscriptionHash([{ rule: "all-open" }]);
    const written = writeCoverageDenominator(path, { count: 247, subscriptionHashValue: h });
    expect(written.stale).toBe(false);
    const read = readCoverageDenominator(path, { currentHash: h });
    expect(read?.count).toBe(247);
    expect(read?.stale).toBe(false);
  });

  it("formatCoverageDisplay stale", () => {
    expect(formatCoverageDisplay(125, null)).toBe("125/?");
  });
});

describe("renderList", () => {
  it("includes default annotation", () => {
    const out = renderList([{ rule: "all-open" }], { isDefault: true });
    expect(out).toContain("default applied");
    expect(out).toContain("subscription-hash:");
  });

  it("matches canonical label format", () => {
    const out = renderList(
      [
        { rule: "all-open" },
        { rule: "labels", "any-of": ["bug", "regression"] },
        { rule: "explicit-watch", issues: [{ n: 99, note: "pinned" }] },
      ],
      { isDefault: false },
    );
    expect(out).toContain("labels any-of=['bug', 'regression']");
    expect(out).toContain("#99  (pinned)");
  });
});

describe("inferRepoFromIssues", () => {
  it("accepts api.github.com repository_url", () => {
    expect(
      inferRepoFromIssues([{ repository_url: "https://api.github.com/repos/deftai/directive" }]),
    ).toBe("deftai/directive");
  });

  it("rejects spoofed subdomain", () => {
    expect(
      inferRepoFromIssues([{ html_url: "https://evil-github.com.attacker.com/o/r/issues/1" }]),
    ).toBeNull();
  });
});
