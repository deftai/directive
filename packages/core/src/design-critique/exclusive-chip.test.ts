import { describe, expect, it } from "vitest";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import {
  applyDesignCritiqueCatalogChip,
  DESIGN_CRITIQUE_CATALOG_CHIPS,
  designCritiqueChipApplyDelta,
  isDesignCritiqueCatalogChip,
  mergeDesignCritiqueExclusiveIntoApply,
  remainingSetAfterDesignCritiqueChip,
} from "./exclusive-chip.js";

class FakeLabelClient implements LabelClient {
  labels: string[];
  applyCalls: Array<{ add: readonly string[]; remove: readonly string[] }> = [];

  constructor(labels: string[]) {
    this.labels = [...labels];
  }

  fetchLabels(_repo: string, _issueNumber: number): string[] {
    return [...this.labels];
  }

  apply(
    _repo: string,
    _issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push({ add: [...add], remove: [...remove] });
    const next = new Set(this.labels);
    for (const name of remove) next.delete(name);
    for (const name of add) next.add(name);
    this.labels = [...next];
  }
}

describe("design-critique exclusive remaining-set chip (#3642 / #4298)", () => {
  it("replaces mechanism-shaped with ingest-ready and keeps other facets", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["bug", "design-critique:mechanism-shaped", "area:cli"],
      "design-critique:ingest-ready",
    );
    expect(remaining).toEqual(["bug", "area:cli", "design-critique:ingest-ready"]);
  });

  it("later-arc mechanism-shaped drops ingest-ready", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["enhancement", "design-critique:ingest-ready"],
      "design-critique:mechanism-shaped",
    );
    expect(remaining).toEqual(["enhancement", "design-critique:mechanism-shaped"]);
  });

  it("unstacks both catalog chips in one remaining set", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      [
        "bug",
        "doctor",
        "design-critique:mechanism-shaped",
        "design-critique:ingest-ready",
        "area:cli",
      ],
      "design-critique:ingest-ready",
    );
    expect(remaining).toEqual(["bug", "doctor", "area:cli", "design-critique:ingest-ready"]);
    expect(remaining.filter((n) => n.startsWith("design-critique:")).length).toBe(1);
  });

  it("rejects names outside the three-chip catalog", () => {
    expect(() => remainingSetAfterDesignCritiqueChip(["bug"], "design-critique:halted")).toThrow(
      /not a design-critique catalog chip/,
    );
    expect(isDesignCritiqueCatalogChip("design-critique:halted")).toBe(false);
    expect(isDesignCritiqueCatalogChip("design-critique:triage-ready")).toBe(false);
    expect(isDesignCritiqueCatalogChip("design-critique:recut-needed")).toBe(false);
    expect(isDesignCritiqueCatalogChip("design-critique:in-progress")).toBe(true);
    expect(DESIGN_CRITIQUE_CATALOG_CHIPS).toEqual([
      "design-critique:mechanism-shaped",
      "design-critique:in-progress",
      "design-critique:ingest-ready",
    ]);
  });

  it("replaces mechanism-shaped with in-progress and keeps other facets", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["bug", "design-critique:mechanism-shaped", "area:cli"],
      "design-critique:in-progress",
    );
    expect(remaining).toEqual(["bug", "area:cli", "design-critique:in-progress"]);
  });

  it("later-arc mechanism-shaped drops in-progress", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["enhancement", "design-critique:in-progress"],
      "design-critique:mechanism-shaped",
    );
    expect(remaining).toEqual(["enhancement", "design-critique:mechanism-shaped"]);
  });

  it("apply delta is one add+remove, not two-step DELETE-then-POST", () => {
    const delta = designCritiqueChipApplyDelta(
      ["bug", "design-critique:mechanism-shaped"],
      "design-critique:ingest-ready",
    );
    expect(delta).toEqual({
      add: ["design-critique:ingest-ready"],
      remove: ["design-critique:mechanism-shaped"],
    });
  });

  it("apply is a single LabelClient.apply with add and remove together", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped", "area:cli"]);
    const result = applyDesignCritiqueCatalogChip(
      client,
      "deftai/directive",
      3637,
      "design-critique:ingest-ready",
    );
    expect(client.applyCalls).toHaveLength(1);
    expect(client.applyCalls[0]).toEqual({
      add: ["design-critique:ingest-ready"],
      remove: ["design-critique:mechanism-shaped"],
    });
    expect(result.remaining).toEqual(["bug", "area:cli", "design-critique:ingest-ready"]);
    expect(client.labels.sort()).toEqual(
      ["area:cli", "bug", "design-critique:ingest-ready"].sort(),
    );
  });

  it("skips apply when the remaining set is already exclusive", () => {
    const client = new FakeLabelClient(["process", "design-critique:ingest-ready"]);
    applyDesignCritiqueCatalogChip(
      client,
      "deftai/directive",
      3642,
      "design-critique:ingest-ready",
    );
    expect(client.applyCalls).toHaveLength(0);
  });

  it("adds the chip when no catalog name is present", () => {
    const client = new FakeLabelClient(["enhancement", "area:skills"]);
    const result = applyDesignCritiqueCatalogChip(
      client,
      "deftai/directive",
      1,
      "design-critique:mechanism-shaped",
    );
    expect(client.applyCalls).toEqual([{ add: ["design-critique:mechanism-shaped"], remove: [] }]);
    expect(result.remaining).toEqual([
      "enhancement",
      "area:skills",
      "design-critique:mechanism-shaped",
    ]);
  });

  it("removes the other catalog chip when the next chip is already present", () => {
    const client = new FakeLabelClient([
      "bug",
      "design-critique:mechanism-shaped",
      "design-critique:ingest-ready",
    ]);
    applyDesignCritiqueCatalogChip(
      client,
      "deftai/directive",
      3637,
      "design-critique:ingest-ready",
    );
    expect(client.applyCalls).toEqual([{ add: [], remove: ["design-critique:mechanism-shaped"] }]);
  });

  it("rejects an open glob name on apply delta", () => {
    expect(() => designCritiqueChipApplyDelta(["bug"], "design-critique:critic-posted")).toThrow(
      /not a design-critique catalog chip/,
    );
  });

  it("has no clear-to-none verb", () => {
    expect(() => remainingSetAfterDesignCritiqueChip(["bug"], "none")).toThrow(
      /not a design-critique catalog chip/,
    );
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["design-critique:in-progress"],
      "design-critique:in-progress",
    );
    expect(remaining).toEqual(["design-critique:in-progress"]);
  });

  it("folds exclusive replace into LabelClient.apply add/remove", () => {
    const merged = mergeDesignCritiqueExclusiveIntoApply(
      ["bug", "design-critique:mechanism-shaped"],
      ["design-critique:ingest-ready"],
      [],
    );
    expect(merged).toEqual({
      add: ["design-critique:ingest-ready"],
      remove: ["design-critique:mechanism-shaped"],
    });
    const passthrough = mergeDesignCritiqueExclusiveIntoApply(["bug"], ["status:blocked"], ["rfc"]);
    expect(passthrough).toEqual({ add: ["status:blocked"], remove: ["rfc"] });
    const mixed = mergeDesignCritiqueExclusiveIntoApply(
      ["bug", "design-critique:mechanism-shaped"],
      ["design-critique:ingest-ready", "area:cli"],
      ["bug"],
    );
    expect(mixed.add.sort()).toEqual(["area:cli", "design-critique:ingest-ready"]);
    expect(mixed.remove.sort()).toEqual(["bug", "design-critique:mechanism-shaped"]);
  });
});
