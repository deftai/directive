import { describe, expect, it } from "vitest";
import {
  classifyItemKey,
  classifyPlanPath,
  classifyReferenceKey,
  KNOWN_MACHINE_WRITERS,
} from "./known-machine.js";

describe("known-machine file (#3385 F1)", () => {
  it("classifies tags as machine and edges as extract", () => {
    expect(classifyPlanPath("tags")).toBe("machine");
    expect(classifyPlanPath("edges")).toBe("extract");
    expect(classifyItemKey("status")).toBe("machine");
    expect(classifyItemKey("title")).toBe("extract");
    expect(classifyReferenceKey("TrustLevel")).toBe("machine");
    expect(KNOWN_MACHINE_WRITERS["plan.tags"]?.writer).toContain("issue-ingest");
  });

  it("classifies canonical evidence as machine and disposition as unknown (#4059)", () => {
    expect(classifyItemKey("x-directive/evidence")).toBe("machine");
    expect(classifyItemKey("x-directive/disposition")).toBe("unknown");
    expect(KNOWN_MACHINE_WRITERS["plan.items[].x-directive/evidence"]?.writer).toContain(
      "acceptance-evidence",
    );
  });
});
