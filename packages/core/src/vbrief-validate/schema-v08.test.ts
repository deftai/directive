import { describe, expect, it } from "vitest";
import { scanVbrief } from "./conformance.js";
import { validateOriginProvenance } from "./origin.js";
import { validateVbriefSchema } from "./schema.js";

const MINIMAL_V08 = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "xBRIEF v0.8 fixture",
    status: "draft",
    items: [],
  },
} as const;

describe("validateVbriefSchema xBRIEF v0.8 (#2107)", () => {
  it("accepts xBRIEFInfo with version 0.8", () => {
    expect(validateVbriefSchema({ ...MINIMAL_V08 }, "v08.json")).toEqual([]);
  });

  it("still accepts legacy vBRIEFInfo with version 0.6", () => {
    expect(
      validateVbriefSchema(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Legacy", status: "running", items: [] },
        },
        "v06.json",
      ),
    ).toEqual([]);
  });

  it("accepts optional PlanItem fields when present and absent", () => {
    const withOptional = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        narratives: {
          Source: "verified:review",
          Confidence: "high",
        },
        items: [
          {
            id: "epic-1",
            type: "epic",
            summary: "Container item",
            title: "Epic",
            status: "auto",
            planRefs: ["https://github.com/deftai/directive/issues/2107"],
            items: [{ id: "task-1", title: "Task", status: "pending" }],
          },
        ],
      },
    };
    expect(validateVbriefSchema(withOptional, "optional-present.json")).toEqual([]);

    const withoutOptional = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "task-1", title: "Task", status: "pending" }],
      },
    };
    expect(validateVbriefSchema(withoutOptional, "optional-absent.json")).toEqual([]);
  });

  it("accepts optional PlanItem.effort S/M/L/XL and rejects invalid (#1581)", () => {
    for (const effort of ["S", "M", "L", "XL"] as const) {
      const doc = {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          items: [{ id: "t1", title: "Task", status: "pending", effort }],
        },
      };
      expect(validateVbriefSchema(doc, `effort-${effort}.json`)).toEqual([]);
    }

    const omitted = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "t1", title: "Task", status: "pending" }],
      },
    };
    expect(validateVbriefSchema(omitted, "effort-omitted.json")).toEqual([]);

    const bad = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "t1", title: "Task", status: "pending", effort: "XXL" }],
      },
    };
    const errors = validateVbriefSchema(bad, "effort-bad.json");
    expect(errors.some((e) => e.includes("invalid effort"))).toBe(true);
  });

  it("rejects plan.status auto (item-only in v0.8)", () => {
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: { title: "Bad", status: "auto", items: [] },
      },
      "plan-auto.json",
    );
    expect(errors.some((e) => e.includes("plan.status") && e.includes("auto"))).toBe(true);
  });

  it("reports null info block as must-be-object, not missing key", () => {
    const errors = validateVbriefSchema({ vBRIEFInfo: null, plan: {} }, "null-info.json");
    expect(errors.some((e) => e.includes("'vBRIEFInfo' must be an object"))).toBe(true);
    expect(errors.some((e) => e.includes("missing required top-level key"))).toBe(false);
  });

  it("treats x-xbrief reference types as conformant and origin-trusting", () => {
    const rel = "xbrief/active/2026-06-30-story.xbrief.json";
    const data = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Story",
        status: "running",
        items: [],
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/2107",
            type: "x-xbrief/github-issue",
            title: "Issue #2107",
          },
        ],
      },
    };
    expect(scanVbrief(rel, data)).toEqual([]);
    expect(validateOriginProvenance(rel, data, "/tmp/vbrief", false)).toEqual([]);
  });
});
