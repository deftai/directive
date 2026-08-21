import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_CRITIQUE_CLEARANCE_SHAPE,
  DESIGN_CRITIQUE_GATE_ID,
  DESIGN_CRITIQUE_MARKER_FIELD,
  DESIGN_CRITIQUE_MARKER_LABEL,
  designCritiqueClearanceShapeOk,
  resolveJudgmentGates,
} from "./judgment-policy.js";
import {
  buildReport,
  type Candidate,
  cmdVerifyJudgmentGates,
  evaluate,
  reportBlocking,
  reportFired,
} from "./verify-judgment-gates.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const DESIGN_CRITIQUE_GATE = {
  id: DESIGN_CRITIQUE_GATE_ID,
  class: "declared",
  tier: "review",
  reason: "Triage author stamped mechanism-shaped (ADR-005).",
  match: {
    labels: { "any-of": [DESIGN_CRITIQUE_MARKER_LABEL] },
  },
};

function makeProject(gates: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "dc-gate-"));
  for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", f), { recursive: true });
  }
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { items: [], policy: { judgmentGates: gates } },
    }),
    "utf8",
  );
  return root;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    paths: [],
    labels: [],
    body: "",
    state: "open",
    updated_at: null,
    ...overrides,
  };
}

describe("design-critique judgment gate (ADR-005 / #3434 Story 1)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads a declared/review entry from PROJECT-DEFINITION matching the stamp label", () => {
    const policy = resolveJudgmentGates(REPO_ROOT);
    expect(policy.error).toBeNull();
    const gate = policy.gates.find((g) => g.gate_id === DESIGN_CRITIQUE_GATE_ID);
    expect(gate).toBeDefined();
    expect(gate?.gate_class).toBe("declared");
    expect(gate?.tier).toBe("review");
    expect(gate?.required_human_reviewers).toBe(0);
    const labels = gate?.match.labels as { "any-of"?: string[] } | undefined;
    expect(labels?.["any-of"]).toContain(DESIGN_CRITIQUE_MARKER_LABEL);
  });

  it("fires when the mirrored label is present and stays silent without the marker", () => {
    const root = makeProject([DESIGN_CRITIQUE_GATE]);
    roots.push(root);

    const stamped = buildReport(
      root,
      candidate({
        labels: [DESIGN_CRITIQUE_MARKER_LABEL],
        body: DESIGN_CRITIQUE_MARKER_FIELD,
      }),
    );
    expect(reportFired(stamped).map((o) => o.gate_id)).toContain(DESIGN_CRITIQUE_GATE_ID);
    expect(reportBlocking(stamped)).toEqual([]);

    const fieldOnly = buildReport(root, candidate({ body: DESIGN_CRITIQUE_MARKER_FIELD }));
    expect(reportFired(fieldOnly).map((o) => o.gate_id)).not.toContain(DESIGN_CRITIQUE_GATE_ID);

    const unmarked = buildReport(
      root,
      candidate({ labels: ["enhancement"], body: "ordinary triage" }),
    );
    expect(reportFired(unmarked)).toEqual([]);
  });

  it("stays advisory without --enforce; --enforce still does not block this declared/review gate", () => {
    const root = makeProject([DESIGN_CRITIQUE_GATE]);
    roots.push(root);
    const stamped = candidate({ labels: [DESIGN_CRITIQUE_MARKER_LABEL] });

    expect(evaluate(root, stamped)[0]).toBe(0);
    expect(evaluate(root, stamped, { posture: "enforce" })[0]).toBe(0);

    expect(
      cmdVerifyJudgmentGates([
        "--quiet",
        "--label",
        DESIGN_CRITIQUE_MARKER_LABEL,
        "--project-root",
        root,
      ]),
    ).toBe(0);
    expect(
      cmdVerifyJudgmentGates([
        "--enforce",
        "--quiet",
        "--label",
        DESIGN_CRITIQUE_MARKER_LABEL,
        "--project-root",
        root,
      ]),
    ).toBe(0);
  });

  it("evaluates clearance presence and shape, never because-clause content", () => {
    expect(designCritiqueClearanceShapeOk("design-critique: warranted, because protocol gap")).toBe(
      true,
    );
    expect(
      designCritiqueClearanceShapeOk("design-critique: not warranted, because disposition-only"),
    ).toBe(true);
    expect(designCritiqueClearanceShapeOk("design-critique: warranted, because x")).toBe(true);
    expect(designCritiqueClearanceShapeOk("design-critique: warranted, because ")).toBe(false);
    expect(designCritiqueClearanceShapeOk("design-critique: maybe, because x")).toBe(false);
    expect(designCritiqueClearanceShapeOk("warranted, because x")).toBe(false);
    expect(DESIGN_CRITIQUE_CLEARANCE_SHAPE.source).not.toMatch(/protocol|disposition/);
  });

  it("documents the #1423 field+label pairing and the ADR-005 clearance line", () => {
    const labelsDoc = readFileSync(join(REPO_ROOT, ".github", "ISSUE_LABELS.md"), "utf8");
    expect(labelsDoc).toContain(DESIGN_CRITIQUE_MARKER_LABEL);
    expect(labelsDoc).toContain(DESIGN_CRITIQUE_MARKER_FIELD);

    const writeBack = readFileSync(join(REPO_ROOT, "content", "commands.md"), "utf8");
    expect(writeBack).toContain(DESIGN_CRITIQUE_MARKER_FIELD);
    expect(writeBack).toContain(DESIGN_CRITIQUE_MARKER_LABEL);

    const adr = readFileSync(
      join(REPO_ROOT, "docs", "decisions", "ADR-005-design-critique-judgment-gate.md"),
      "utf8",
    );
    expect(adr).toMatch(/design-critique:\s*warranted\s*\|\s*not warranted,\s*because/);
    expect(adr).toMatch(/presence/i);
    expect(adr).toMatch(/shape/i);
    expect(adr).toMatch(/authority/i);
  });
});
