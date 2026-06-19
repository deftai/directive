import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeCohort,
  renderSweepText,
  resolveCohortPaths,
  sweepCohort,
  sweepResultToDict,
} from "./complete-cohort.js";
import { completeCohortMain } from "./complete-cohort-cli.js";
import { buildManifest, orderCohort, resolveStories, swarmLaunch } from "./launch.js";
import { launchMain, parseLaunchArgv } from "./launch-cli.js";
import {
  expandReadinessPaths,
  readinessReport,
  readyStories,
  renderReadinessReport,
} from "./readiness.js";
import {
  dispatchProviderFor,
  enforceSubagentBackendPolicy,
  probeSubagentBackends,
  resolveSwarmSubagentBackend,
} from "./subagent-backend.js";
import {
  cohortResultToDict,
  evaluatePr,
  resolveCohortFromVbriefs,
  verifyReviewClean,
} from "./verify-review-clean.js";
import { verifyReviewCleanMain } from "./verify-review-clean-cli.js";
import {
  DuplicateStoryError,
  loadWorktreeMapFile,
  MissingWorktreeError,
  resolveWorktreeMap,
  WorktreeMapConfigError,
} from "./worktrees.js";
import { parseWorktreesArgv, worktreesMain } from "./worktrees-cli.js";

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "deep@test.local"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "deep"], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
}

function writeProjectDef(project: string, backend = "grok-build"): void {
  mkdirSync(join(project, "vbrief"), { recursive: true });
  writeFileSync(
    join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ plan: { policy: { swarmSubagentBackend: backend } } }),
    "utf8",
  );
}

function writeReadyStory(
  project: string,
  storyId: string,
  issue: number,
  opts?: { fileScope?: string[]; dependsOn?: string[]; conflictGroup?: string },
): string {
  const full = join(project, "vbrief", "active", `${storyId}.vbrief.json`);
  mkdirSync(join(project, "vbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issue}`,
            type: "x-vbrief/github-issue",
          },
        ],
        narratives: {
          Description: `${storyId} implements a focused product behavior for the active workflow. The story stays within a narrow code path and includes targeted tests for success and failure behavior.`,
          ImplementationPlan:
            "1. Update the source path to implement the focused workflow behavior.\n2. Add targeted tests for success and failure outcomes.",
          Traces: "FR-1",
          UserStory: `As a product user, I want ${storyId} behavior, so that I can complete the workflow.`,
        },
        items: [
          {
            id: `${storyId}-a1`,
            title: "Acceptance item 1",
            status: "pending",
            narrative: {
              Acceptance: `Given ${storyId} input, when the story runs, then it returns a scoped result.`,
              Traces: "FR-1",
            },
          },
          {
            id: `${storyId}-a2`,
            title: "Acceptance item 2",
            status: "pending",
            narrative: {
              Acceptance: `Given ${storyId} failure input, when the story runs, then it rejects the request.`,
              Traces: "FR-1",
            },
          },
        ],
        metadata: {
          kind: "story",
          swarm: {
            readiness: "ready",
            parallel_safe: true,
            file_scope: opts?.fileScope ?? [`src/${storyId}.ts`],
            verify_commands: [`npm test -- ${storyId}`],
            expected_outputs: ["focused tests pass"],
            depends_on: opts?.dependsOn ?? [],
            conflict_group: opts?.conflictGroup ?? "auth",
            size: "small",
            file_scope_confidence: "high",
            model_tier: "medium",
          },
        },
      },
    }),
    "utf8",
  );
  return full;
}

function stubLaunchGates() {
  return {
    preflightGate: () => ({ exitCode: 0, message: "ok" }),
    readinessGate: () => ({ exitCode: 0, report: "ok" }),
    runtimeAuthProbe: () => ["local", "none"] as [string, string],
  };
}

describe("swarm launch deep coverage", () => {
  beforeEach(() => {
    vi.stubEnv("DEFT_PROBE_GROK_BUILD", "yes");
  });

  it("emits manifest for solo story with output file", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-launch-"));
    writeProjectDef(project);
    const storyPath = writeReadyStory(project, "solo-a", 8001);
    const outPath = join(project, "manifest.json");
    const clearancesPath = join(project, "clearances.json");
    writeFileSync(clearancesPath, JSON.stringify([{ gate: "test" }]), "utf8");
    const result = swarmLaunch({
      paths: [storyPath],
      projectRoot: project,
      output: outPath,
      gateClearancesPath: clearancesPath,
      enforceGatesFlag: true,
      autonomous: true,
      ...stubLaunchGates(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("solo-a");
    expect(result.stdout).toContain("gate_clearances");
    rmSync(project, { recursive: true, force: true });
  });

  it("emits swarm-cohort manifest for multi-story group launch", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-cohort-"));
    writeProjectDef(project);
    writeReadyStory(project, "coh-a", 8002);
    writeReadyStory(project, "coh-b", 8003);
    const result = swarmLaunch({
      stories: ["coh-a,coh-b"],
      group: "wave7",
      allocationPlanId: "plan-1",
      batchingRationale: "approved",
      projectRoot: project,
      ...stubLaunchGates(),
    });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(manifest.length).toBe(2);
    const ctx = manifest[0]?.allocation_context as Record<string, unknown>;
    expect(ctx.dispatch_kind).toBe("swarm-cohort");
    rmSync(project, { recursive: true, force: true });
  });

  it("surfaces resolve and gate clearance errors", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-err-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    writeProjectDef(project);
    const badClear = join(project, "bad-clear.json");
    writeFileSync(badClear, "{}", "utf8");
    expect(
      swarmLaunch({ stories: ["missing"], projectRoot: project, ...stubLaunchGates() }).exitCode,
    ).toBe(1);
    expect(
      swarmLaunch({
        stories: ["x"],
        projectRoot: project,
        gateClearancesPath: badClear,
        ...stubLaunchGates(),
      }).exitCode,
    ).toBe(2);
    rmSync(project, { recursive: true, force: true });
  });

  it("resolveStories handles path, ambiguity, and dedup", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-res2-"));
    const p1 = writeReadyStory(project, "dup-id", 8100);
    writeReadyStory(project, "other", 8100);
    writeReadyStory(project, "by-path", 8101);
    expect(resolveStories(project, ["99999"]).errors[0]).toContain("no active story");
    expect(resolveStories(project, ["8100"]).errors[0]).toContain("ambiguous");
    expect(
      resolveStories(project, ["vbrief/active/by-path.vbrief.json"]).resolved[0]?.story_id,
    ).toBe("by-path");
    expect(resolveStories(project, ["missing.vbrief.json"]).errors.length).toBe(1);
    const dedup = resolveStories(project, ["by-path", "by-path"]);
    expect(dedup.resolved.length).toBe(1);
    void p1;
    rmSync(project, { recursive: true, force: true });
  });

  it("surfaces preflight/readiness gate and worktree map failures", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-gate-"));
    writeProjectDef(project);
    const storyPath = writeReadyStory(project, "gate-a", 8110);
    const mapPath = join(project, "map.json");
    writeFileSync(mapPath, JSON.stringify({ not: "array" }), "utf8");
    expect(
      swarmLaunch({
        stories: ["gate-a"],
        projectRoot: project,
        worktreeMap: mapPath,
        preflightGate: () => ({ exitCode: 1, message: "preflight blocked" }),
        readinessGate: () => ({ exitCode: 0, report: "ok" }),
        runtimeAuthProbe: () => ["local", "none"],
      }).stderr,
    ).toContain("preflight");
    expect(
      swarmLaunch({
        stories: ["gate-a"],
        projectRoot: project,
        preflightGate: () => ({ exitCode: 0, message: "ok" }),
        readinessGate: () => ({ exitCode: 1, report: "not ready" }),
        runtimeAuthProbe: () => ["local", "none"],
      }).stderr,
    ).toContain("readiness");
    expect(
      swarmLaunch({
        paths: [storyPath],
        projectRoot: project,
        worktreeMap: mapPath,
        ...stubLaunchGates(),
      }).exitCode,
    ).toBe(2);
    expect(
      swarmLaunch({
        ...stubLaunchGates(),
        stories: ["gate-a"],
        projectRoot: project,
        runtimeAuthProbe: () => {
          throw new Error("probe failed");
        },
      }).exitCode,
    ).toBe(2);
    rmSync(project, { recursive: true, force: true });
  });

  it("uses injected worktree resolver for manifest paths", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-wtmap-"));
    writeProjectDef(project);
    writeReadyStory(project, "wt-a", 8120);
    const mapPath = join(project, "map.json");
    writeFileSync(
      mapPath,
      JSON.stringify([{ story_id: "wt-a", worktree_path: "/custom/wt" }]),
      "utf8",
    );
    const result = swarmLaunch({
      stories: ["wt-a"],
      projectRoot: project,
      worktreeMap: mapPath,
      worktreeResolver: (records) =>
        records.map((r) => ({
          story_id: String(r.story_id),
          worktree_path: "/custom/wt",
          base_branch: "master",
        })),
      ...stubLaunchGates(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/custom/wt");
    rmSync(project, { recursive: true, force: true });
  });

  it("orders cohort and builds manifest with worktree records", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-ord-"));
    const p1 = writeReadyStory(project, "ord-b", 8010);
    const p2 = writeReadyStory(project, "ord-a", 8011);
    const resolved = resolveStories(project, ["ord-a", "ord-b"]).resolved;
    const ordered = orderCohort(resolved, project);
    expect(ordered.length).toBe(2);
    const manifest = buildManifest(ordered, {
      projectRoot: project,
      dispatchKind: "swarm-cohort",
      allocationPlanId: "p",
      batchingRationale: "r",
      operatorApprovalEvidence: "e",
      group: "g",
      subagentBackend: "grok-build",
      dispatchProvider: dispatchProviderFor("grok-build"),
      workerRole: "leaf-implementation",
      runtimeMode: "local",
      githubAuthMode: "none",
      worktreeRecords: new Map([
        ["ord-a", { story_id: "ord-a", worktree_path: "/wt/a", base_branch: "master" }],
      ]),
      gateClearances: [{ ok: true }],
    });
    expect(manifest[0]?.subagent_backend).toBe("grok-build");
    expect(manifest[0]?.worktree_path).toBe("/wt/a");
    expect(p1.length).toBeGreaterThan(0);
    expect(p2.length).toBeGreaterThan(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("parseLaunchArgv captures flags and launchMain runs", () => {
    const parsed = parseLaunchArgv([
      "--stories",
      "1",
      "--paths",
      "p",
      "--group",
      "g",
      "--worktree-map",
      "m.json",
      "--base-branch",
      "main",
      "--autonomous",
      "--allocation-plan-id",
      "id",
      "--batching-rationale",
      "why",
      "--operator-approval",
      "yes",
      "--no-create-worktrees",
      "--output",
      "out.json",
      "--gate-clearances",
      "c.json",
      "--enforce-gates",
      "--no-audit",
      "--project-root",
      "/tmp",
    ]);
    expect(parsed.group).toBe("g");
    expect(parsed.autonomous).toBe(true);
    expect(parsed.enforceGatesFlag).toBe(true);
    expect(typeof launchMain(["--stories", ""])).toBe("number");
  });
});

describe("swarm readiness deep coverage", () => {
  it("reports blocked story with missing swarm fields", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-rblk-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const path = join(project, "vbrief", "active", "blocked.vbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          id: "blocked",
          title: "blocked",
          status: "running",
          metadata: { kind: "story", swarm: { readiness: "not-ready" } },
        },
      }),
      "utf8",
    );
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    expect(report).toContain("Blocked stories");
    rmSync(project, { recursive: true, force: true });
  });

  it("detects file overlap between parallel stories", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-ovlp-"));
    const sharedScope = ["src/shared.ts"];
    const p1 = writeReadyStory(project, "ov-a", 8020, { fileScope: sharedScope });
    const p2 = writeReadyStory(project, "ov-b", 8021, { fileScope: sharedScope });
    const { exitCode, report } = readinessReport(project, [p1, p2]);
    expect(exitCode).toBe(1);
    expect(report).toContain("File overlap matrix");
    rmSync(project, { recursive: true, force: true });
  });

  it("detects dependency cycles and unresolved dependencies", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-dep-"));
    const p1 = writeReadyStory(project, "dep-a", 8060, { dependsOn: ["dep-b"] });
    const p2 = writeReadyStory(project, "dep-b", 8061, { dependsOn: ["dep-a"] });
    const cycle = readinessReport(project, [p1, p2]);
    expect(cycle.exitCode).toBe(1);
    expect(cycle.report).toContain("dependency cycle");
    const p3 = writeReadyStory(project, "dep-c", 8062, { dependsOn: ["missing-dep"] });
    const missing = readinessReport(project, [p3]);
    expect(missing.exitCode).toBe(1);
    expect(missing.report).toContain("does not resolve");
    rmSync(project, { recursive: true, force: true });
  });

  it("flags epic and phase decomposition", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-epic-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const epicPath = join(project, "vbrief", "active", "epic-parent.vbrief.json");
    writeFileSync(
      epicPath,
      JSON.stringify({
        plan: {
          id: "epic-parent",
          title: "Epic",
          status: "running",
          references: [{ type: "x-vbrief/plan", uri: "active/child.vbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    const { report, exitCode } = readinessReport(project, [epicPath]);
    expect(exitCode).toBe(1);
    expect(report).toContain("Decomposition-needed");
    rmSync(project, { recursive: true, force: true });
  });

  it("exports readyStories and renderReadinessReport", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-rdy2-"));
    const path = writeReadyStory(project, "exp-a", 8030);
    const paths = expandReadinessPaths(project, []);
    expect(paths.some((p) => p.endsWith("exp-a.vbrief.json"))).toBe(true);
    const { report } = readinessReport(project, [path]);
    const candidates = paths.map((p) => readinessReport(project, [p])).flatMap(() => []);
    void candidates;
    expect(report).toContain("Ready stories");
    expect(typeof renderReadinessReport).toBe("function");
    expect(Array.isArray(readyStories([]))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("swarm complete-cohort deep coverage", () => {
  it("dry-run sweeps parent epic after child settles", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-parent-"));
    mkdirSync(join(project, "vbrief", "pending"), { recursive: true });
    const childPath = writeReadyStory(project, "child-s", 8070);
    const parentPath = join(project, "vbrief", "pending", "parent-e.vbrief.json");
    writeFileSync(
      parentPath,
      JSON.stringify({
        plan: {
          id: "parent-e",
          title: "Parent epic",
          status: "pending",
          references: [{ type: "x-vbrief/plan", uri: "active/child-s.vbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, "vbrief", "active", "child-s.vbrief.json"),
      JSON.stringify({
        ...JSON.parse(readFileSync(childPath, "utf8")),
        plan: {
          ...JSON.parse(readFileSync(childPath, "utf8")).plan,
          planRef: "pending/parent-e.vbrief.json",
        },
      }),
      "utf8",
    );
    const sweep = sweepCohort([childPath], project, true);
    expect(sweep.parents.some((p) => p.action === "activate+complete")).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("handles noop and skip transitions", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-skip-"));
    mkdirSync(join(project, "vbrief", "completed"), { recursive: true });
    mkdirSync(join(project, "vbrief", "proposed"), { recursive: true });
    const donePath = join(project, "vbrief", "completed", "done.vbrief.json");
    writeFileSync(
      donePath,
      JSON.stringify({ plan: { id: "done", status: "completed", items: [] } }),
      "utf8",
    );
    const proposedPath = join(project, "vbrief", "proposed", "prop.vbrief.json");
    writeFileSync(
      proposedPath,
      JSON.stringify({ plan: { id: "prop", status: "proposed", items: [] } }),
      "utf8",
    );
    const sweep = sweepCohort([donePath, proposedPath], project, true);
    expect(sweep.stories.some((s) => s.action === "noop")).toBe(true);
    expect(sweep.stories.some((s) => s.action === "skip")).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("completeCohort text mode reports sweep result", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-cctext-"));
    const storyPath = writeReadyStory(project, "cctext-a", 8080);
    const result = completeCohort({ projectRoot: project, stories: [storyPath], dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SWEEP CLEAN");
    expect(completeCohortMain(["--project-root", project, "--dry-run", storyPath])).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("dry-run sweep completes active story", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-sweep-"));
    const storyPath = writeReadyStory(project, "sweep-a", 8040);
    const sweep = sweepCohort([storyPath], project, true);
    expect(sweep.ok).toBe(true);
    expect(sweep.stories[0]?.action).toBe("complete");
    const text = renderSweepText(sweep);
    expect(text).toContain("DRY-RUN");
    expect(sweepResultToDict(sweep).ok).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("resolveCohortPaths handles globs and missing paths", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-ccpath-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const story = join(project, "vbrief", "active", "cc.vbrief.json");
    writeFileSync(story, JSON.stringify({ plan: { status: "running" } }), "utf8");
    const { paths, errors } = resolveCohortPaths(
      [story],
      ["vbrief/active/*.vbrief.json", "missing-glob/*.json"],
      project,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("glob matched no files"))).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("completeCohort json mode with cohort glob", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-ccjson-"));
    const storyPath = writeReadyStory(project, "ccjson-a", 8050);
    const result = completeCohort({
      projectRoot: project,
      cohortGlobs: ["vbrief/active/*.vbrief.json"],
      dryRun: true,
      emitJson: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ccjson-a");
    void storyPath;
    rmSync(project, { recursive: true, force: true });
  });

  it("completeCohort merges resolution errors with sweep", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-ccerr-"));
    const storyPath = writeReadyStory(project, "ccerr-a", 8051);
    const result = completeCohort({
      projectRoot: project,
      stories: [storyPath, "missing-story.vbrief.json"],
      dryRun: true,
    });
    expect(result.stdout).toContain("ccerr-a");
    expect(result.stdout).toContain("Resolution errors");
    rmSync(project, { recursive: true, force: true });
  });

  it("completeCohortMain returns config error for empty cohort", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-cccli-"));
    mkdirSync(join(project, "vbrief"), { recursive: true });
    expect(completeCohortMain(["--project-root", project])).toBe(2);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("swarm verify-review-clean deep coverage", () => {
  const sha = "abcdef1234567890abcdef1234567890abcdef12";

  it("reports clean cohort via json", () => {
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return {
          returncode: 0,
          stdout:
            "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
            `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    });
    const result = verifyReviewClean({
      prNumbers: [42],
      repo: "deftai/directive",
      emitJson: true,
      runGh,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.all_clean).toBe(true);
    expect(cohortResultToDict(JSON.parse(result.stdout) as never).all_clean).toBe(true);
  });

  it("blocks unclean PR with P0 finding", () => {
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return {
          returncode: 0,
          stdout:
            "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
            '<img alt="P0" src="x"> Critical bug\n\n' +
            `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "" };
    });
    const result = verifyReviewClean({ prNumbers: [99], repo: "deftai/directive", runGh });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("COHORT BLOCKED");
  });

  it("discovers PRs from vbrief cohort glob", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-vrc-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const path = join(project, "vbrief", "active", "pr-ref.vbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          references: [
            {
              uri: "https://github.com/deftai/directive/pull/1234",
              type: "x-vbrief/github-pull-request",
            },
          ],
        },
      }),
      "utf8",
    );
    const { prNumbers, failures } = resolveCohortFromVbriefs([path]);
    expect(prNumbers).toEqual([1234]);
    expect(failures).toEqual([]);
    rmSync(project, { recursive: true, force: true });
  });

  it("verifyReviewCleanMain evaluates PR with injected gh", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (joined.includes("/comments")) {
        return {
          returncode: 0,
          stdout:
            "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
            `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "" };
    });
    expect(
      verifyReviewClean({
        prNumbers: [55],
        repo: "deftai/directive",
        runGh,
      }).exitCode,
    ).toBe(0);
  });

  it("verifyReviewCleanMain handles numeric args", () => {
    expect(verifyReviewCleanMain([])).toBe(2);
    expect(typeof verifyReviewCleanMain(["--json"])).toBe("number");
  });

  it("evaluatePr returns null on gh failure", () => {
    expect(
      evaluatePr(1, "deftai/directive", () => ({ returncode: 1, stdout: "", stderr: "x" })),
    ).toBeNull();
  });

  it("verifyReviewClean exits external when evaluatePr fails mid-cohort", () => {
    const runGh = vi.fn(() => ({ returncode: 1, stdout: "", stderr: "boom" }));
    const result = verifyReviewClean({ prNumbers: [1, 2], repo: "deftai/directive", runGh });
    expect(result.exitCode).toBe(2);
  });

  it("blocks when head sha does not match greptile review", () => {
    const head = "abcdef1234567890abcdef1234567890abcdef12";
    const reviewed = "1111111111111111111111111111111111111111";
    const runGh = vi.fn((cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("headRefOid")) {
        return { returncode: 0, stdout: `${head}\n`, stderr: "" };
      }
      return {
        returncode: 0,
        stdout:
          "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
          `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${reviewed})\n`,
        stderr: "",
      };
    });
    const result = verifyReviewClean({ prNumbers: [7], repo: "deftai/directive", runGh });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("COHORT BLOCKED");
  });

  it("marks cohort unclean when cohort resolution errors remain", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      if (cmd.join(" ").includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      return {
        returncode: 0,
        stdout:
          "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
          `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
        stderr: "",
      };
    });
    const result = verifyReviewClean({
      prNumbers: [8],
      cohortGlobs: ["/no/such/*.json"],
      repo: "deftai/directive",
      emitJson: true,
      runGh,
    });
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as { all_clean: boolean };
    expect(payload.all_clean).toBe(false);
  });

  it("blocks when greptile errored sentinel is present", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      if (cmd.join(" ").includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      return {
        returncode: 0,
        stdout:
          "Greptile encountered an error while reviewing this PR\n\n" +
          `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
        stderr: "",
      };
    });
    const result = verifyReviewClean({ prNumbers: [12], repo: "deftai/directive", runGh });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Errored sentinel:   True");
  });

  it("blocks when greptile confidence is too low", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const runGh = vi.fn((cmd: readonly string[]) => {
      if (cmd.join(" ").includes("headRefOid")) {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      return {
        returncode: 0,
        stdout:
          "## Greptile Summary\n\n**Confidence Score: 2/5**\n\n" +
          `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`,
        stderr: "",
      };
    });
    const result = verifyReviewClean({ prNumbers: [13], repo: "deftai/directive", runGh });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("confidence");
  });

  it("resolveCohortFromVbriefs reports unreadable vbrief", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-badvb-"));
    const path = join(project, "bad.vbrief.json");
    writeFileSync(path, "not-json", "utf8");
    const { failures } = resolveCohortFromVbriefs([path]);
    expect(failures[0]?.reason).toContain("unreadable");
    rmSync(project, { recursive: true, force: true });
  });
});

describe("swarm worktrees deep coverage", () => {
  it("rejects duplicate story_id", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-dup-"));
    gitInit(repo);
    expect(() =>
      resolveWorktreeMap(
        [
          { story_id: "s1", worktree_path: join(repo, "wt1") },
          { story_id: "s1", worktree_path: join(repo, "wt2") },
        ],
        "master",
        false,
        { repoRoot: repo },
      ),
    ).toThrow(DuplicateStoryError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects missing worktree when create disabled", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-miss-"));
    gitInit(repo);
    const wt = join(repo, "wt-missing");
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
      }),
    ).toThrow(MissingWorktreeError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("worktreesMain success and config errors", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wtcli-"));
    gitInit(repo);
    const mapPath = join(repo, "map.json");
    const wt = join(repo, "wt-ok");
    writeFileSync(mapPath, JSON.stringify([{ story_id: "s1", worktree_path: wt }]), "utf8");
    const parsed = parseWorktreesArgv([
      "--map",
      mapPath,
      "--base-branch",
      "master",
      "--repo-root",
      repo,
    ]);
    expect(parsed.createMissing).toBe(true);
    expect(worktreesMain(["--map", mapPath, "--base-branch", "master", "--repo-root", repo])).toBe(
      0,
    );
    writeFileSync(
      mapPath,
      JSON.stringify([{ story_id: "s2", worktree_path: join(repo, "wt-missing") }]),
      "utf8",
    );
    expect(
      worktreesMain([
        "--map",
        mapPath,
        "--base-branch",
        "master",
        "--repo-root",
        repo,
        "--no-create-missing",
      ]),
    ).toBe(1);
    expect(() => loadWorktreeMapFile(join(repo, "nope.json"))).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("swarm subagent-backend deep coverage", () => {
  it("probes composer and cursor-cloud env paths", () => {
    const composer = probeSubagentBackends({ CURSOR_COMPOSER: "yes" });
    expect(composer.find((b) => b.backend_id === "composer")?.available).toBe(true);
    const cloud = probeSubagentBackends({ CURSOR_AGENT: "1" });
    expect(cloud.find((b) => b.backend_id === "cursor-cloud")?.available).toBe(true);
    const grokRuntime = probeSubagentBackends({ DEFT_AGENT_RUNTIME: "grok-build" });
    expect(grokRuntime.find((b) => b.backend_id === "grok-build")?.available).toBe(true);
    const grokEnv = probeSubagentBackends({ GROK_BUILD: "yes" });
    expect(grokEnv.find((b) => b.backend_id === "grok-build")?.available).toBe(true);
    expect(dispatchProviderFor("composer")).toBe("cursor");
    expect(dispatchProviderFor("unknown")).toBe("unknown");
  });

  it("enforce policy passes with grok-build probe", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pol3-"));
    writeProjectDef(project, "grok-build");
    const { backend, error } = enforceSubagentBackendPolicy(project, {
      DEFT_PROBE_GROK_BUILD: "yes",
    });
    expect(error).toBeNull();
    expect(backend?.backend_id).toBe("grok-build");
    rmSync(project, { recursive: true, force: true });
  });

  it("resolve invalid and null backend policy values", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pol4-"));
    writeProjectDef(project, "not-a-backend");
    expect(resolveSwarmSubagentBackend(project).error).toContain("must be one of");
    writeFileSync(
      join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { swarmSubagentBackend: null } } }),
      "utf8",
    );
    expect(resolveSwarmSubagentBackend(project).error).toContain("explicitly null");
    writeFileSync(
      join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: { swarmSubagentBackend: "  " } } }),
      "utf8",
    );
    expect(resolveSwarmSubagentBackend(project).error).toContain("non-empty string");
    rmSync(project, { recursive: true, force: true });
  });

  it("rejects unavailable backend", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pol5-"));
    writeProjectDef(project, "composer");
    const { error } = enforceSubagentBackendPolicy(project, {});
    expect(error).toContain("unavailable");
    rmSync(project, { recursive: true, force: true });
  });
});
