import { describe, expect, it } from "vitest";
import {
  alignSpecNarratives,
  buildEdgesFromTasks,
  buildRequirementsNarrative,
  ingestSpecNarratives,
  mapSpecStatus,
  parseRequirementDefinitions,
  parseSpecTasks,
  taskScopeNarratives,
} from "./fidelity.js";

const SAMPLE = `### t1.1.1 -- Widget [done]

Body text.

Depends on: t1.0.1

**Traces**: FR-1

Acceptance criteria:

- Given x, when y, then it renders.

## Requirements

FR-1: Widget opens.
`;

describe("fidelity", () => {
  it("maps spec statuses", () => {
    expect(mapSpecStatus("done")).toBe("completed");
    expect(mapSpecStatus("weird")).toBe("pending");
  });

  it("parses tasks with depends/traces/acceptance", () => {
    const tasks = parseSpecTasks(SAMPLE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.depends_on).toContain("t1.0.1");
    expect(tasks[0]?.traces).toContain("FR-1");
    expect(tasks[0]?.acceptance.length).toBeGreaterThan(0);
  });

  it("parses requirements and builds narrative", () => {
    const reqs = parseRequirementDefinitions(SAMPLE);
    expect(reqs["FR-1"]).toBe("Widget opens.");
    expect(buildRequirementsNarrative(reqs)).toContain("FR-1: Widget opens.");
  });

  it("builds edges and scope narratives", () => {
    const tasks = parseSpecTasks(SAMPLE);
    const edges = buildEdgesFromTasks(tasks);
    expect(edges[0]).toEqual({ from: "t1.0.1", to: "t1.1.1", type: "blocks" });
    expect(taskScopeNarratives(tasks[0] ?? {})).toMatchObject({ Description: "Body text." });
  });

  it("preserves unknown narrative keys and dedupes duplicate edges", () => {
    expect(alignSpecNarratives({ CustomSection: " legacy body " }).CustomSection).toBe(
      "legacy body",
    );
    expect(
      buildEdgesFromTasks([
        { task_id: "t1.1.1", depends_on: ["t1.0.1"] },
        { task_id: "t1.1.1", depends_on: ["t1.0.1"] },
      ]),
    ).toHaveLength(1);
    const [, logs] = ingestSpecNarratives("## Empty\n## Next\n\nBody\n");
    expect(logs[0]?.line_range).toBe("1");
  });
});
