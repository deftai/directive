import { describe, expect, it } from "vitest";
import { collectXlEffortItems, evaluateEffortActivateGate } from "./effort-activate-gate.js";

describe("effort-activate-gate (#1581)", () => {
  it("allows activate when effort is omitted", () => {
    const plan = {
      title: "T",
      status: "pending",
      items: [{ title: "A", status: "pending" }],
    };
    const gate = evaluateEffortActivateGate(plan);
    expect(gate.ok).toBe(true);
    expect(gate.xlItems).toEqual([]);
  });

  it("allows activate when effort is S, M, or L", () => {
    for (const effort of ["S", "M", "L"] as const) {
      const plan = {
        title: "T",
        status: "pending",
        items: [{ id: "a1", title: "A", status: "pending", effort }],
      };
      const gate = evaluateEffortActivateGate(plan);
      expect(gate.ok).toBe(true);
    }
  });

  it("blocks activate when a top-level item has effort XL", () => {
    const plan = {
      title: "T",
      status: "pending",
      items: [
        { id: "a1", title: "Small", status: "pending", effort: "S" },
        { id: "a2", title: "Too big", status: "pending", effort: "XL" },
      ],
    };
    const gate = evaluateEffortActivateGate(plan);
    expect(gate.ok).toBe(false);
    expect(gate.message).toContain("effort=XL");
    expect(gate.message).toContain("#1581");
    expect(gate.xlItems).toHaveLength(1);
    expect(gate.xlItems[0]?.id).toBe("a2");
  });

  it("blocks activate when a nested item has effort XL", () => {
    const plan = {
      title: "T",
      status: "pending",
      items: [
        {
          id: "parent",
          title: "Parent",
          status: "pending",
          effort: "L",
          items: [{ id: "child", title: "Child XL", status: "pending", effort: "XL" }],
        },
      ],
    };
    const gate = evaluateEffortActivateGate(plan);
    expect(gate.ok).toBe(false);
    expect(gate.xlItems.map((h) => h.id)).toEqual(["child"]);
  });

  it("collects XL hits via legacy subItems", () => {
    const hits = collectXlEffortItems([
      {
        id: "p",
        title: "P",
        status: "pending",
        subItems: [{ id: "s1", title: "Sub", status: "pending", effort: "XL" }],
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toContain("subItems");
  });

  it("returns empty when plan.items is missing or not an array", () => {
    expect(evaluateEffortActivateGate({ title: "T", status: "pending" }).ok).toBe(true);
    expect(collectXlEffortItems(null)).toEqual([]);
    expect(collectXlEffortItems(undefined)).toEqual([]);
    expect(collectXlEffortItems("nope")).toEqual([]);
  });

  it("skips non-object item entries and labels XL without id", () => {
    const hits = collectXlEffortItems([
      null,
      "skip",
      [],
      { title: "No id XL", status: "pending", effort: "XL" },
      { status: "pending", effort: "XL" },
      { id: "", title: "", status: "pending", effort: "M" },
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe("No id XL");
    expect(hits[1]?.id).toBe("<no-id>");
  });

  it("lists multiple XL hits in the refuse message", () => {
    const gate = evaluateEffortActivateGate({
      title: "T",
      status: "pending",
      items: [
        { id: "a", title: "A", status: "pending", effort: "XL" },
        { id: "b", title: "B", status: "pending", effort: "XL" },
      ],
    });
    expect(gate.ok).toBe(false);
    expect(gate.xlItems).toHaveLength(2);
    expect(gate.message).toContain("plan.items[a]");
    expect(gate.message).toContain("plan.items[b]");
  });
});
