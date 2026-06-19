import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readinessReport } from "./readiness.js";
import { readinessMain } from "./readiness-cli.js";

function writeStory(
  project: string,
  storyId: string,
  swarm: Record<string, unknown>,
  folder = "active",
): string {
  const full = join(project, "vbrief", folder, `${storyId}.vbrief.json`);
  mkdirSync(join(project, "vbrief", folder), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: folder === "active" ? "running" : "pending",
        narratives: {
          Description: "A sufficiently long description for the story quality gate to pass.",
          ImplementationPlan: "1. First step.\n2. Second step.",
          UserStory: "As a user, I want this, so that it works.",
          Traces: "FR-1",
        },
        items: [
          {
            id: "a1",
            title: "A1",
            status: "pending",
            narrative: { Acceptance: "Given x when y then z.", Traces: "FR-1" },
          },
          {
            id: "a2",
            title: "A2",
            status: "pending",
            narrative: { Acceptance: "Given p when q then r.", Traces: "FR-1" },
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
      verify_commands: ["npm test"],
      expected_outputs: ["ok"],
      depends_on: [],
      conflict_group: "g",
      file_scope_confidence: "high",
      model_tier: "medium",
    });
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(1);
    expect(report).toContain("size=large");
    rmSync(project, { recursive: true, force: true });
  });

  it("propagates blocked dependency to dependent story", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-prop-"));
    const blockedPath = writeStory(project, "blocker", {
      readiness: "not-ready",
      parallel_safe: false,
      file_scope: ["src/b.ts"],
      verify_commands: ["npm test"],
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
      verify_commands: ["npm test"],
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
      verify_commands: ["npm test"],
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
      verify_commands: ["npm test"],
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
      verify_commands: ["npm test"],
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
