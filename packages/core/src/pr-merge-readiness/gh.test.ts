import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateMergeGateEnforcementAtStrategyStart } from "./compute.js";
import {
  applyMergeGateConfigure,
  buildMergeGateConfigurePayload,
  classifyMergeGateEnforcement,
  contextsFromBranchProtection,
  contextsFromBranchRules,
  defaultRunGh,
  encodeMergeGateScopePart,
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchPrBaseRef,
  fetchPrHeadShaRest,
  fetchRequiredStatusContexts,
  mergeGateEnforcementRecordPath,
  readMergeGateEnforcementRecord,
  resolveRepo,
  writeMergeGateEnforcementRecord,
} from "./gh.js";
import type { RunGhFn } from "./types.js";

describe("defaultRunGh", () => {
  it("rejects non-gh commands", () => {
    expect(defaultRunGh(["git", "status"]).returncode).toBe(-1);
  });
});

describe("fetchGreptileBodyRest paginate", () => {
  const runGh: RunGhFn = (cmd) => {
    if (cmd.join(" ").includes("/comments")) {
      const page1 = JSON.stringify([{ user: { login: "human" }, body: "first" }]);
      const page2 = JSON.stringify([
        { user: { login: "greptile-apps[bot]" }, body: "clean summary" },
      ]);
      return { returncode: 0, stdout: page1 + page2, stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };

  it("collapses paginated arrays", () => {
    const { body, error } = fetchGreptileBodyRest(1, "deftai/directive", runGh);
    expect(error).toBe("");
    expect(body).toBe("clean summary");
  });

  it("prefers the most recently updated Greptile summary over a later-created stale one", () => {
    const run: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([
        {
          user: { login: "greptile-apps[bot]" },
          body: "fresh head review",
          updated_at: "2026-07-20T03:00:00Z",
          created_at: "2026-07-20T01:00:00Z",
        },
        {
          user: { login: "greptile-apps[bot]" },
          body: "stale duplicate",
          updated_at: "2026-07-20T01:30:00Z",
          created_at: "2026-07-20T01:30:00Z",
        },
      ]),
      stderr: "",
    });
    expect(fetchGreptileBodyRest(1, "deftai/directive", run).body).toBe("fresh head review");
  });

  it("returns empty when no greptile comments", () => {
    const empty: RunGhFn = () => ({ returncode: 0, stdout: "[]", stderr: "" });
    expect(fetchGreptileBodyRest(1, "deftai/directive", empty).body).toBe("");
  });

  it("returns null on gh failure", () => {
    const fail: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "boom" });
    const result = fetchGreptileBodyRest(1, "deftai/directive", fail);
    expect(result.body).toBeNull();
    expect(result.error).toContain("failed");
  });

  it("returns null on invalid json", () => {
    const bad: RunGhFn = () => ({ returncode: 0, stdout: "{not-json", stderr: "" });
    const result = fetchGreptileBodyRest(1, "deftai/directive", bad);
    expect(result.body).toBeNull();
  });
});

describe("fetchPrHeadShaRest", () => {
  it("extracts head.sha", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: { sha: "abc1234" } }),
      stderr: "",
    });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).sha).toBe("abc1234");
  });

  it("handles empty body", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "", stderr: "" });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).sha).toBeNull();
  });

  it("handles malformed json", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "not-json", stderr: "" });
    expect(fetchPrHeadShaRest(1, "deftai/directive", runGh).error).toContain("parse");
  });
});

describe("fetchCheckRunsRest", () => {
  it("summarises check runs", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          { name: "Greptile Review", status: "completed", conclusion: "success" },
          { name: "CI", status: "completed", conclusion: "success" },
        ],
      }),
      stderr: "",
    });
    const { summary } = fetchCheckRunsRest("sha", "deftai/directive", runGh);
    expect(summary?.total).toBe(2);
    expect(summary?.greptile_review).toEqual({ status: "completed", conclusion: "success" });
  });

  it("returns normalized check run records", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            app: { id: 15368 },
          },
        ],
      }),
      stderr: "",
    });
    const result = fetchCheckRunsRest("sha", "deftai/directive", runGh);
    expect(result.checkRuns).toEqual([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        created_at: null,
        started_at: null,
        appId: 15368,
      },
    ]);
  });

  it("fails on missing check_runs list", () => {
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "{}", stderr: "" });
    expect(fetchCheckRunsRest("sha", "deftai/directive", runGh).summary).toBeNull();
  });
});

describe("required status contexts (#3234)", () => {
  it("parses rules/branches required_status_checks contexts with integration_id", () => {
    expect(
      contextsFromBranchRules([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "terraform-plan" },
              { context: "TypeScript (build + lint + test)", integration_id: 42 },
            ],
          },
        },
        { type: "pull_request" },
      ]),
    ).toEqual([
      { name: "terraform-plan" },
      { name: "TypeScript (build + lint + test)", appId: 42 },
    ]);
  });

  it("parses classic branch-protection contexts and app-bound checks", () => {
    expect(
      contextsFromBranchProtection({
        required_status_checks: {
          contexts: ["legacy-ci"],
          checks: [{ context: "modern-ci", app_id: 1 }],
        },
      }),
    ).toEqual([{ name: "legacy-ci" }, { name: "modern-ci", appId: 1 }]);
  });

  it("fetchRequiredStatusContexts unions rulesets + protection", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "terraform-plan" }],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (joined.includes("/protection")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            required_status_checks: { contexts: ["legacy-ci"], checks: [] },
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.contexts).toEqual([{ name: "legacy-ci" }, { name: "terraform-plan" }]);
    expect(result.sources).toEqual(["rulesets", "branch_protection"]);
    expect(result.resolutionFailed).toBe(false);
  });

  it("marks resolutionFailed on parse error with no successful source", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return { returncode: 0, stdout: "{not-json", stderr: "" };
      }
      if (joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "Branch not protected" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.contexts).toEqual([]);
    expect(result.error).toContain("parse");
  });

  it("marks resolutionFailed on nonzero exit with empty stderr", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.error).toMatch(/exit 1/);
  });

  it("marks resolutionFailed on exit-zero empty body", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("/protection")) {
        return { returncode: 1, stdout: "", stderr: "Branch not protected" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.error).toContain("empty body");
  });

  it("marks resolutionFailed when one source succeeds and the other hard-fails", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/rules/branches/")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "terraform-plan" }],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (joined.includes("/protection")) {
        return { returncode: 0, stdout: "{not-json", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
    };
    const result = fetchRequiredStatusContexts("o/r", "master", runGh);
    expect(result.resolutionFailed).toBe(true);
    expect(result.sources).toEqual(["rulesets"]);
    expect(result.contexts).toEqual([{ name: "terraform-plan" }]);
    expect(result.error).toContain("parse");
  });

  it("fetchPrBaseRef extracts base.ref", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ base: { ref: "master" }, head: { sha: "abc" } }),
      stderr: "",
    });
    expect(fetchPrBaseRef(1, "o/r", runGh).baseRef).toBe("master");
  });
});

describe("resolveRepo", () => {
  it("returns provided repo unchanged", () => {
    expect(resolveRepo("deftai/directive", vi.fn() as RunGhFn)).toEqual({
      repo: "deftai/directive",
      error: "",
    });
  });

  it("resolves from gh repo view", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: "deftai/directive\n",
      stderr: "",
    });
    expect(resolveRepo(null, runGh).repo).toBe("deftai/directive");
  });

  it("errors when gh fails", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "nope" });
    expect(resolveRepo(null, runGh).repo).toBeNull();
  });
});

describe("merge-gate enforcement readiness (#1517)", () => {
  it("classifies protected / absent / unknown from #3234 inventory", () => {
    expect(
      classifyMergeGateEnforcement({
        contexts: [{ name: "ci" }],
        sources: ["rulesets"],
        error: "",
        resolutionFailed: false,
      }),
    ).toBe("protected");
    expect(
      classifyMergeGateEnforcement({
        contexts: [],
        sources: ["branch_protection"],
        error: "",
        resolutionFailed: false,
      }),
    ).toBe("absent");
    expect(
      classifyMergeGateEnforcement({
        contexts: [],
        sources: [],
        error: "rules/branches: exit 1",
        resolutionFailed: true,
      }),
    ).toBe("unknown");
  });

  it("persists repo/branch-scoped decisions including cannot-configure", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-"));
    try {
      const written = writeMergeGateEnforcementRecord({
        projectRoot: rootDir,
        repo: "o/r",
        branch: "master",
        decision: "cannot-configure",
        reason: "admin 403",
        detection: "absent",
        recordedAt: "2026-09-29T00:00:00.000Z",
      });
      expect(written.ok).toBe(true);
      expect(written.record?.decision).toBe("cannot-configure");
      const read = readMergeGateEnforcementRecord(rootDir, "o/r", "master");
      expect(read.ok).toBe(true);
      expect(read.record?.decision).toBe("cannot-configure");
      expect(read.record?.reason).toBe("admin 403");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses empty required-context configure payloads", () => {
    const built = buildMergeGateConfigurePayload({ contexts: [], pinAppIds: true });
    expect(built.ok).toBe(false);
    expect(built.payload).toBeNull();
    expect(built.error).toMatch(/empty required-context PUT/i);
  });

  it("preserves existing required_pull_request_reviews on configure payload", () => {
    const built = buildMergeGateConfigurePayload(
      { contexts: [{ name: "quality", appId: 42 }], pinAppIds: true },
      {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        enforce_admins: true,
      },
    );
    expect(built.ok).toBe(true);
    expect(built.payload?.required_pull_request_reviews).toEqual({
      required_approving_review_count: 1,
    });
    expect(built.payload?.enforce_admins).toBe(true);
    expect((built.payload?.required_status_checks as { checks: unknown[] }).checks).toEqual([
      { context: "quality", app_id: 42 },
    ]);
  });

  it("maps GET-shaped protection objects into PUT-safe booleans and actor lists", () => {
    const built = buildMergeGateConfigurePayload(
      { contexts: [{ name: "quality" }], pinAppIds: false },
      {
        url: "https://api.github.com/repos/o/r/branches/master/protection",
        enforce_admins: { url: "https://example/enforce_admins", enabled: true },
        required_linear_history: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_pull_request_reviews: {
          url: "https://example/reviews",
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          dismissal_restrictions: {
            users: [{ login: "octocat" }],
            teams: [{ slug: "justice-league" }],
            apps: [{ slug: "octoapp" }],
          },
        },
        restrictions: {
          users: [{ login: "octocat" }],
          teams: [{ slug: "justice-league" }],
          apps: [{ slug: "super-ci" }],
        },
        required_signatures: { url: "https://example/sigs", enabled: true },
      },
    );
    expect(built.ok).toBe(true);
    expect(built.payload?.enforce_admins).toBe(true);
    expect(built.payload?.required_linear_history).toBe(true);
    expect(built.payload?.allow_force_pushes).toBe(false);
    expect(built.payload?.url).toBeUndefined();
    expect(built.payload?.required_signatures).toBeUndefined();
    expect(built.payload?.required_pull_request_reviews).toEqual({
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      dismissal_restrictions: {
        users: ["octocat"],
        teams: ["justice-league"],
        apps: ["octoapp"],
      },
    });
    expect(built.payload?.restrictions).toEqual({
      users: ["octocat"],
      teams: ["justice-league"],
      apps: ["super-ci"],
    });
  });

  it("keeps distinct record paths for release/a vs release_a", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-path-"));
    try {
      const slash = mergeGateEnforcementRecordPath(rootDir, "o/r", "release/a");
      const under = mergeGateEnforcementRecordPath(rootDir, "o/r", "release_a");
      expect(slash).not.toBe(under);
      expect(encodeMergeGateScopePart("release/a")).not.toBe(encodeMergeGateScopePart("release_a"));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses auto-promoting candidateContexts and maps write failure to cannot-configure", () => {
    const refused = applyMergeGateConfigure({
      repo: "o/r",
      branch: "master",
      proposal: {
        contexts: [],
        candidateContexts: [{ name: "harvested" }],
        pinAppIds: true,
      },
      runGh: () => ({ returncode: 0, stdout: "{}", stderr: "" }),
    });
    expect(refused.outcome).toBe("refused");
    expect(refused.error).toMatch(/candidates only/i);

    let putInputPath: string | undefined;
    const failed = applyMergeGateConfigure({
      repo: "o/r",
      branch: "master",
      proposal: { contexts: [{ name: "quality" }], pinAppIds: false },
      preserveExisting: false,
      runGh: (cmd) => {
        if (cmd.includes("PUT")) {
          const inputIdx = cmd.indexOf("--input");
          putInputPath = inputIdx >= 0 ? String(cmd[inputIdx + 1]) : undefined;
          return { returncode: 1, stdout: "", stderr: "Resource not accessible by integration" };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    });
    expect(failed.outcome).toBe("cannot-configure");
    expect(failed.error).toMatch(/cannot-configure/);
    expect(putInputPath).toBeDefined();
    expect(putInputPath).not.toBe("-");
  });

  it("sends configure JSON body via --input tempfile (not empty stdin dash)", () => {
    let capturedBody = "";
    let inputArg = "";
    const applied = applyMergeGateConfigure({
      repo: "o/r",
      branch: "master",
      proposal: { contexts: [{ name: "quality", appId: 7 }], pinAppIds: true },
      preserveExisting: false,
      runGh: (cmd) => {
        if (cmd.includes("PUT")) {
          const inputIdx = cmd.indexOf("--input");
          inputArg = inputIdx >= 0 ? String(cmd[inputIdx + 1]) : "";
          if (inputArg && inputArg !== "-" && existsSync(inputArg)) {
            capturedBody = readFileSync(inputArg, "utf8");
          }
          return { returncode: 0, stdout: "{}", stderr: "" };
        }
        return {
          returncode: 0,
          stdout: JSON.stringify({
            required_status_checks: {
              contexts: ["quality"],
              checks: [{ context: "quality", app_id: 7 }],
            },
          }),
          stderr: "",
        };
      },
    });
    expect(applied.outcome).toBe("configured");
    expect(inputArg).not.toBe("-");
    expect(capturedBody).toMatch(/"quality"/);
    expect(JSON.parse(capturedBody).required_status_checks.checks).toEqual([
      { context: "quality", app_id: 7 },
    ]);
  });
});

describe("merge-gate enforcement strategy-start gate (#1517)", () => {
  it("defers when SCM is not ready or repo is unresolved", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-start-"));
    try {
      const result = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: false,
        repo: null,
        branch: "master",
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
      });
      expect(result.ok).toBe(true);
      expect(result.decision).toBe("deferred-not-applicable");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("passes when required contexts are present and records configured", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-start-"));
    try {
      const result = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: true,
        repo: "o/r",
        branch: "master",
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
        fetchRequiredContextsFn: () => ({
          contexts: [{ name: "quality" }],
          sources: ["rulesets"],
          error: "",
          resolutionFailed: false,
        }),
      });
      expect(result.ok).toBe(true);
      expect(result.decision).toBe("configured");
      expect(result.detection).toBe("protected");
      const read = readMergeGateEnforcementRecord(rootDir, "o/r", "master");
      expect(read.record?.decision).toBe("configured");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed on absent inventory without a durable decision", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-start-"));
    try {
      const result = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: true,
        repo: "o/r",
        branch: "master",
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
        fetchRequiredContextsFn: () => ({
          contexts: [],
          sources: [],
          error: "",
          resolutionFailed: false,
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.detection).toBe("absent");
      expect(result.remediation).toMatch(/explicit-opt-out/i);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("honors explicit-opt-out and fails closed on unknown inventory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-start-"));
    try {
      writeMergeGateEnforcementRecord({
        projectRoot: rootDir,
        repo: "o/r",
        branch: "master",
        decision: "explicit-opt-out",
        reason: "operator declined",
        detection: "absent",
      });
      const opted = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: true,
        repo: "o/r",
        branch: "master",
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
        fetchRequiredContextsFn: () => ({
          contexts: [],
          sources: [],
          error: "",
          resolutionFailed: false,
        }),
      });
      expect(opted.ok).toBe(true);
      expect(opted.decision).toBe("explicit-opt-out");

      const unknownRoot = mkdtempSync(join(tmpdir(), "mge-unk-"));
      try {
        const unknown = evaluateMergeGateEnforcementAtStrategyStart({
          projectRoot: unknownRoot,
          scmReady: true,
          repo: "o/r",
          branch: "master",
          runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
          fetchRequiredContextsFn: () => ({
            contexts: [],
            sources: [],
            error: "403",
            resolutionFailed: true,
          }),
        });
        expect(unknown.ok).toBe(false);
        expect(unknown.detection).toBe("unknown");
      } finally {
        rmSync(unknownRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed when durable configured record is stale vs absent live inventory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-stale-"));
    try {
      writeMergeGateEnforcementRecord({
        projectRoot: rootDir,
        repo: "o/r",
        branch: "master",
        decision: "configured",
        reason: "was protected",
        detection: "protected",
        contexts: [{ name: "quality" }],
      });
      const stale = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: true,
        repo: "o/r",
        branch: "master",
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
        fetchRequiredContextsFn: () => ({
          contexts: [],
          sources: ["branch_protection"],
          error: "",
          resolutionFailed: false,
        }),
      });
      expect(stale.ok).toBe(false);
      expect(stale.decision).toBe("configured");
      expect(stale.detection).toBe("absent");
      expect(stale.message).toMatch(/stale/i);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails closed when autoRecordConfigured is false and no durable configured record exists", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "mge-norec-"));
    try {
      const result = evaluateMergeGateEnforcementAtStrategyStart({
        projectRoot: rootDir,
        scmReady: true,
        repo: "o/r",
        branch: "master",
        autoRecordConfigured: false,
        runGh: () => ({ returncode: 1, stdout: "", stderr: "unused" }),
        fetchRequiredContextsFn: () => ({
          contexts: [{ name: "quality" }],
          sources: ["rulesets"],
          error: "",
          resolutionFailed: false,
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.detection).toBe("protected");
      expect(result.message).toMatch(/no durable configured record/i);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
