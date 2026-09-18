import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecognizedReservedReferenceType } from "@deftai/directive-types";
import { describe, expect, it } from "vitest";
import { atomicWriteBrief, validateBriefForPersist } from "../scope/brief-io.js";
import { scanVbrief } from "./conformance.js";
import { runValidate } from "./main.js";
import { validateOriginProvenance } from "./origin.js";
import { reEmitVbriefArtifact } from "./roundtrip.js";
import { validatePlanReferenceTypes, validateVbriefSchema } from "./schema.js";
import { validateAll } from "./validate-all.js";

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

describe("validatePlanReferenceTypes reserved subtypes (#4698)", () => {
  const prUri = "https://github.com/deftai/directive-training/pull/5";
  const issueUri = "https://github.com/deftai/directive/issues/4698";

  it("reports pull-request with nearest canonical github-pr", () => {
    const { errors } = validatePlanReferenceTypes(
      [{ uri: prUri, type: "x-xbrief/pull-request" }],
      "brief.json",
    );
    expect(errors.some((e) => e.includes("x-xbrief/pull-request"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown reserved-prefix subtype"))).toBe(true);
    expect(errors.some((e) => e.includes("x-xbrief/github-pr"))).toBe(true);
  });

  it("does not report canonical github-pr", () => {
    expect(
      validatePlanReferenceTypes([{ uri: prUri, type: "x-xbrief/github-pr" }], "brief.json"),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("keeps engine-written closes and current-shape valid", () => {
    expect(
      validatePlanReferenceTypes(
        [
          { uri: issueUri, type: "x-xbrief/closes" },
          {
            uri: "https://github.com/deftai/directive/issues/4698#issuecomment-1",
            type: "x-xbrief/current-shape",
          },
        ],
        "brief.json",
      ),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("reports pull-request in a mixed github-issue plus pull-request plan", () => {
    const { errors } = validatePlanReferenceTypes(
      [
        { uri: issueUri, type: "x-xbrief/github-issue" },
        { uri: prUri, type: "x-xbrief/pull-request" },
      ],
      "brief.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("plan.references[1].type");
    expect(errors[0]).toContain("x-xbrief/pull-request");
  });

  it("does not close consumer x-* namespaces", () => {
    expect(
      validatePlanReferenceTypes(
        [{ uri: "https://example.test/t/1", type: "x-myapp/ticket" }],
        "brief.json",
      ),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("skips missing, non-array, and malformed entries", () => {
    expect(validatePlanReferenceTypes(undefined, "brief.json")).toEqual({
      errors: [],
      warnings: [],
    });
    expect(validatePlanReferenceTypes("nope", "brief.json")).toEqual({
      errors: ["brief.json: plan.references must be an array"],
      warnings: [],
    });
    expect(
      validatePlanReferenceTypes(
        [
          null,
          "x",
          { uri: "https://example.test/t/1" },
          { uri: "https://example.test/t/1", type: 1 },
        ],
        "brief.json",
      ),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("validateVbriefSchema reports pull-request on the check path", () => {
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          references: [{ uri: prUri, type: "x-xbrief/pull-request" }],
        },
      },
      "brief.json",
    );
    expect(errors.some((e) => e.includes("x-xbrief/pull-request"))).toBe(true);
  });

  it("validateVbriefSchema keeps github-pr, web-page, and closes valid", () => {
    expect(
      validateVbriefSchema(
        {
          ...MINIMAL_V08,
          plan: {
            ...MINIMAL_V08.plan,
            references: [
              { uri: prUri, type: "x-xbrief/github-pr" },
              { uri: "https://example.test/doc", type: "x-xbrief/web-page" },
              { uri: issueUri, type: "x-xbrief/closes" },
            ],
          },
        },
        "brief.json",
      ),
    ).toEqual([]);
  });

  it("reports an unknown reserved subtype without a nearest canonical as an error", () => {
    const { errors, warnings } = validatePlanReferenceTypes(
      [{ uri: "https://example.test/t/1", type: "x-xbrief/not-a-known-type" }],
      "brief.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("x-xbrief/not-a-known-type");
    expect(errors[0]).not.toContain("nearest canonical");
    expect(warnings).toEqual([]);
  });
});

const CLASS_B_BARES = [
  "depends-on",
  "supersedes",
  "source-document",
  "user-approval",
  "revisit-condition",
  "superseded-by",
] as const;

const CLASS_B_PREFIXES = ["x-vbrief/", "x-xbrief/"] as const;

function classBDoc(type: string) {
  return {
    ...MINIMAL_V08,
    plan: {
      ...MINIMAL_V08.plan,
      status: "draft",
      references: [{ uri: "https://example.test/ref", type }],
    },
  };
}

function writeProposedBrief(root: string, name: string, type: string): string {
  const vbrief = join(root, "xbrief");
  mkdirSync(join(vbrief, "proposed"), { recursive: true });
  const rel = join(vbrief, "proposed", name);
  writeFileSync(rel, JSON.stringify(classBDoc(type)), "utf8");
  return vbrief;
}

describe("Class B reserved-prefix compatibility (#4746)", () => {
  it("warns on all twelve Class B spellings and keeps them off the fatal-errors API", () => {
    for (const prefix of CLASS_B_PREFIXES) {
      for (const bare of CLASS_B_BARES) {
        const type = prefix + bare;
        const { errors, warnings } = validatePlanReferenceTypes(
          [{ uri: "https://example.test/ref", type }],
          "brief.json",
        );
        expect(errors, type).toEqual([]);
        expect(warnings, type).toHaveLength(1);
        expect(warnings[0], type).toContain(type);
        expect(warnings[0], type).toContain("unknown reserved-prefix subtype");
        expect(validateVbriefSchema(classBDoc(type), "brief.json"), type).toEqual([]);
        expect(isRecognizedReservedReferenceType(type), type).toBe(false);
      }
    }
  });

  it("does not treat nearestCanonical == null as the warning classifier", () => {
    const { errors, warnings } = validatePlanReferenceTypes(
      [{ uri: "https://example.test/t/1", type: "x-xbrief/github_pr" }],
      "brief.json",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("x-xbrief/github_pr");
    expect(warnings).toEqual([]);
  });

  it("keeps Class A aliases pull-request and github-pull-request as errors", () => {
    for (const type of ["x-xbrief/pull-request", "x-vbrief/github-pull-request"]) {
      const { errors, warnings } = validatePlanReferenceTypes(
        [{ uri: "https://github.com/deftai/directive/pull/1", type }],
        "brief.json",
      );
      expect(errors, type).toHaveLength(1);
      expect(warnings, type).toEqual([]);
      expect(
        validateVbriefSchema(classBDoc(type), "brief.json").some((e) => e.includes(type)),
        type,
      ).toBe(true);
    }
  });

  it("routes Class B to validateAll warnings and aliases to errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-4746-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    writeFileSync(
      join(vbrief, "proposed", "2026-09-18-class-b.xbrief.json"),
      JSON.stringify(classBDoc("x-xbrief/depends-on")),
      "utf8",
    );
    const warned = validateAll(vbrief);
    expect(warned.errors).toEqual([]);
    expect(warned.warnings.some((w) => w.includes("x-xbrief/depends-on"))).toBe(true);

    writeFileSync(
      join(vbrief, "proposed", "2026-09-18-alias.xbrief.json"),
      JSON.stringify(classBDoc("x-xbrief/pull-request")),
      "utf8",
    );
    const mixed = validateAll(vbrief);
    expect(mixed.errors.some((e) => e.includes("x-xbrief/pull-request"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts and preserves Class B on persist and roundtrip", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-4746-persist-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    const filePath = join(vbrief, "proposed", "2026-09-18-depends-on.xbrief.json");
    const doc = classBDoc("x-vbrief/supersedes");
    expect(validateBriefForPersist(filePath, doc, vbrief)).toBeNull();
    const written = atomicWriteBrief(filePath, doc, vbrief, { projectRoot: root });
    expect(written).toEqual({ ok: true });
    const round = reEmitVbriefArtifact(doc, filePath);
    const plan = round.plan as { references: Array<{ type: string }> };
    expect(plan.references[0].type).toBe("x-vbrief/supersedes");
    rmSync(root, { recursive: true, force: true });
  });

  it("CLI exits 0 on Class B warnings and 1 with --warnings-as-errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-4746-cli-"));
    const vbrief = writeProposedBrief(
      root,
      "2026-09-18-user-approval.xbrief.json",
      "x-xbrief/user-approval",
    );
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(0);
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("CLI exits 0 for each of the six names under both prefixes", () => {
    for (const prefix of CLASS_B_PREFIXES) {
      for (const bare of CLASS_B_BARES) {
        const root = mkdtempSync(join(tmpdir(), "vb-4746-matrix-"));
        const type = prefix + bare;
        const vbrief = writeProposedBrief(root, "2026-09-18-matrix.xbrief.json", type);
        expect(runValidate(["--vbrief-dir", vbrief]), type).toBe(0);
        expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"]), type).toBe(1);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("CLI keeps aliases as errors and mixed origin plus github_pr as error", () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), "vb-4746-alias-"));
    const aliasDir = writeProposedBrief(
      aliasRoot,
      "2026-09-18-alias.xbrief.json",
      "x-xbrief/pull-request",
    );
    expect(runValidate(["--vbrief-dir", aliasDir])).toBe(1);
    rmSync(aliasRoot, { recursive: true, force: true });

    const mixedRoot = mkdtempSync(join(tmpdir(), "vb-4746-mixed-"));
    const vbrief = join(mixedRoot, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    writeFileSync(
      join(vbrief, "proposed", "2026-09-18-mixed.xbrief.json"),
      JSON.stringify({
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/4746",
              type: "x-xbrief/github-issue",
            },
            { uri: "https://github.com/deftai/directive/pull/1", type: "x-xbrief/github_pr" },
          ],
        },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(1);
    rmSync(mixedRoot, { recursive: true, force: true });
  });
});
