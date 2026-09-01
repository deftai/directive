import { describe, expect, it } from "vitest";
import {
  applyPromoteClauseFileScopeBind,
  evaluatePromoteClauseFileScopeBind,
  shouldApplyPromoteClauseFileScopeBind,
} from "./clause-file-scope-bind.js";

const DECLARED = "src/ui/ledger-table/useDensity.ts";

function planWith(clauses: unknown[], fileScope: string[] = [DECLARED]): Record<string, unknown> {
  return {
    title: "density",
    narratives: { Overview: `## Acceptance sketch\n- Add ${DECLARED} exposing mode\n` },
    metadata: { swarm: { file_scope: fileScope } },
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      clauses,
    },
  };
}

describe("promote clause file_scope bind (#4008)", () => {
  it("stamps the declared member onto a matching derived clause", () => {
    const plan = planWith([
      {
        id: 1,
        text: `Add ${DECLARED} exposing mode`,
        artifact_path: null,
        ambiguous: false,
      },
    ]);
    const result = applyPromoteClauseFileScopeBind(plan);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const acceptance = plan.acceptance as { clauses: { artifact_path: string | null }[] };
    expect(acceptance.clauses[0]?.artifact_path).toBe(DECLARED);
  });

  it("refuses promote when a path-bearing clause names no exact member", () => {
    const plan = planWith([
      {
        id: 1,
        text: "Add useDensity.ts exposing mode",
        artifact_path: null,
        ambiguous: false,
      },
    ]);
    const result = evaluatePromoteClauseFileScopeBind(plan);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("#4008");
    expect(result.message).toContain("Basename matching is refused");
  });

  it("stamps duplicate clause ids in row order rather than last-id-wins", () => {
    const plan = planWith([
      {
        id: 1,
        text: `Add ${DECLARED} exposing mode`,
        artifact_path: null,
        ambiguous: false,
      },
      {
        id: 1,
        text: "No clause-count cap is introduced",
        artifact_path: null,
        ambiguous: false,
      },
    ]);
    const result = applyPromoteClauseFileScopeBind(plan);
    expect(result.ok).toBe(true);
    const acceptance = plan.acceptance as { clauses: { artifact_path: string | null }[] };
    expect(acceptance.clauses[0]?.artifact_path).toBe(DECLARED);
    expect(acceptance.clauses[1]?.artifact_path).toBeNull();
  });

  it("does not apply the derived bind gate to stated stamps", () => {
    expect(
      shouldApplyPromoteClauseFileScopeBind({
        acceptance: { source_rung: "stated", clauses: [{ id: 1, text: "x" }] },
      }),
    ).toBe(false);
    expect(shouldApplyPromoteClauseFileScopeBind({ acceptance: { source_rung: "derived" } })).toBe(
      true,
    );
  });

  it("skips the gate when file_scope is empty", () => {
    const plan = planWith(
      [
        {
          id: 1,
          text: `Add ${DECLARED} exposing mode`,
          artifact_path: null,
          ambiguous: false,
        },
      ],
      [],
    );
    const result = applyPromoteClauseFileScopeBind(plan);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });
});
