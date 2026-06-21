import { describe, expect, it } from "vitest";
import { validateVbriefSchema } from "../../vbrief-validate/index.js";
import { isFile, loadJson, readText } from "./_helpers.js";

const LEGACY_TOP_LEVEL_KEYS = new Set(["vbrief", "tasks", "overview", "architecture"]);
const VBRIEF_PATHS = ["vbrief/specification.vbrief.json", "vbrief/plan.vbrief.json"] as const;

function schemaStatusEnum(): Set<string> {
  const schema = loadJson("vbrief/schemas/vbrief-core.schema.json") as {
    $defs: { Status: { enum: string[] } };
  };
  return new Set(schema.$defs.Status.enum);
}

function documentedStatusEnum(): Set<string> {
  const text = readText("vbrief/vbrief.md");
  let inStatus = false;
  let inCode = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("### Status Enum")) {
      inStatus = true;
      continue;
    }
    if (inStatus && line.trim().startsWith("```") && !inCode) {
      inCode = true;
      continue;
    }
    if (inCode && line.trim().startsWith("```")) break;
    if (inCode) {
      const values = line
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length) return new Set(values);
    }
  }
  return new Set();
}

function statusValuesUsedInProse(): Set<string> {
  const text = readText("vbrief/vbrief.md");
  const schemaValues = schemaStatusEnum();
  const nonConforming = new Set(["todo", "doing", "done", "skip", "deferred"]);
  const found = new Set<string>();
  const statusLineRe = /status\.lifecycle|status.*→|`status`/i;
  const backtickRe = /`(\w+)`/g;
  for (const line of text.split("\n")) {
    if (!statusLineRe.test(line)) continue;
    for (const match of line.matchAll(backtickRe)) {
      const word = match[1] ?? "";
      if (schemaValues.has(word) || nonConforming.has(word)) found.add(word);
    }
  }
  return found;
}

describe("test_vbrief_schema.py", () => {
  it("test_schema_file_is_valid_json", () => {
    const data = loadJson("vbrief/schemas/vbrief-core.schema.json") as Record<string, unknown>;
    expect(data).toHaveProperty("$defs");
  });
  it("test_documented_status_matches_schema", () => {
    const schemaValues = schemaStatusEnum();
    const docValues = documentedStatusEnum();
    expect(docValues.size).toBeGreaterThan(0);
    expect(docValues).toEqual(schemaValues);
  });
  it("test_no_non_conforming_status_in_prose", () => {
    const nonConforming = new Set(["todo", "doing", "done", "skip", "deferred"]);
    const violations = [...statusValuesUsedInProse()].filter((v) => nonConforming.has(v));
    expect(violations).toEqual([]);
  });
  for (const rel of VBRIEF_PATHS) {
    it(`test_vbrief_file_is_valid_json ${rel}`, () => {
      expect(isFile(rel)).toBe(true);
      loadJson(rel);
    });
    it(`test_vbrief_file_conforms_to_schema ${rel}`, () => {
      const data = loadJson(rel) as Record<string, unknown>;
      const errors = validateVbriefSchema(data, rel.split("/").pop() ?? rel);
      expect(errors).toEqual([]);
    });
  }
  it("test_spec_has_required_top_level_keys", () => {
    const data = loadJson("vbrief/specification.vbrief.json") as Record<string, unknown>;
    expect(data).toHaveProperty("vBRIEFInfo");
    expect(data).toHaveProperty("plan");
    expect(typeof data.plan).toBe("object");
  });
  it("test_spec_has_no_legacy_top_level_fields", () => {
    const data = loadJson("vbrief/specification.vbrief.json") as Record<string, unknown>;
    const found = Object.keys(data).filter((k) => LEGACY_TOP_LEVEL_KEYS.has(k));
    expect(found).toEqual([]);
  });
  it("test_plan_has_no_legacy_top_level_fields", () => {
    const data = loadJson("vbrief/plan.vbrief.json") as Record<string, unknown>;
    const found = Object.keys(data).filter((k) => LEGACY_TOP_LEVEL_KEYS.has(k));
    expect(found).toEqual([]);
  });
  it("test_spec_plan_has_title_status_items", () => {
    const plan = (loadJson("vbrief/specification.vbrief.json") as { plan: Record<string, unknown> })
      .plan;
    expect(plan).toHaveProperty("title");
    expect(plan).toHaveProperty("status");
    expect(plan).toHaveProperty("items");
    expect(Array.isArray(plan.items)).toBe(true);
  });
  it("test_narrative_object_value_must_be_string", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Test",
        status: "draft",
        narratives: {
          Overview: "valid string",
          Requirements: { Functional: ["FR-1"], NonFunctional: ["NFR-1"] },
        },
        items: [],
      },
    };
    const errors = validateVbriefSchema(data, "test");
    expect(errors.some((e) => e.includes("plan.narratives.Requirements must be a string"))).toBe(
      true,
    );
  });
  it("test_item_narrative_value_must_be_string", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Test",
        status: "draft",
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            narrative: { Acceptance: "valid", Details: ["invalid", "array"] },
          },
        ],
      },
    };
    const errors = validateVbriefSchema(data, "test");
    expect(errors.some((e) => e.includes("narrative.Details must be a string"))).toBe(true);
  });
  it("test_items_inside_plan_item_accepted_v06", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Test",
        status: "draft",
        items: [
          {
            id: "phase-1",
            title: "Phase 1",
            status: "pending",
            items: [{ id: "t1", title: "Task", status: "pending" }],
          },
        ],
      },
    };
    expect(validateVbriefSchema(data, "test")).toEqual([]);
  });
  it("test_recursive_subitems_validation", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Test",
        status: "draft",
        items: [
          {
            id: "phase-1",
            title: "Phase 1",
            status: "pending",
            subItems: [
              {
                id: "1.1",
                title: "Subphase",
                status: "pending",
                subItems: [{ id: "1.1.1", title: "Task", status: "bogus" }],
              },
            ],
          },
        ],
      },
    };
    const errors = validateVbriefSchema(data, "test");
    expect(errors.some((e) => e.includes("1.1.1") && e.includes("invalid status"))).toBe(true);
  });
  it("test_valid_hierarchical_spec_passes", () => {
    const data = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Project SPECIFICATION",
        status: "draft",
        narratives: { Overview: "A project summary.", Architecture: "System design." },
        items: [
          {
            id: "phase-1",
            title: "Phase 1: Foundation",
            status: "pending",
            subItems: [
              {
                id: "1.1",
                title: "Subphase 1.1: Setup",
                status: "pending",
                subItems: [
                  {
                    id: "1.1.1",
                    title: "Scaffolding",
                    status: "pending",
                    narrative: { Acceptance: "Build passes", Traces: "FR-1" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(validateVbriefSchema(data, "test")).toEqual([]);
  });
});
