import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_EVIDENCE_KEY, stampMatchAnyFileEvidence } from "./acceptance-evidence.js";
import {
  BIND_CLAUSE_ACTION,
  BIND_CLAUSE_VERB,
  bindClauseOnBrief,
  bindSelectedClausesToDeclaredPath,
} from "./bind-clause.js";
import { formatBriefJson } from "./brief-io.js";
import { minimalScopeBrief } from "./scope-test-fixtures.test.js";
import { stampEvidenceOnBrief } from "./stamp-evidence.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithPointer(): { root: string; pointer: string } {
  const root = mkdtempSync(join(tmpdir(), "bind-clause-"));
  temps.push(root);
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const pointer = "packages/a/index.test.ts";
  writeFileSync(join(root, pointer), "export {}\n", "utf8");
  return { root, pointer };
}

describe("bindSelectedClausesToDeclaredPath (#4986)", () => {
  it("exports the explicit-bind verb tokens", () => {
    expect(BIND_CLAUSE_ACTION).toBe("bind-clause");
    expect(BIND_CLAUSE_VERB).toBe("scope:bind-clause");
  });

  it("is a silent no-op when file_scope is empty", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          { id: 1, text: "behavioral with no file token", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: [] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    expect(result.boundIds).toEqual([]);
    expect(result.message).toContain("empty file_scope");
    const acceptance = plan.acceptance as { clauses: Array<{ artifact_path: string | null }> };
    expect(acceptance.clauses[0]?.artifact_path).toBeNull();
  });

  it("binds a pathless clause onto an approved file_scope member", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          { id: 1, text: "behavioral with no file token", artifact_path: null, ambiguous: false },
          { id: 2, text: "another unbound behavioral", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    expect(result.boundIds).toEqual([1]);
    const acceptance = plan.acceptance as { clauses: Array<{ artifact_path: string | null }> };
    expect(acceptance.clauses[0]?.artifact_path).toBe(pointer);
    expect(acceptance.clauses[1]?.artifact_path).toBeNull();
  });

  it("refuses a path outside approved file_scope", () => {
    const { root } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          { id: 1, text: "behavioral with no file token", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: "packages/b/outside.test.ts",
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a non-glob matchAny file");
  });

  it("refuses unknown clause ids and missing --clause selection", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          { id: 1, text: "behavioral with no file token", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    expect(
      bindSelectedClausesToDeclaredPath(plan, {
        path: pointer,
        clauseIds: [],
        projectRoot: root,
      }).ok,
    ).toBe(false);
    expect(
      bindSelectedClausesToDeclaredPath(plan, {
        path: pointer,
        clauseIds: [99],
        projectRoot: root,
      }).message,
    ).toContain("unknown clause id");
  });

  it("refuses overwrite of already-bound or stated artifact_path", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          {
            id: 1,
            text: "already bound stated clause",
            artifact_path: "packages/a/other.test.ts",
            ambiguous: false,
          },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already has artifact_path");
    const acceptance = plan.acceptance as { clauses: Array<{ artifact_path: string | null }> };
    expect(acceptance.clauses[0]?.artifact_path).toBe("packages/a/other.test.ts");
  });

  it("refuses readings without an explicit chosen_reading", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          {
            id: 1,
            text: "ambiguous pathless",
            artifact_path: null,
            ambiguous: true,
            readings: [
              { text: "reading A", artifact_path: null },
              { text: "reading B", artifact_path: null },
            ],
          },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no explicit chosen_reading");
  });

  it("binds the explicit chosen_reading when pathless", () => {
    const { root, pointer } = repoWithPointer();
    const plan: Record<string, unknown> = {
      acceptance: {
        clauses: [
          {
            id: 1,
            text: "ambiguous pathless",
            artifact_path: null,
            ambiguous: true,
            chosen_reading: 1,
            readings: [
              { text: "reading A", artifact_path: null },
              { text: "reading B", artifact_path: null },
            ],
          },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const result = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(result.ok).toBe(true);
    expect(result.boundIds).toEqual([1]);
    const acceptance = plan.acceptance as {
      clauses: Array<{
        artifact_path: string | null;
        chosen_reading?: number;
        readings?: Array<{ artifact_path: string | null }>;
      }>;
    };
    expect(acceptance.clauses[0]?.artifact_path).toBe(pointer);
    expect(acceptance.clauses[0]?.chosen_reading).toBe(1);
    expect(acceptance.clauses[0]?.readings?.[0]?.artifact_path).toBeNull();
    expect(acceptance.clauses[0]?.readings?.[1]?.artifact_path).toBe(pointer);
  });
});

describe("bind then stampMatchAnyFileEvidence (#4986)", () => {
  it("records kind:test on a clause after explicit bind", () => {
    const { root, pointer } = repoWithPointer();
    const item: Record<string, unknown> = {
      id: "clause.1",
      title: "clause.1",
      status: "pending",
    };
    const plan: Record<string, unknown> = {
      items: [item],
      acceptance: {
        clauses: [
          { id: 1, text: "behavioral with no file token", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    const bound = bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    expect(bound.ok).toBe(true);
    const stamped = stampMatchAnyFileEvidence(plan, {
      recorded_by: "scope:stamp-evidence",
      recorded_at: "2026-09-24T00:00:00Z",
      projectRoot: root,
    });
    expect(stamped.stampedIds).toEqual(["clause.1"]);
    expect(item[ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({
      kind: "test",
      pointer,
      recorded_by: "scope:stamp-evidence",
    });
  });

  it("leaves unbound clauses fail-closed for stamp", () => {
    const { root, pointer } = repoWithPointer();
    const boundItem: Record<string, unknown> = {
      id: "clause.1",
      title: "clause.1",
      status: "pending",
    };
    const unboundItem: Record<string, unknown> = {
      id: "clause.2",
      title: "clause.2",
      status: "pending",
    };
    const plan: Record<string, unknown> = {
      items: [boundItem, unboundItem],
      acceptance: {
        clauses: [
          { id: 1, text: "selected for bind", artifact_path: null, ambiguous: false },
          { id: 2, text: "left unbound", artifact_path: null, ambiguous: false },
        ],
      },
      metadata: { swarm: { file_scope: ["packages/a/**"] } },
    };
    bindSelectedClausesToDeclaredPath(plan, {
      path: pointer,
      clauseIds: [1],
      projectRoot: root,
    });
    const stamped = stampMatchAnyFileEvidence(plan, {
      recorded_by: "scope:stamp-evidence",
      recorded_at: "2026-09-24T00:00:00Z",
      projectRoot: root,
    });
    expect(stamped.stampedIds).toEqual(["clause.1"]);
    expect(stamped.skipped).toEqual([{ clauseId: 2, reason: "no-allowed-pointer" }]);
    expect(boundItem[ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({ kind: "test", pointer });
    expect(unboundItem[ACCEPTANCE_EVIDENCE_KEY]).toBeUndefined();
  });
});

describe("bindClauseOnBrief (#4986)", () => {
  it("persists the bound path then lets stamp-evidence write kind:test", () => {
    const { root, pointer } = repoWithPointer();
    const file = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(
      file,
      formatBriefJson(
        minimalScopeBrief({
          title: "T",
          status: "running",
          items: [],
          acceptance: {
            commands: [],
            none_stated: true,
            source_rung: "derived",
            clauses: [
              {
                id: 1,
                text: "behavioral with no file token",
                artifact_path: null,
                ambiguous: false,
              },
            ],
          },
          metadata: { swarm: { file_scope: ["packages/a/**"] } },
        }),
      ),
      "utf8",
    );
    const bound = bindClauseOnBrief(file, {
      projectRoot: root,
      path: pointer,
      clauseIds: [1],
    });
    expect(bound.ok).toBe(true);
    expect(bound.boundIds).toEqual([1]);
    const afterBind = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { acceptance: { clauses: Array<{ artifact_path: string | null }> } };
    };
    expect(afterBind.plan.acceptance.clauses[0]?.artifact_path).toBe(pointer);
    const stamped = stampEvidenceOnBrief(file, {
      projectRoot: root,
      recorded_at: "2026-09-24T00:00:00Z",
    });
    expect(stamped.ok).toBe(true);
    expect(stamped.stampedIds).toEqual(["clause.1"]);
    const afterStamp = JSON.parse(readFileSync(file, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(afterStamp.plan.items[0]?.[ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({
      kind: "test",
      pointer,
    });
  });
});
