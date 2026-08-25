import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storyQualityIssues as decomposeStoryQualityIssues } from "../scope/decompose.js";
import { readinessReport } from "../swarm/readiness.js";
import { READY_REQUIRES_PARALLEL_SAFE, storyQualityIssues } from "./story-quality.js";

const STORY_QUALITY_BASE = {
  title: "Auth model",
  description:
    "Auth model persistence stores user identity and session state. The story covers focused model changes plus matching unit tests for save and load behavior.",
  implementationPlan:
    "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n" +
    "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model.",
  userStory:
    "As an auth maintainer, I want persisted user records, so that login state survives requests.",
  acceptanceTexts: [
    "Given a valid user payload, when the auth model saves it, then the user record persists.",
    "Given an existing user, when the auth model loads it, then the saved identity returns.",
  ],
  acceptanceCountJustification: "",
  swarm: {
    file_scope: ["src/auth/model.ts", "tests/auth/model.test.ts"],
    verify_commands: ["npm test -- auth/model"],
    expected_outputs: ["ok"],
    depends_on: [],
    conflict_group: "auth",
    size: "M",
    file_scope_confidence: "high",
    model_tier: "medium",
    parallel_safe: false,
  },
};

const FULL_SWARM = {
  parallel_safe: false,
  size: "M",
  file_scope: ["src/auth/model.ts"],
  verify_commands: ["npm test -- auth/model"],
  expected_outputs: ["ok"],
  depends_on: [],
  conflict_group: "auth",
  file_scope_confidence: "high",
  model_tier: "medium",
};

const READINESS_STATES = ["ready", "sequential", "needs_refinement"] as const;

/** Tokens that name a readiness value as the thing to set next. */
const LAUNCH_REMEDIATION_READINESS = /use readiness=(sequential|needs_refinement|ready)/;

function writeStory(
  project: string,
  storyId: string,
  readiness: (typeof READINESS_STATES)[number],
): string {
  const full = join(project, "xbrief", "active", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        narratives: {
          Description:
            "Auth model persistence stores user identity and session state. The story covers focused model changes plus matching unit tests for save and load behavior.",
          ImplementationPlan:
            "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n" +
            "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model.",
          UserStory:
            "As an auth maintainer, I want persisted user records, so that login state survives requests.",
          Traces: "FR-1",
        },
        items: [
          {
            id: "a1",
            title: "A1",
            status: "pending",
            narrative: {
              Acceptance:
                "Given a valid user payload, when the auth model saves it, then the user record persists.",
              Traces: "FR-1",
            },
          },
          {
            id: "a2",
            title: "A2",
            status: "pending",
            narrative: {
              Acceptance:
                "Given an existing user, when the auth model loads it, then the saved identity returns.",
              Traces: "FR-1",
            },
          },
        ],
        metadata: { kind: "story", swarm: { ...FULL_SWARM, readiness } },
      },
    }),
    "utf8",
  );
  return full;
}

describe("READY_REQUIRES_PARALLEL_SAFE shared message (#3666 / #3252)", () => {
  it("does not recommend a readiness value that the launch path then rejects", () => {
    expect(READY_REQUIRES_PARALLEL_SAFE).toMatch(/parallel_safe=true/);
    expect(READY_REQUIRES_PARALLEL_SAFE).toMatch(/not eligible for concurrent swarm:launch/);
    expect(READY_REQUIRES_PARALLEL_SAFE).toMatch(/interactive swarm-skill solo-worker path/);
    expect(READY_REQUIRES_PARALLEL_SAFE).toMatch(/swarm:readiness exit 0 gates concurrent workers only/);
    expect(READY_REQUIRES_PARALLEL_SAFE).not.toMatch(LAUNCH_REMEDIATION_READINESS);
  });

  it("is the exact string both live validators emit", () => {
    expect(storyQualityIssues(STORY_QUALITY_BASE)).toContain(READY_REQUIRES_PARALLEL_SAFE);
    expect(decomposeStoryQualityIssues(STORY_QUALITY_BASE)).toContain(READY_REQUIRES_PARALLEL_SAFE);
  });
});

describe("launch-path parallel_safe=false readiness matrix (#3666)", () => {
  it("prints guidance that is not self-contradictory across readiness values", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-3666-"));
    const reports = Object.fromEntries(
      READINESS_STATES.map((readiness) => {
        const path = writeStory(project, `issue-3666-${readiness}`, readiness);
        const { exitCode, report } = readinessReport(project, [path]);
        return [readiness, { exitCode, report }];
      }),
    ) as Record<(typeof READINESS_STATES)[number], { exitCode: number; report: string }>;

    for (const readiness of READINESS_STATES) {
      expect(reports[readiness].exitCode, readiness).toBe(1);
      expect(reports[readiness].report, readiness).not.toMatch(LAUNCH_REMEDIATION_READINESS);
    }

    expect(reports.ready.report).toContain(READY_REQUIRES_PARALLEL_SAFE);
    expect(reports.sequential.report).toContain(
      "plan.metadata.swarm.readiness=ready for concurrent allocation",
    );
    expect(reports.needs_refinement.report).toContain(
      "plan.metadata.swarm.readiness=ready for concurrent allocation",
    );
    expect(reports.sequential.report).not.toContain(READY_REQUIRES_PARALLEL_SAFE);
    expect(reports.needs_refinement.report).not.toContain(READY_REQUIRES_PARALLEL_SAFE);

    rmSync(project, { recursive: true, force: true });
  });
});
