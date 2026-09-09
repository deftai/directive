import { describe, expect, it } from "vitest";
import { hasInProgressFlipEvidence, resolveInFlightCatalogChip } from "./in-progress-flip.js";

describe("in-progress flip clock (#4298)", () => {
  it("stays mechanism-shaped with no thread evidence (including spawn intent absence)", () => {
    expect(hasInProgressFlipEvidence([])).toBe(false);
    expect(resolveInFlightCatalogChip([])).toBe("design-critique:mechanism-shaped");
  });

  it("does not flip on Stop 1 mechanism-shaped field or a successor lean", () => {
    const comments = [
      { id: 1, body: "role: triage\n\nmechanism-shaped: true\n" },
      { id: 2, body: "**Lean:** next-build is this body.\n" },
    ];
    expect(hasInProgressFlipEvidence(comments)).toBe(false);
    expect(resolveInFlightCatalogChip(comments)).toBe("design-critique:mechanism-shaped");
  });

  it("flips on first role: critic post", () => {
    const comments = [{ id: 10, body: "model: grok-4.6\nrole: critic\n\n## Finding 1\n" }];
    expect(hasInProgressFlipEvidence(comments)).toBe(true);
    expect(resolveInFlightCatalogChip(comments)).toBe("design-critique:in-progress");
  });

  it("flips on panel-deposit", () => {
    const comments = [
      {
        id: 11,
        body: "panel-deposit\nround: 2\nsiblings: 2\ninput-ceiling: 1\n",
      },
    ];
    expect(hasInProgressFlipEvidence(comments)).toBe(true);
    expect(resolveInFlightCatalogChip(comments)).toBe("design-critique:in-progress");
  });
});
