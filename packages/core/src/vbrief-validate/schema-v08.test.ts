import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeUnknownReservedReferenceType,
  isRecognizedReservedReferenceType,
  KNOWN_REFERENCE_TYPES,
  RESERVED_REFERENCE_TYPE_ALIASES,
} from "@deftai/directive-types";
import { describe, expect, it } from "vitest";
import { atomicWriteBrief, validateBriefForPersist } from "../scope/brief-io.js";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { scanVbrief } from "./conformance.js";
import { VALID_PLAN_STATUSES } from "./constants.js";
import { runValidate } from "./main.js";
import { validateOriginProvenance } from "./origin.js";
import { reEmitVbriefArtifact } from "./roundtrip.js";
import {
  isTerminalPlanStatus,
  isValidPlanStatusMember,
  validatePlanReferenceTypes,
  validateVbriefSchema,
} from "./schema.js";
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
          Evidence: "review comment",
          Verifier: "reviewer",
          VerifiedAt: "2026-10-02T18:00:00Z",
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
    expect(
      errors.some(
        (e) =>
          e.includes("expected one of") &&
          e.includes("'L'") &&
          e.includes("'M'") &&
          e.includes("'S'") &&
          e.includes("'XL'"),
      ),
    ).toBe(true);
    expect(errors.some((e) => e.includes("'XS'"))).toBe(false);
  });

  it("accepts optional PlanItem.stopConditions anchors and rejects malformed (#1613)", () => {
    const wellFormed = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              {
                id: "helper-shape",
                kind: "anchor",
                path: "packages/core/src/example.ts",
                excerpt: "export function helper(",
                observeAt: "item-start",
              },
              {
                id: "digest-only",
                kind: "anchor",
                path: "README.md",
                digest: "sha256:abc",
              },
            ],
          },
        ],
      },
    };
    expect(validateVbriefSchema(wellFormed, "stop-ok.json")).toEqual([]);

    const omitted = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "t1", title: "Task", status: "pending" }],
      },
    };
    expect(validateVbriefSchema(omitted, "stop-omitted.json")).toEqual([]);

    const badKind = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              {
                id: "a1",
                kind: "assumption",
                path: "x.ts",
                excerpt: " cons ",
              },
            ],
          },
        ],
      },
    };
    const kindErrors = validateVbriefSchema(badKind, "stop-bad-kind.json");
    expect(kindErrors.some((e) => e.includes("invalid kind"))).toBe(true);

    const missingAnchor = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [{ id: "a1", kind: "anchor", path: "x.ts" }],
          },
        ],
      },
    };
    const missingErrors = validateVbriefSchema(missingAnchor, "stop-missing-content.json");
    expect(missingErrors.some((e) => e.includes("excerpt") || e.includes("digest"))).toBe(true);

    const badObserve = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              {
                id: "a1",
                kind: "anchor",
                path: "x.ts",
                excerpt: " cons ",
                observeAt: "before-cited-edit",
              },
            ],
          },
        ],
      },
    };
    const observeErrors = validateVbriefSchema(badObserve, "stop-bad-observe.json");
    expect(observeErrors.some((e) => e.includes("invalid observeAt"))).toBe(true);

    const bareString = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: ["stop if files moved"],
          },
        ],
      },
    };
    const bareErrors = validateVbriefSchema(bareString, "stop-bare-string.json");
    expect(bareErrors.some((e) => e.includes("must be an object"))).toBe(true);

    const notArray = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: { id: "a1", kind: "anchor", path: "x.ts", excerpt: "x" },
          },
        ],
      },
    };
    const notArrayErrors = validateVbriefSchema(notArray, "stop-not-array.json");
    expect(notArrayErrors.some((e) => e.includes("must be an array"))).toBe(true);

    const missingCore = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [{ excerpt: "x", digest: 12, resolvedAtSha: 1, rationale: false }],
          },
        ],
      },
    };
    const missingCoreErrors = validateVbriefSchema(missingCore, "stop-missing-core.json");
    expect(missingCoreErrors.some((e) => e.includes("missing non-empty string 'id'"))).toBe(true);
    expect(missingCoreErrors.some((e) => e.includes("missing 'kind'"))).toBe(true);
    expect(missingCoreErrors.some((e) => e.includes("missing non-empty string 'path'"))).toBe(true);
    expect(missingCoreErrors.some((e) => e.includes(".digest must be a string"))).toBe(true);
    expect(missingCoreErrors.some((e) => e.includes(".resolvedAtSha must be a string"))).toBe(true);
    expect(missingCoreErrors.some((e) => e.includes(".rationale must be a string"))).toBe(true);

    const badExcerptType = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              { id: "a1", kind: "anchor", path: "x.ts", excerpt: 99, digest: "sha256:x" },
            ],
          },
        ],
      },
    };
    const excerptTypeErrors = validateVbriefSchema(badExcerptType, "stop-bad-excerpt-type.json");
    expect(excerptTypeErrors.some((e) => e.includes(".excerpt must be a string"))).toBe(true);

    const unknownField = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              {
                id: "a1",
                kind: "anchor",
                path: "x.ts",
                excerpt: "x",
                observeAtt: "item-start",
              },
            ],
          },
        ],
      },
    };
    const unknownErrors = validateVbriefSchema(unknownField, "stop-unknown-field.json");
    expect(unknownErrors.some((e) => e.includes("unknown field"))).toBe(true);

    const escapePath = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            id: "t1",
            title: "Task",
            status: "pending",
            stopConditions: [
              { id: "a1", kind: "anchor", path: "../secrets/token", excerpt: "x" },
              { id: "a2", kind: "anchor", path: "/etc/passwd", excerpt: "x" },
            ],
          },
        ],
      },
    };
    const escapeErrors = validateVbriefSchema(escapePath, "stop-escape-path.json");
    expect(escapeErrors.filter((e) => e.includes("repo-relative")).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("rejects non-conformant string PlanItem.id and leaves omitted/integer ids (#4707)", () => {
    const legal = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          { id: "clause.1", title: "dotted", status: "pending" },
          { id: "github.issue.5450735782", title: "mint", status: "pending" },
          { id: "1", title: "digit", status: "pending" },
          { title: "omitted", status: "pending" },
          { id: 2, title: "integer leftover", status: "pending" },
        ],
      },
    };
    expect(validateVbriefSchema(legal, "id-legal.json")).toEqual([]);

    // Leftover clause:N warn-accepts on VALID_PLAN_STATUSES under 0.8 (#5467).
    const colonWarnings: string[] = [];
    const colon = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [{ id: "clause:1", title: "colon", status: "pending" }],
      },
    };
    expect(validateVbriefSchema(colon, "id-colon.json", colonWarnings)).toEqual([]);
    expect(
      colonWarnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:1")),
    ).toBe(true);

    const nestedWarnings: string[] = [];
    const nested = {
      ...MINIMAL_V08,
      plan: {
        ...MINIMAL_V08.plan,
        items: [
          {
            title: "parent",
            status: "pending",
            subItems: [{ id: "clause:2", title: "nested", status: "pending" }],
          },
        ],
      },
    };
    expect(validateVbriefSchema(nested, "id-nested.json", nestedWarnings)).toEqual([]);
    expect(
      nestedWarnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:2")),
    ).toBe(true);

    // Non-legacy illegal ids still hard-FAIL.
    expect(
      validateVbriefSchema(
        {
          ...MINIMAL_V08,
          plan: {
            ...MINIMAL_V08.plan,
            items: [{ id: "has spaces", title: "bad", status: "pending" }],
          },
        },
        "id-spaces.json",
      ).some((e) => e.includes("invalid id")),
    ).toBe(true);
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

  it("validateVbriefSchema reports pull-request as a demoted warning under 0.8 (#5467)", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      {
        ...MINIMAL_V08,
        plan: {
          ...MINIMAL_V08.plan,
          references: [{ uri: prUri, type: "x-xbrief/pull-request" }],
        },
      },
      "brief.json",
      warnings,
    );
    expect(errors.some((e) => e.includes("x-xbrief/pull-request"))).toBe(false);
    expect(warnings.some((w) => w.includes("x-xbrief/pull-request"))).toBe(true);
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
  "verification",
  "evidence",
  "runtime-evidence",
  "change-proposal",
  "delivery-evidence",
  "build-run",
  "hash-pinned-input",
  "upstream-defect",
  "azure-boards-issue",
  "prerequisite",
  "related-pr",
  "source",
  "runbook",
  "prior-art",
  "peer",
  "upstream",
  "origin",
  "related-scope",
] as const;

const BESTIMAX_CLASS_B_BARES = [
  "prerequisite",
  "related-pr",
  "source",
  "runbook",
  "prior-art",
  "peer",
  "upstream",
  "origin",
  "related-scope",
] as const;

const CLASS_B_PREFIXES = ["x-vbrief/", "x-xbrief/"] as const;

const REFERENCES_MD = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../content/conventions/references.md",
);

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

describe("Class B reserved-prefix compatibility (#4746 / #4765 / #4846)", () => {
  it("warns on all forty-eight Class B spellings and keeps them off the fatal-errors API", () => {
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
        expect(warnings[0], type).not.toContain("nearest canonical");
        const described = describeUnknownReservedReferenceType(type);
        expect(described?.subtype, type).toBe(bare);
        expect(described?.nearestCanonical, type).toBeNull();
        expect(validateVbriefSchema(classBDoc(type), "brief.json"), type).toEqual([]);
        expect(isRecognizedReservedReferenceType(type), type).toBe(false);
      }
    }
  });

  it("keeps the nine BestiMax bares off known types and aliases (#4846)", () => {
    for (const bare of BESTIMAX_CLASS_B_BARES) {
      expect(CLASS_B_BARES, bare).toContain(bare);
      expect(RESERVED_REFERENCE_TYPE_ALIASES[bare], bare).toBeUndefined();
      for (const prefix of CLASS_B_PREFIXES) {
        const type = prefix + bare;
        expect(KNOWN_REFERENCE_TYPES as readonly string[], type).not.toContain(type);
        expect(isRecognizedReservedReferenceType(type), type).toBe(false);
      }
    }
    expect(RESERVED_REFERENCE_TYPE_ALIASES["related-pr"]).toBeUndefined();
  });

  it("records the Class B set and the #4846 bounds in conventions/references.md", () => {
    const page = readFileSync(REFERENCES_MD, "utf8");
    for (const bare of CLASS_B_BARES) {
      expect(page, bare).toContain(`\`${bare}\``);
    }
    expect(page).toContain("`related-pr` is not `github-pr`");
    expect(page).toContain("`origin` is not delivery provenance");
    expect(page).toContain("18 completed, 8 proposed, 0 pending, 0 active");
    expect(page).toContain("Every cited type was `x-xbrief`");
    expect(page).toContain("Append-on-discovery is not the steady state");
    expect(page).toContain("permanent warning");
    expect(page).toContain("no read-only discriminator");
    expect(page).toContain("`--warnings-as-errors` still fails");
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

  it("keeps Class A aliases as helper errors when status/version omitted; 0.8 schema warns (#5467)", () => {
    for (const type of ["x-xbrief/pull-request", "x-vbrief/github-pull-request"]) {
      const { errors, warnings } = validatePlanReferenceTypes(
        [{ uri: "https://github.com/deftai/directive/pull/1", type }],
        "brief.json",
      );
      expect(errors, type).toHaveLength(1);
      expect(warnings, type).toEqual([]);
      const schemaWarnings: string[] = [];
      expect(validateVbriefSchema(classBDoc(type), "brief.json", schemaWarnings), type).toEqual([]);
      expect(
        schemaWarnings.some((w) => w.includes(type)),
        type,
      ).toBe(true);
    }
  });

  it("routes Class B and Class A aliases to validateAll warnings under 0.8 (#5467)", () => {
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
    expect(mixed.errors.some((e) => e.includes("x-xbrief/pull-request"))).toBe(false);
    expect(mixed.warnings.some((w) => w.includes("x-xbrief/pull-request"))).toBe(true);
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

  it(
    "CLI exits 0 for each of the twenty-four names under both prefixes and 1 with --warnings-as-errors",
    destContentionItTimeout(),
    () => {
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
    },
  );

  it("CLI warn-accepts Class A aliases and github_pr under 0.8; --warnings-as-errors stays fail-closed", () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), "vb-4746-alias-"));
    const aliasDir = writeProposedBrief(
      aliasRoot,
      "2026-09-18-alias.xbrief.json",
      "x-xbrief/pull-request",
    );
    // Prefer-A (#5467): unknown reserved-prefix (including Class A aliases) warns on draft 0.8.
    expect(runValidate(["--vbrief-dir", aliasDir])).toBe(0);
    expect(runValidate(["--vbrief-dir", aliasDir, "--warnings-as-errors"])).toBe(1);
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
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(0);
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(1);
    rmSync(mixedRoot, { recursive: true, force: true });
  });
});

const NEVER_REGISTERED_TYPE = "x-xbrief/zz-never-registered-subtype";

function classRErrors(messages: readonly string[]): string[] {
  return messages.filter((m) => m.includes("unknown reserved-prefix subtype"));
}

function classCErrors(messages: readonly string[]): string[] {
  return messages.filter((m) => m.includes("invalid id") && m.includes("clause:"));
}

function historicalDoc(
  overrides: {
    status?: string;
    itemId?: string;
    nestedItemId?: string;
    refType?: string;
    itemStatus?: string;
    version?: string;
  } = {},
) {
  const itemId = overrides.itemId ?? "clause:1";
  const itemStatus = overrides.itemStatus ?? "completed";
  const items =
    overrides.nestedItemId === undefined
      ? [{ id: itemId, title: "legacy clause", status: itemStatus }]
      : [
          {
            title: "parent",
            status: "completed",
            subItems: [{ id: overrides.nestedItemId, title: "nested", status: itemStatus }],
          },
        ];
  return {
    xBRIEFInfo: { version: overrides.version ?? "0.8" },
    plan: {
      title: "Visage corpus historical brief",
      status: overrides.status ?? "completed",
      items,
      references: [
        {
          uri: "https://example.test/zz-never-registered",
          type: overrides.refType ?? NEVER_REGISTERED_TYPE,
        },
      ],
    },
  };
}

function classInvalidatesErrors(messages: readonly string[]): string[] {
  return messages.filter((m) => m.includes("invalidates"));
}

describe("Visage validate compat across VALID_PLAN_STATUSES (#5467 Prefer-A)", () => {
  it("keeps isTerminalPlanStatus narrow; VALID_PLAN_STATUSES is the compatibility set", () => {
    expect(isTerminalPlanStatus("completed")).toBe(true);
    expect(isTerminalPlanStatus("cancelled")).toBe(true);
    expect(isTerminalPlanStatus("failed")).toBe(true);
    expect(isTerminalPlanStatus("running")).toBe(false);
    expect(isTerminalPlanStatus("draft")).toBe(false);
    expect(isTerminalPlanStatus(undefined)).toBe(false);
    expect(isValidPlanStatusMember("draft")).toBe(true);
    expect(isValidPlanStatusMember("running")).toBe(true);
    expect(isValidPlanStatusMember("blocked")).toBe(true);
    expect(isValidPlanStatusMember("active")).toBe(false);
    expect(isValidPlanStatusMember(undefined)).toBe(false);
    for (const status of VALID_PLAN_STATUSES) {
      expect(isValidPlanStatusMember(status), status).toBe(true);
    }
  });

  it("normative draft fixture: unknown reserved subtype warns, zero class-R hard FAILs", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      historicalDoc({ status: "draft", itemId: "clause.1", refType: NEVER_REGISTERED_TYPE }),
      "draft-unknown.json",
      warnings,
    );
    expect(classRErrors(errors)).toEqual([]);
    expect(warnings.filter((w) => w.includes(NEVER_REGISTERED_TYPE))).toHaveLength(1);
  });

  it("normative running fixture: leftover clause:1 warns, zero class-C hard FAILs", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      historicalDoc({
        status: "running",
        itemId: "clause:1",
        refType: "x-xbrief/github-issue",
      }),
      "running-colon.json",
      warnings,
    );
    expect(classCErrors(errors)).toEqual([]);
    expect(
      warnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:1")),
    ).toBe(true);
  });

  it("normative completed fixture: failed-without-invalidates warns, zero hard FAILs of that class", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      historicalDoc({
        status: "completed",
        itemId: "clause.3",
        itemStatus: "failed",
        refType: "x-xbrief/github-issue",
      }),
      "completed-no-invalidates.json",
      warnings,
    );
    expect(classInvalidatesErrors(errors)).toEqual([]);
    expect(classInvalidatesErrors(warnings)).toHaveLength(1);
    expect(warnings.some((w) => w.includes("clause.3") && w.includes("invalidates"))).toBe(true);
  });

  it("completed failed-without-invalidates still re-emits when warnings array is omitted", () => {
    const doc = historicalDoc({
      status: "completed",
      itemId: "clause.3",
      itemStatus: "failed",
      refType: "x-xbrief/github-issue",
    });
    expect(classInvalidatesErrors(validateVbriefSchema(doc, "completed-no-warns.json"))).toEqual(
      [],
    );
    expect(() => reEmitVbriefArtifact(doc, "completed-no-warns.json")).not.toThrow();
  });

  it("demotes unknown reserved-prefix on every VALID_PLAN_STATUSES member under 0.8", () => {
    for (const status of VALID_PLAN_STATUSES) {
      const { errors, warnings } = validatePlanReferenceTypes(
        [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
        "brief.json",
        status,
        "0.8",
      );
      expect(errors, status).toEqual([]);
      expect(warnings, status).toHaveLength(1);
      expect(warnings[0], status).toContain(NEVER_REGISTERED_TYPE);
    }
  });

  it("omitted plan status keeps CLASS_B-only severity for unit honesty", () => {
    const unknown = validatePlanReferenceTypes(
      [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
      "brief.json",
    );
    expect(unknown.errors).toHaveLength(1);
    expect(unknown.warnings).toEqual([]);

    const classB = validatePlanReferenceTypes(
      [{ uri: "https://example.test/ref", type: "x-xbrief/depends-on" }],
      "brief.json",
    );
    expect(classB.errors).toEqual([]);
    expect(classB.warnings).toHaveLength(1);
  });

  it("live running ledgers stay fail-closed on failed-without-invalidates", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      historicalDoc({
        status: "running",
        itemId: "clause.3",
        itemStatus: "failed",
        refType: "x-xbrief/github-issue",
      }),
      "running-no-invalidates.json",
      warnings,
    );
    expect(classInvalidatesErrors(errors)).toHaveLength(1);
    expect(classInvalidatesErrors(warnings)).toEqual([]);
  });

  it("live-plan provenance errors remain errors (isTerminalPlanStatus not widened)", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "live provenance",
          status: "running",
          // Pure named-class Source without Evidence — hard-FAIL on live plans.
          narratives: { Source: "verified:task-check" },
          items: [{ id: "t1", title: "Task", status: "running" }],
        },
      },
      "live-provenance.json",
      warnings,
    );
    expect(errors.some((e) => e.includes("Evidence is required"))).toBe(true);

    // Same payload on completed still grandfathers via terminal-only isTerminalPlanStatus.
    const completedWarnings: string[] = [];
    const completedErrors = validateVbriefSchema(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "completed provenance",
          status: "completed",
          narratives: { Source: "verified:task-check" },
          items: [{ id: "t1", title: "Task", status: "completed" }],
        },
      },
      "completed-provenance.json",
      completedWarnings,
    );
    expect(completedErrors.some((e) => e.includes("Evidence is required"))).toBe(false);
  });

  it("read-accepts nested clause:N on running and hard-FAILs malformed ids", () => {
    const nestedWarnings: string[] = [];
    const nestedErrors = validateVbriefSchema(
      historicalDoc({
        status: "running",
        nestedItemId: "clause:2",
        refType: "x-xbrief/github-issue",
      }),
      "nested-colon.json",
      nestedWarnings,
    );
    expect(classCErrors(nestedErrors)).toEqual([]);
    expect(
      nestedWarnings.some((w) => w.includes("legacy clause-colon id") && w.includes("clause:2")),
    ).toBe(true);

    const malformedWarnings: string[] = [];
    const malformedErrors = validateVbriefSchema(
      historicalDoc({
        status: "running",
        itemId: "clause:bad",
        refType: "x-xbrief/github-issue",
      }),
      "malformed-id.json",
      malformedWarnings,
    );
    expect(malformedErrors.some((e) => e.includes("invalid id") && e.includes("clause:bad"))).toBe(
      true,
    );
    expect(malformedWarnings.some((w) => w.includes("clause:bad"))).toBe(false);

    const otherIllegal = validateVbriefSchema(
      historicalDoc({
        status: "running",
        itemId: "has spaces",
        refType: "x-xbrief/github-issue",
      }),
      "spaces-id.json",
    );
    expect(otherIllegal.some((e) => e.includes("invalid id"))).toBe(true);
  });

  it("does not grow CLASS_B with Visage never-registered subtype", () => {
    // Without envelope 0.8, draft stays hard-FAIL (Reject B: no per-consumer CLASS_B growth).
    expect(
      validatePlanReferenceTypes(
        [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
        "brief.json",
        "draft",
      ).errors,
    ).toHaveLength(1);
    // Under 0.8 the same subtype warns via status membership, not CLASS_B expansion.
    const under08 = validatePlanReferenceTypes(
      [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
      "brief.json",
      "draft",
      "0.8",
    );
    expect(under08.errors).toEqual([]);
    expect(under08.warnings).toHaveLength(1);
  });

  it("C8 lite: envelope 0.8 stays 0.8; unknown reserved-prefix must not hard-FAIL without bump", () => {
    const warnings: string[] = [];
    const doc = historicalDoc({ status: "proposed", itemId: "clause.1" });
    expect(doc.xBRIEFInfo.version).toBe("0.8");
    const errors = validateVbriefSchema(doc, "c8-lite.json", warnings);
    expect(classRErrors(errors)).toEqual([]);
    expect(warnings.some((w) => w.includes(NEVER_REGISTERED_TYPE))).toBe(true);
  });

  it("0.6 preserves terminal-only reserved-prefix demotion", () => {
    const running06 = validatePlanReferenceTypes(
      [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
      "brief.json",
      "running",
      "0.6",
    );
    expect(running06.errors).toHaveLength(1);
    expect(running06.warnings).toEqual([]);

    const completed06 = validatePlanReferenceTypes(
      [{ uri: "https://example.test/zz", type: NEVER_REGISTERED_TYPE }],
      "brief.json",
      "completed",
      "0.6",
    );
    expect(completed06.errors).toEqual([]);
    expect(completed06.warnings).toHaveLength(1);
  });

  it("validateAll and CLI collect demoted warnings; --warnings-as-errors stays fail-closed", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-5467-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "active"), { recursive: true });
    mkdirSync(join(vbrief, "completed"), { recursive: true });
    writeFileSync(
      join(vbrief, "proposed", "2026-10-07-draft-unknown.xbrief.json"),
      JSON.stringify(
        historicalDoc({ status: "draft", itemId: "clause.1", refType: NEVER_REGISTERED_TYPE }),
      ),
      "utf8",
    );
    writeFileSync(
      join(vbrief, "active", "2026-10-07-running-colon.xbrief.json"),
      JSON.stringify(
        historicalDoc({
          status: "running",
          itemId: "clause:1",
          refType: "x-xbrief/github-issue",
        }),
      ),
      "utf8",
    );
    writeFileSync(
      join(vbrief, "completed", "2026-10-07-completed-no-invalidates.xbrief.json"),
      JSON.stringify(
        historicalDoc({
          status: "completed",
          itemId: "clause.3",
          itemStatus: "failed",
          refType: "x-xbrief/github-issue",
        }),
      ),
      "utf8",
    );

    const result = validateAll(vbrief);
    expect(classRErrors(result.errors)).toEqual([]);
    expect(classCErrors(result.errors)).toEqual([]);
    expect(classInvalidatesErrors(result.errors)).toEqual([]);
    expect(
      result.warnings.filter((w) => w.includes(NEVER_REGISTERED_TYPE)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      result.warnings.filter((w) => w.includes("legacy clause-colon id")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(classInvalidatesErrors(result.warnings).length).toBeGreaterThanOrEqual(1);

    expect(runValidate(["--vbrief-dir", vbrief])).toBe(0);
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
