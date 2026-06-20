import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, looksLikePath, resolveStories } from "./launch.js";
import { readinessReport } from "./readiness.js";
import { enforceSubagentBackendPolicy, probeSubagentBackends } from "./subagent-backend.js";

function writeReadyStory(project: string, storyId: string, issue: number): string {
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
            file_scope: [`src/${storyId}.ts`],
            verify_commands: [`npm test -- ${storyId}`],
            expected_outputs: ["focused tests pass"],
            depends_on: [],
            conflict_group: "auth",
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

describe("swarm readiness + launch", () => {
  it("reports ready story exit 0", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-rdy-"));
    const path = writeReadyStory(project, "rdy-a", 7001);
    const { exitCode, report } = readinessReport(project, [path]);
    expect(exitCode).toBe(0);
    expect(report).toContain("Ready stories:");
    rmSync(project, { recursive: true, force: true });
  });

  it("resolves issue number to active story", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-res-"));
    writeReadyStory(project, "res-a", 7100);
    const { resolved, errors } = resolveStories(project, ["7100"]);
    expect(errors).toEqual([]);
    expect(resolved[0]?.story_id).toBe("res-a");
    rmSync(project, { recursive: true, force: true });
  });

  it("builds manifest with allocation context", () => {
    const story = {
      token: "x",
      story_id: "s1",
      path: "/p/a.vbrief.json",
      relpath: "vbrief/active/a.vbrief.json",
    };
    const manifest = buildManifest([story], {
      projectRoot: "/proj",
      dispatchKind: "solo",
      allocationPlanId: null,
      batchingRationale: "test",
      operatorApprovalEvidence: "evidence",
    });
    expect(manifest[0]?.story_id).toBe("s1");
    expect((manifest[0]?.allocation_context as Record<string, unknown>).dispatch_kind).toBe("solo");
  });

  it("looksLikePath distinguishes numeric tokens", () => {
    expect(looksLikePath("100")).toBe(false);
    expect(looksLikePath("a.vbrief.json")).toBe(true);
  });

  it("safeSegment strips leading/trailing separators with byte-identical output (#1822)", () => {
    // Reference oracle: the original regex semantics this fix replaced.
    const oracle = (raw: string): string => {
      let cleaned = "";
      for (const ch of raw.trim()) {
        cleaned +=
          (ch >= "A" && ch <= "Z") ||
          (ch >= "a" && ch <= "z") ||
          (ch >= "0" && ch <= "9") ||
          ch === "." ||
          ch === "_" ||
          ch === "-"
            ? ch
            : "-";
      }
      cleaned = cleaned.replace(/^[-.]+|[-.]+$/g, "");
      return cleaned.length > 0 ? cleaned : "story";
    };
    const branchOf = (storyId: string): string => {
      const manifest = buildManifest(
        [{ token: "x", story_id: storyId, path: "/p/a.json", relpath: "r" }],
        {
          projectRoot: "/proj",
          dispatchKind: "solo",
          allocationPlanId: null,
          batchingRationale: "t",
          operatorApprovalEvidence: "e",
        },
      );
      return (manifest[0]?.branch as string).replace(/^swarm\//, "");
    };
    for (const input of [
      "s1",
      "----abc----",
      "..weird..name..",
      "-.-.-.-.",
      "feature/Some Thing!",
      "trailing---",
      "---leading",
      "a-b.c_d",
    ]) {
      expect(branchOf(input)).toBe(oracle(input));
    }
  });

  it("safeSegment runs in linear time on pathological separator runs (#1822)", () => {
    const evil = `${"-".repeat(100_000)}story${"-".repeat(100_000)}`;
    const started = Date.now();
    const manifest = buildManifest(
      [{ token: "x", story_id: evil, path: "/p/a.json", relpath: "r" }],
      {
        projectRoot: "/proj",
        dispatchKind: "solo",
        allocationPlanId: null,
        batchingRationale: "t",
        operatorApprovalEvidence: "e",
      },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(manifest[0]?.branch).toBe("swarm/story");
  });
});

describe("swarm subagent backend", () => {
  it("probes backends with env override", () => {
    const probed = probeSubagentBackends({ DEFT_PROBE_GROK_BUILD: "yes" });
    const grok = probed.find((b) => b.backend_id === "grok-build");
    expect(grok?.available).toBe(true);
  });

  it("fails policy when backend unset", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-pol-"));
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(
      join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ plan: { policy: {} } }),
      "utf8",
    );
    const { error } = enforceSubagentBackendPolicy(project);
    expect(error).toContain("swarmSubagentBackend");
    rmSync(project, { recursive: true, force: true });
  });
});
