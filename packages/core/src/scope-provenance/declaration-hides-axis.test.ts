/**
 * declaration-hides-axis (#6591): one warn line when a declaration changed
 * after activation hides a strict axis. Every case is a brief with no intent
 * pin, run through evaluateScopeProvenance on injected merge-base and head
 * maps (bound item 8), plus the predicate and line helpers on their own.
 */
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_EVIDENCE_KEY, ACCEPTANCE_REQUIRES_KEY } from "../scope/acceptance-evidence.js";
import {
  DECLARATION_HIDES_AXIS_REFUSAL_ID,
  declarationHidesAxisLines,
  findDeclarationHidesAxis,
} from "./declaration-hides-axis.js";
import { evaluateScopeProvenance, type ScopeProvenanceResult } from "./evaluate.js";

const LEAF = "2026-11-18-story.xbrief.json";
const ACTIVE = `xbrief/active/${LEAF}`;
const COMPLETED = `xbrief/completed/${LEAF}`;
const PENDING = `xbrief/pending/${LEAF}`;

const DEPLOY_TEXT = "Deploy to staging and confirm the site serves the new build";
const SMOKE_TEXT = "Deploy to staging and run the smoke test";

/** The seven aliases of x-directive/requires. */
const ALIASES = [
  "x-directive/requiredEvidenceKind",
  "x-directive/acceptanceAxis",
  "requires",
  "requiredEvidenceKind",
  "required_evidence_kind",
  "acceptanceAxis",
  "acceptance_axis",
] as const;

type Item = Record<string, unknown>;

function brief(items: Item[], status = "running"): string {
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "story-6591",
      title: "T",
      status,
      items,
      metadata: { swarm: { file_scope: ["packages/core/src/a.ts"] } },
    },
  });
}

function clause(title: string, extra: Item = {}): Item {
  return { id: "clause.1", title, status: "pending", ...extra };
}

const evidence = {
  kind: "test",
  pointer: "packages/core/src/a.test.ts",
  recorded_at: "2026-11-18T00:00:00Z",
  recorded_by: "vitest",
};

/** Evaluate one brief edit: `baseRel` on the merge base, `headRel` on HEAD. */
function evaluate(input: {
  readonly baseRel: string;
  readonly base: Item[];
  readonly headRel: string;
  readonly head: Item[];
}): ScopeProvenanceResult {
  return evaluateScopeProvenance("/tmp/proj-6591", {
    changedFiles:
      input.baseRel === input.headRel ? [input.headRel] : [input.baseRel, input.headRel],
    activeXbriefs: new Map([[input.headRel, brief(input.head)]]),
    baseXbriefs: new Map([[input.baseRel, brief(input.base)]]),
    approvedRecords: [],
    baseApprovedRecords: new Map(),
  });
}

function declaredLines(result: ScopeProvenanceResult): string[] {
  return (result.extraPathReport ?? []).filter((l) =>
    l.includes(`deft gate ${DECLARATION_HIDES_AXIS_REFUSAL_ID} `),
  );
}

/** Exit 0 and exactly one declared line naming the brief, the item and the axes. */
function expectOneLine(result: ScopeProvenanceResult, headRel: string, axes: string): void {
  expect(result.exitCode, result.message).toBe(0);
  const lines = declaredLines(result);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(`${headRel} item clause.1: its declaration hides ${axes},`);
  expect(lines[0]).toContain("warns only in this release");
  expect(lines[0]).toContain("Remedy: `deft verify:scope-provenance`.");
  expect(lines[0]).toContain("owned by #6591");
}

function expectNoLine(result: ScopeProvenanceResult): void {
  expect(result.exitCode, result.message).toBe(0);
  expect(declaredLines(result)).toEqual([]);
}

describe("declaration-hides-axis: a line prints, exit 0 (#6591 item 8)", () => {
  it("requires merge added to deploy text while the brief stays in active/", () => {
    const result = evaluate({
      baseRel: ACTIVE,
      base: [clause(DEPLOY_TEXT)],
      headRel: ACTIVE,
      head: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
    });
    expectOneLine(result, ACTIVE, "deploy");
    expect(declaredLines(result)[0]).toContain(
      `its declaration fields differ from the item on the active brief on the merge base (${ACTIVE})`,
    );
  });

  it("the same edit in the change that moves the brief to completed/", () => {
    const result = evaluate({
      baseRel: ACTIVE,
      base: [clause(DEPLOY_TEXT)],
      headRel: COMPLETED,
      head: [
        clause(DEPLOY_TEXT, {
          [ACCEPTANCE_REQUIRES_KEY]: "merge",
          [ACCEPTANCE_EVIDENCE_KEY]: evidence,
          status: "completed",
        }),
      ],
    });
    expectOneLine(result, COMPLETED, "deploy");
    expect(declaredLines(result)[0]).toContain(`merge base (${ACTIVE})`);
    // Not an intent-pin finding: the move reads no head path on the base.
    expect(result.findings).toEqual([]);
    expect(result.message).toMatch(/verify_scope_provenance: clean/);
  });

  it("requires deploy added to deploy and smoke text names smoke", () => {
    const result = evaluate({
      baseRel: ACTIVE,
      base: [clause(SMOKE_TEXT)],
      headRel: ACTIVE,
      head: [clause(SMOKE_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "deploy" })],
    });
    expectOneLine(result, ACTIVE, "smoke");
    expect(declaredLines(result)[0]).not.toContain("hides smoke, deploy");
  });

  it("a new item with requires merge and deploy text on a brief active on the base", () => {
    const result = evaluate({
      baseRel: ACTIVE,
      base: [{ id: "clause.0", title: "Unit tests cover the parser.", status: "pending" }],
      headRel: ACTIVE,
      head: [
        { id: "clause.0", title: "Unit tests cover the parser.", status: "pending" },
        clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" }),
      ],
    });
    expectOneLine(result, ACTIVE, "deploy");
    expect(declaredLines(result)[0]).toContain(
      "the item is not on the active brief on the merge base",
    );
  });

  it.each(ALIASES)("the alias %s in place of x-directive/requires", (alias) => {
    const result = evaluate({
      baseRel: ACTIVE,
      base: [clause(DEPLOY_TEXT)],
      headRel: ACTIVE,
      head: [clause(DEPLOY_TEXT, { [alias]: "merge" })],
    });
    expectOneLine(result, ACTIVE, "deploy");
  });
});

describe("declaration-hides-axis: no line (#6591 item 8)", () => {
  it("a lifecycle move with no declaration change", () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause(DEPLOY_TEXT)],
        headRel: COMPLETED,
        head: [clause(DEPLOY_TEXT, { status: "completed" })],
      }),
    );
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
        headRel: COMPLETED,
        head: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge", status: "completed" })],
      }),
    );
  });

  it("a declaration already on the base item", () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
        headRel: ACTIVE,
        head: [
          clause(DEPLOY_TEXT, {
            [ACCEPTANCE_REQUIRES_KEY]: "merge",
            [ACCEPTANCE_EVIDENCE_KEY]: evidence,
          }),
        ],
      }),
    );
  });

  it("requires deploy added to deploy-only text", () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause("Deploy the service to staging.")],
        headRel: ACTIVE,
        head: [clause("Deploy the service to staging.", { [ACCEPTANCE_REQUIRES_KEY]: "deploy" })],
      }),
    );
  });

  it("an edit that adds only x-directive/evidence", () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause(DEPLOY_TEXT)],
        headRel: ACTIVE,
        head: [clause(DEPLOY_TEXT, { [ACCEPTANCE_EVIDENCE_KEY]: evidence })],
      }),
    );
  });

  it('a title that gains "deploy" under an unchanged merge declaration', () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause("Run the release workflow.", { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
        headRel: ACTIVE,
        head: [clause("Run the deploy workflow.", { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
      }),
    );
  });

  it("an alias swapped for another with the same hidden set", () => {
    expectNoLine(
      evaluate({
        baseRel: ACTIVE,
        base: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
        headRel: ACTIVE,
        head: [clause(DEPLOY_TEXT, { requires: "merge" })],
      }),
    );
  });

  it("a pending/ to active/ change that first writes the declaration", () => {
    expectNoLine(
      evaluate({
        baseRel: PENDING,
        base: [clause(DEPLOY_TEXT)],
        headRel: ACTIVE,
        head: [clause(DEPLOY_TEXT, { [ACCEPTANCE_REQUIRES_KEY]: "merge" })],
      }),
    );
  });
});

describe("findDeclarationHidesAxis (#6591 item 3)", () => {
  const plan = (items: Item[]): unknown => ({ plan: { items } });

  it("matches an item with no id by its position in the item tree", () => {
    const base = plan([
      { title: "Intro" },
      { title: DEPLOY_TEXT, subItems: [{ title: SMOKE_TEXT }] },
    ]);
    const head = plan([
      { title: "Intro" },
      {
        title: DEPLOY_TEXT,
        subItems: [{ title: SMOKE_TEXT, [ACCEPTANCE_REQUIRES_KEY]: "deploy" }],
      },
    ]);
    expect(findDeclarationHidesAxis(base, head)).toEqual([
      { path: "plan.items[1].subItems[0]", id: null, axes: ["smoke"], newItem: false },
    ]);
    // A no-id item with nothing at its base position is new.
    const added = plan([
      ...(head as { plan: { items: Item[] } }).plan.items,
      { title: DEPLOY_TEXT, requires: "merge" },
    ]);
    expect(findDeclarationHidesAxis(base, added).map((h) => [h.path, h.newItem])).toEqual([
      ["plan.items[1].subItems[0]", false],
      ["plan.items[2]", true],
    ]);
  });

  it("matches an item with an id by id, wherever it moved in the tree", () => {
    const base = plan([
      { id: "a", title: "Unit tests." },
      { id: "b", title: DEPLOY_TEXT, [ACCEPTANCE_REQUIRES_KEY]: "merge" },
    ]);
    const head = plan([
      { id: "b", title: DEPLOY_TEXT, [ACCEPTANCE_REQUIRES_KEY]: "merge" },
      { id: "a", title: "Unit tests." },
    ]);
    expect(findDeclarationHidesAxis(base, head)).toEqual([]);
  });

  it("reports only the axes the base item did not hide", () => {
    const base = plan([{ id: "c", title: SMOKE_TEXT, [ACCEPTANCE_REQUIRES_KEY]: "deploy" }]);
    const head = plan([{ id: "c", title: SMOKE_TEXT, [ACCEPTANCE_REQUIRES_KEY]: "merge" }]);
    expect(findDeclarationHidesAxis(base, head)).toEqual([
      { path: "plan.items[0]", id: "c", axes: ["deploy"], newItem: false },
    ]);
  });

  it("reads no items from a payload that is not an object", () => {
    const head = plan([{ id: "d", title: DEPLOY_TEXT, requires: "merge" }]);
    expect(findDeclarationHidesAxis(null, head)).toEqual([
      { path: "plan.items[0]", id: "d", axes: ["deploy"], newItem: true },
    ]);
    expect(findDeclarationHidesAxis(head, [])).toEqual([]);
  });
});

describe("declarationHidesAxisLines (#6591 items 2 and 4)", () => {
  const head = JSON.parse(brief([clause(DEPLOY_TEXT, { requires: "merge" })])) as unknown;
  const baseText = brief([clause(DEPLOY_TEXT)]);

  it("prints one declared warn line for an active base copy", () => {
    const lines = declarationHidesAxisLines({
      headRel: COMPLETED,
      headPayload: head,
      baseRel: ACTIVE,
      baseRead: { kind: "text", text: baseText },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^⚠ deft gate declaration-hides-axis \(/);
    expect(lines[0]).toContain(`${COMPLETED} item clause.1: its declaration hides deploy`);
  });

  it("prints nothing when the base copy is not active, missing, unreadable or not JSON", () => {
    const cases = [
      { baseRel: PENDING, baseRead: { kind: "text", text: baseText } },
      { baseRel: ACTIVE, baseRead: { kind: "missing" } },
      { baseRel: ACTIVE, baseRead: { kind: "error", message: "bad object" } },
      { baseRel: ACTIVE, baseRead: { kind: "text", text: "{not json" } },
    ] as const;
    for (const c of cases) {
      expect(
        declarationHidesAxisLines({ headRel: ACTIVE, headPayload: head, ...c }),
        c.baseRel,
      ).toEqual([]);
    }
  });
});
