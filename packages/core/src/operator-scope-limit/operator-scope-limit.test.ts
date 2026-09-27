import { describe, expect, it } from "vitest";
import { detectScopeLimitPhrase, extractRequirementLines } from "./detect.js";
import { SCOPE_LIMIT_PHRASES } from "./lexicon.js";
import { applyCeilingToBrief, readCeilingFromBrief, seedOperatorScopeCeiling } from "./seed.js";
import { evaluateUntraceableSurfaces } from "./surface-check.js";
import {
  OPERATOR_SCOPE_CEILING_PLAN_KEY,
  OPERATOR_SCOPE_CEILING_SCHEMA,
  type ShippedSurface,
  UNTRACEABLE_SURFACE_REMEDIATION,
} from "./types.js";

/**
 * Fixture shaped like the filed #4545 greenfield prompt (add-only requirements
 * + explicit "initial version only / do not add" ceiling sentence).
 */
const GREENFIELD_PROMPT = `
Vehicle maintenance tracker — initial version.

Requirements:
- add vehicle
- add maintenance record
- add modification
- update mileage

Start with this initial version only. Do not add features beyond the requirements above.
`.trim();

const ADD_ONLY_SURFACES: ShippedSurface[] = [
  { kind: "server-action", id: "addVehicleAction" },
  { kind: "server-action", id: "addMaintenanceRecordAction" },
  { kind: "server-action", id: "addModificationAction" },
  { kind: "server-action", id: "updateMileageAction" },
  { kind: "page", id: "/vehicles/new" },
];

/** Dogfood escape: edit+delete CRUD the operator never listed. */
const BEYOND_SCOPE_SURFACES: ShippedSurface[] = [
  ...ADD_ONLY_SURFACES,
  { kind: "server-action", id: "updateVehicleAction" },
  { kind: "server-action", id: "deleteVehicleAction" },
  { kind: "server-action", id: "updateServiceAction" },
  { kind: "server-action", id: "deleteServiceAction" },
  { kind: "server-action", id: "updateModificationAction" },
  { kind: "server-action", id: "deleteModificationAction" },
  { kind: "page", id: "/vehicles/[id]/edit" },
];

describe("scope-limit lexicon (#4545)", () => {
  it("names the closed Bound phrases", () => {
    expect(SCOPE_LIMIT_PHRASES).toEqual(
      expect.arrayContaining([
        "do not add",
        "nothing beyond",
        "initial version only",
        "do not add features beyond",
      ]),
    );
  });
});

describe("detectScopeLimitPhrase (#4545)", () => {
  it("records the longest matching phrase on the greenfield prompt", () => {
    const hit = detectScopeLimitPhrase(GREENFIELD_PROMPT);
    expect(hit).not.toBeNull();
    expect(hit?.phrase).toBe("do not add features beyond the requirements");
  });

  it("matches close variants named in the Bound lexicon", () => {
    expect(detectScopeLimitPhrase("Ship nothing beyond what I listed.")?.phrase).toBe(
      "nothing beyond",
    );
    expect(detectScopeLimitPhrase("Initial version only — stop there.")?.phrase).toBe(
      "initial version only",
    );
    expect(detectScopeLimitPhrase("Please do not add extras.")?.phrase).toBe("do not add");
  });

  it("returns null when no lexicon phrase is present", () => {
    expect(detectScopeLimitPhrase("Build a full CRUD app with edit and delete.")).toBeNull();
    expect(detectScopeLimitPhrase("")).toBeNull();
  });
});

describe("extractRequirementLines (#4545)", () => {
  it("pulls the add/update lines before the ceiling sentence", () => {
    const hit = detectScopeLimitPhrase(GREENFIELD_PROMPT);
    expect(hit).not.toBeNull();
    const lines = extractRequirementLines(GREENFIELD_PROMPT, {
      beforeIndex: hit!.index,
    });
    expect(lines).toEqual([
      "add vehicle",
      "add maintenance record",
      "add modification",
      "update mileage",
    ]);
  });

  it("keeps requirements listed after an early ceiling phrase", () => {
    const prompt = "Initial version only:\n- add vehicle";
    const hit = detectScopeLimitPhrase(prompt);
    expect(hit?.phrase).toBe("initial version only");
    expect(extractRequirementLines(prompt, { beforeIndex: hit?.index })).toEqual(["add vehicle"]);
    const seeded = seedOperatorScopeCeiling(prompt, null);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.ceiling.requirementLines).toEqual(["add vehicle"]);
    const check = evaluateUntraceableSurfaces({
      requirementLines: seeded.ceiling.requirementLines,
      surfaces: [{ kind: "server-action", id: "addVehicleAction" }],
    });
    expect(check.severity).toBe("clean");
  });

  it("treats Out of scope actions as untraceable, not approved", () => {
    const prompt = [
      "Initial version only.",
      "- add vehicle",
      "",
      "Out of scope:",
      "- delete vehicle",
    ].join("\n");
    const seeded = seedOperatorScopeCeiling(prompt, null);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.ceiling.requirementLines).toEqual(["add vehicle"]);
    const check = evaluateUntraceableSurfaces({
      requirementLines: seeded.ceiling.requirementLines,
      surfaces: [
        { kind: "server-action", id: "addVehicleAction" },
        { kind: "server-action", id: "deleteVehicleAction" },
      ],
    });
    expect(check.severity).toBe("warn");
    expect(check.untraceable.map((u) => u.surface.id)).toEqual(["deleteVehicleAction"]);
  });
});

describe("seedOperatorScopeCeiling (#4545)", () => {
  it("records phrase→ceiling on a seeded brief when none was active", () => {
    // Empty-active path: no prior brief; seed still yields a durable artifact,
    // and applying onto a fresh proposed brief stamps the hard ceiling.
    const emptyActive = seedOperatorScopeCeiling(GREENFIELD_PROMPT, null);
    expect(emptyActive.ok).toBe(true);
    if (!emptyActive.ok) return;
    expect(emptyActive.brief).toBeNull();
    expect(emptyActive.artifact.schema).toBe(OPERATOR_SCOPE_CEILING_SCHEMA);
    expect(emptyActive.artifact.matchedPhrase).toBe("do not add features beyond the requirements");
    expect(emptyActive.artifact.requirementLines).toEqual([
      "add vehicle",
      "add maintenance record",
      "add modification",
      "update mileage",
    ]);

    const proposed: Record<string, unknown> = {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "vehicle tracker spike", status: "draft", metadata: {} },
    };
    const seeded = seedOperatorScopeCeiling(GREENFIELD_PROMPT, proposed);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.brief).not.toBeNull();
    const ceiling = readCeilingFromBrief(seeded.brief);
    expect(ceiling?.matchedPhrase).toBe("do not add features beyond the requirements");
    expect(ceiling?.requirementLines).toHaveLength(4);

    const meta = (
      (seeded.brief!.plan as Record<string, unknown>).metadata as Record<string, unknown>
    )[OPERATOR_SCOPE_CEILING_PLAN_KEY] as Record<string, unknown>;
    expect(meta.schema).toBe(OPERATOR_SCOPE_CEILING_SCHEMA);

    const narratives = (seeded.brief!.plan as Record<string, unknown>).narratives as Record<
      string,
      unknown
    >;
    expect(String(narratives.Requirements)).toContain("add vehicle");
  });

  it("returns a miss when the prompt has no scope-limit phrase", () => {
    const miss = seedOperatorScopeCeiling("Build whatever you think is best.");
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.reason).toBe("no-scope-limit-phrase");
  });

  it("applyCeilingToBrief does not mutate the input", () => {
    const brief: Record<string, unknown> = {
      plan: { metadata: { keep: true } },
    };
    const ceiling = {
      schema: OPERATOR_SCOPE_CEILING_SCHEMA,
      matchedPhrase: "do not add",
      requirementLines: ["add vehicle"] as const,
      source: "operator-prompt" as const,
    };
    const next = applyCeilingToBrief(brief, ceiling);
    expect((brief.plan as Record<string, unknown>).metadata).toEqual({ keep: true });
    expect(
      ((next.plan as Record<string, unknown>).metadata as Record<string, unknown>)[
        OPERATOR_SCOPE_CEILING_PLAN_KEY
      ],
    ).toBeDefined();
  });
});

describe("evaluateUntraceableSurfaces warn-first (#4545)", () => {
  it("is clean when every surface traces to a requirement line", () => {
    const seeded = seedOperatorScopeCeiling(GREENFIELD_PROMPT, null);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const result = evaluateUntraceableSurfaces({
      requirementLines: seeded.ceiling.requirementLines,
      surfaces: ADD_ONLY_SURFACES,
    });
    expect(result.severity).toBe("clean");
    expect(result.untraceable).toEqual([]);
    expect(result.remediation).toBeNull();
  });

  it("lists edit/delete dogfood surfaces as warn-first with the Bound remediation", () => {
    const seeded = seedOperatorScopeCeiling(GREENFIELD_PROMPT, null);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const result = evaluateUntraceableSurfaces({
      requirementLines: seeded.ceiling.requirementLines,
      surfaces: BEYOND_SCOPE_SURFACES,
    });
    expect(result.severity).toBe("warn");
    expect(result.remediation).toBe(UNTRACEABLE_SURFACE_REMEDIATION);
    expect(result.message).toContain(UNTRACEABLE_SURFACE_REMEDIATION);

    const ids = result.untraceable.map((u) => u.surface.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "updateVehicleAction",
        "deleteVehicleAction",
        "updateServiceAction",
        "deleteServiceAction",
        "updateModificationAction",
        "deleteModificationAction",
        "/vehicles/[id]/edit",
      ]),
    );
    // Add-only surfaces stay off the warn list.
    expect(ids).not.toContain("addVehicleAction");
    expect(ids).not.toContain("updateMileageAction");
    for (const finding of result.untraceable) {
      expect(finding.remediation).toBe(UNTRACEABLE_SURFACE_REMEDIATION);
    }
  });
});
