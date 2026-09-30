import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countNonEmptyTrackedPlanningNarratives,
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluatePersistedPlanningNarratives,
  evaluateTrackedPlanningNarrativesBag,
} from "./persisted-planning-narratives.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pd-planning-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

function writePd(root: string, narratives: Record<string, string>): void {
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "fixture", created: "2026-09-30T00:00:00Z" },
      plan: {
        title: "fixture",
        status: "running",
        narratives,
        items: [],
      },
    }),
    "utf8",
  );
}

describe("persisted planning narratives (#5176 Prefer-A)", () => {
  it("empty Overview+tech stack bag fails closed", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: {
        Overview: "",
        "tech stack": "   ",
        Architecture: "",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(1);
    expect(result.persistedFields).toBe(0);
    expect(result.cause).toBe(EMPTY_PLANNING_NARRATIVES_CAUSE);
    expect(result.remedy).toContain("project:write-narratives");
  });

  it("one non-empty Overview passes", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: {
        Overview: "Greenfield demo app",
        "tech stack": "",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.persistedFields).toBe(1);
  });

  it("Phase 2 TechStack alias counts as tech stack", () => {
    expect(
      countNonEmptyTrackedPlanningNarratives({
        Overview: "",
        TechStack: "TypeScript + vitest",
      }),
    ).toBe(1);
  });

  it("whitespace-only values do not count", () => {
    expect(
      countNonEmptyTrackedPlanningNarratives({
        Overview: "\n\t  ",
        TechStack: " ",
      }),
    ).toBe(0);
  });

  it("on-disk empty skeleton fails; one filled field passes", () => {
    const emptyRoot = tempRoot();
    writePd(emptyRoot, {
      Overview: "",
      "tech stack": "",
      Architecture: "",
      RisksAndUnknowns: "",
      Configuration: "",
    });
    const empty = evaluatePersistedPlanningNarratives(emptyRoot);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.persistedFields).toBe(0);

    const filledRoot = tempRoot();
    writePd(filledRoot, {
      Overview: "",
      "tech stack": "Python 3.12",
      Architecture: "",
    });
    const filled = evaluatePersistedPlanningNarratives(filledRoot);
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.persistedFields).toBe(1);
  });

  it("missing PROJECT-DEFINITION is config failure", () => {
    const root = tempRoot();
    const result = evaluatePersistedPlanningNarratives(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(2);
    expect(result.cause).toContain("missing");
  });
});
