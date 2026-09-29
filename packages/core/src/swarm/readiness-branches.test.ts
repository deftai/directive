import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingRequiredSwarmFields } from "../vbrief-validation/story-quality.js";
import { enforceGates, type ResolvedStory } from "./launch.js";
import { readinessReport, SWARM_BLOCK_REMEDIATION_HINT, scaffoldSwarmDraft } from "./readiness.js";
import { readinessMain } from "./readiness-cli.js";

function writeStory(
  project: string,
  storyId: string,
  swarm: Record<string, unknown>,
  folder = "active",
): string {
  const full = join(project, "xbrief", folder, `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", folder), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: folder === "active" ? "running" : "pending",
        narratives: {
          Description:
            "This story implements a focused workflow change in the named source path. It keeps the behavior narrow and records success and failure outcomes for verification.",
          ImplementationPlan:
            "1. Update packages/core/src/swarm/readiness.ts to apply the documented field mode.\n2. Add targeted vitest coverage under packages/core/src/swarm/readiness-branches.test.ts for success and failure.",
          UserStory:
            "As a product user, I want focused readiness behavior, so that I can launch solo headless work.",
          Traces: "FR-1",
        },
        items: [
          {
            id: "a1",
            title: "A1",
            status: "pending",
            narrative: {
              Acceptance:
                "Given a solo-headless candidate with load-bearing swarm fields, when readiness runs, then it exits 0 without ceremony fields.",
              Traces: "FR-1",
            },
          },
          {
            id: "a2",
            title: "A2",
            status: "pending",
            narrative: {
              Acceptance:
                "Given a scaffold request without operator-named file_scope, when scaffold runs, then it returns a refused error.",
              Traces: "FR-1",
            },
          },
        ],
        metadata: { kind: "story", swarm },
      },
    }),
    "utf8",
  );
  return full;
}

describe("readiness branch coverage", () => {
  it("blocks large parallel_safe stories", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-large-"));
    const path = writeStory(project, "large-a", {
      readiness: "ready",
      parallel_safe: true,
      size: "large",
      file_scope: ["src/a.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: [],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    // Same message family as scope:decompose --check validateDraft (#3252).
    expect(report).toContain("size=large cannot be parallel_safe=true");
    rmSync(project, { recursive: true, force: true });
  });

  it("propagates blocked dependency to dependent story", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-prop-"));
    const blockedPath = writeStory(project, "blocker", {
      readiness: "not-ready",
      parallel_safe: false,
      file_scope: ["src/b.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: [],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const depPath = writeStory(project, "dependent", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/d.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: ["blocker"],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const { report } = readinessReport(project, [blockedPath, depPath]);
    expect(report).toContain("dependency");
    rmSync(project, { recursive: true, force: true });
  });

  it("readinessMain reports on explicit story paths", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-rmain-"));
    const path = writeStory(project, "rmain-a", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/r.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: [],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    expect(readinessMain(["--project-root", project, path])).toBe(1);
    rmSync(project, { recursive: true, force: true });
  });

  it("lists missing required swarm metadata fields", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-miss-"));
    const path = writeStory(project, "miss-a", { readiness: "ready", parallel_safe: true });
    const { report, exitCode } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    expect(report).toContain("Missing fields");
    rmSync(project, { recursive: true, force: true });
  });

  it("flags non-boolean parallel_safe", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pbool-"));
    const path = writeStory(project, "pbool-a", { readiness: "ready", parallel_safe: "yes" });
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    expect(report).toContain("parallel_safe");
    rmSync(project, { recursive: true, force: true });
  });

  it("blocks when external dependency is not completed", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-extdep-"));
    writeStory(project, "ext-dep", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/e.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: [],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const path = writeStory(project, "needs-ext", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/n.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      expected_outputs: ["ok"],
      depends_on: ["ext-dep"],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    expect(report).toContain("not completed");
    rmSync(project, { recursive: true, force: true });
  });
});

describe("swarm readiness #3718", () => {
  it("solo-headless relaxes ceremony fields but keeps file_scope/verify_commands", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-3718-solo-"));
    const path = writeStory(project, "solo-a", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/solo.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      depends_on: [],
      size: "small",
      file_scope_confidence: "high",
      // ceremony omitted: expected_outputs, conflict_group, model_tier
    });
    const concurrent = readinessReport(project, [path]);
    expect(concurrent.exitCode).toBe(1);
    expect(concurrent.report).toContain("expected_outputs");
    expect(concurrent.report).toContain(SWARM_BLOCK_REMEDIATION_HINT);

    const solo = readinessReport(project, [path], { soloHeadless: true });
    expect(solo.exitCode).toBe(0);
    expect(solo.report).toContain("solo-headless");
    expect(solo.report).not.toContain("plan.metadata.swarm.expected_outputs");
    rmSync(project, { recursive: true, force: true });
  });

  it("scaffold writes operator-named swarm fields and refuses empty file_scope", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-3718-scaf-"));
    const path = writeStory(project, "scaf-a", {});
    const refused = scaffoldSwarmDraft({
      projectRoot: project,
      vbriefPath: path,
      fileScope: [],
      verifyCommands: ["npm test"],
      size: "small",
      fileScopeConfidence: "high",
      readiness: "ready",
      parallelSafe: true,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toMatch(/operator-named --file-scope/);
    }

    const ok = scaffoldSwarmDraft({
      projectRoot: project,
      vbriefPath: path,
      fileScope: ["packages/core/src/swarm/readiness.ts"],
      verifyCommands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      size: "small",
      fileScopeConfidence: "high",
      readiness: "ready",
      parallelSafe: true,
    });
    expect(ok.ok).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      plan: { metadata: { swarm: Record<string, unknown> } };
    };
    expect(raw.plan.metadata.swarm.file_scope).toEqual(["packages/core/src/swarm/readiness.ts"]);
    expect(raw.plan.metadata.swarm.depends_on).toEqual([]);
    expect(raw.plan.metadata.swarm).not.toHaveProperty("expected_outputs");

    const after = readinessReport(project, [path], { soloHeadless: true });
    expect(after.exitCode).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("readinessMain --scaffold persists and --solo-headless clears ceremony gaps", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-3718-main-"));
    const path = writeStory(project, "main-a", {});
    const code = readinessMain([
      "--project-root",
      project,
      "--scaffold",
      path,
      "--file-scope",
      "src/main.ts",
      "--verify-command",
      "pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts",
      "--size",
      "small",
      "--file-scope-confidence",
      "high",
      "--readiness",
      "ready",
      "--parallel-safe",
      "true",
    ]);
    expect(code).toBe(0);
    const rel = "xbrief/active/main-a.xbrief.json";
    expect(readinessMain(["--project-root", project, "--solo-headless", rel])).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("enforceGates passes soloHeadless only for N=1 cohorts", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-3718-enf-"));
    const path = writeStory(project, "enf-a", {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/e.ts"],
      verify_commands: ["pnpm exec vitest run packages/core/src/swarm/readiness-branches.test.ts"],
      depends_on: [],
      size: "small",
      file_scope_confidence: "high",
    });
    const story: ResolvedStory = {
      token: path,
      story_id: "enf-a",
      path,
      relpath: "xbrief/active/enf-a.xbrief.json",
    };
    const seen: Array<boolean | undefined> = [];
    const fail = enforceGates(
      [story, { ...story, story_id: "enf-b", token: "b" }],
      project,
      () => ({
        exitCode: 0,
        message: "ok",
      }),
      (_p, _r, options) => {
        seen.push(options?.soloHeadless);
        return { exitCode: 1, report: "missing ceremony" };
      },
    );
    expect(fail).not.toBeNull();
    expect(seen[0]).toBe(false);

    seen.length = 0;
    const ok = enforceGates(
      [story],
      project,
      () => ({ exitCode: 0, message: "ok" }),
      (_p, _r, options) => {
        seen.push(options?.soloHeadless);
        return { exitCode: 0, report: "ready" };
      },
    );
    expect(ok).toBeNull();
    expect(seen[0]).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("missingRequiredSwarmFields mode locks ceremony vs load-bearing split", () => {
    expect(missingRequiredSwarmFields({}, "solo-headless")).toEqual(
      expect.arrayContaining([
        "plan.metadata.swarm.file_scope",
        "plan.metadata.swarm.verify_commands",
        "plan.metadata.swarm.depends_on",
        "plan.metadata.swarm.size",
        "plan.metadata.swarm.file_scope_confidence",
      ]),
    );
    expect(missingRequiredSwarmFields({}, "solo-headless")).not.toContain(
      "plan.metadata.swarm.expected_outputs",
    );
    expect(missingRequiredSwarmFields({}, "concurrent")).toContain(
      "plan.metadata.swarm.expected_outputs",
    );
  });
});
