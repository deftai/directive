/**
 * Stored-mint conflict for xbrief:verify and xbrief:adopt-stored-plan-id (#4963).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createXbrief } from "./create.js";
import { readStoredPlanIdBinding, storedMintIdentityConflict } from "./stored-mint-conflict.js";
import { verifyXbrief } from "./verify.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const here = dirname(fileURLToPath(import.meta.url));

function restBinding(
  id: string,
  restId: number,
  origin = "deftai/directive#4963",
): Record<string, unknown> {
  return {
    version: 1,
    source: "github-rest-id",
    github_issue_id: restId,
    origin,
    id,
  };
}

function writeCreated(root: string, stem: string, planId: string): string {
  const created = createXbrief({
    format: "json",
    out: stem,
    style: "scope",
    title: "Stored mint",
    id: planId,
    projectRoot: root,
    force: true,
  });
  expect(created.exitCode, created.stderr).toBe(0);
  return join(root, `${stem}.xbrief.json`);
}

function patchPlan(
  path: string,
  mutate: (plan: Record<string, unknown>, doc: Record<string, unknown>) => void,
): void {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const plan = doc.plan as Record<string, unknown>;
  mutate(plan, doc);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

describe("readStoredPlanIdBinding (#4963)", () => {
  it("treats a missing binding as absent", () => {
    expect(readStoredPlanIdBinding({ metadata: { kind: "scope" } }).kind).toBe("absent");
    expect(readStoredPlanIdBinding({}).kind).toBe("absent");
  });

  it("rejects malformed bindings and accepts a parsed REST binding", () => {
    const cases: Array<{ binding: unknown; kind: string; detail?: string }> = [
      { binding: [], kind: "malformed", detail: "not an object" },
      {
        binding: {
          source: "github-rest-id",
          github_issue_id: 1,
          origin: "o/r#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "missing version",
      },
      {
        binding: {
          version: 2,
          source: "github-rest-id",
          github_issue_id: 1,
          origin: "o/r#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "version is not supported",
      },
      {
        binding: {
          version: 1,
          source: "nope",
          github_issue_id: 1,
          origin: "o/r#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "not a known mint source",
      },
      {
        binding: {
          version: 1,
          source: "github-rest-id",
          github_issue_id: 1,
          origin: "  ",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "origin is malformed",
      },
      {
        binding: {
          version: 1,
          source: "github-rest-id",
          github_issue_id: 1,
          origin: "O/R#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "not a canonical origin key",
      },
      {
        binding: {
          version: 1,
          source: "github-rest-id",
          github_issue_id: 1,
          origin: "o/r#1",
          id: "  ",
        },
        kind: "malformed",
        detail: "id is malformed",
      },
      {
        binding: {
          version: 1,
          source: "github-rest-id",
          github_issue_id: "1",
          origin: "o/r#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "github_issue_id is malformed",
      },
      {
        binding: {
          version: 1,
          source: "github-rest-id",
          github_issue_id: 0,
          origin: "o/r#1",
          id: "github.issue.1",
        },
        kind: "malformed",
        detail: "github_issue_id is malformed",
      },
      {
        binding: {
          version: 1,
          source: "github-repo-fallback",
          github_issue_id: 4,
          origin: "o/r#1",
          id: "github.issue.fallback.o.r.1",
        },
        kind: "malformed",
        detail: "github_issue_id must be null",
      },
    ];
    for (const row of cases) {
      const read = readStoredPlanIdBinding({
        metadata: { "x-directive/plan-id": row.binding },
      });
      expect(read.kind, JSON.stringify(row.binding)).toBe(row.kind);
      if (read.kind === "malformed") {
        expect(read.detail).toContain(row.detail);
      }
    }
    const ok = readStoredPlanIdBinding({
      metadata: { "x-directive/plan-id": restBinding("github.issue.42", 42) },
    });
    expect(ok).toMatchObject({
      kind: "ok",
      binding: { id: "github.issue.42", source: "github-rest-id", githubIssueId: 42 },
    });
  });
});

describe("storedMintIdentityConflict (#4963)", () => {
  it("returns null without a plan or without a parsed binding", () => {
    expect(storedMintIdentityConflict({})).toBeNull();
    expect(
      storedMintIdentityConflict({
        plan: {
          id: "hand-authored",
          metadata: { "x-directive/plan-id": { version: 2 } },
        },
      }),
    ).toBeNull();
  });

  it("names a disagree when plan.id is not the stored binding id", () => {
    const conflict = storedMintIdentityConflict({
      plan: {
        id: "hand-authored",
        metadata: { "x-directive/plan-id": restBinding("github.issue.42", 42) },
      },
    });
    expect(conflict).toEqual({
      detail: "plan.id hand-authored disagrees with stored mint github.issue.42.",
      disagree: true,
    });
  });

  it("reports origin, REST, and fallback clauses without calling them a disagree", () => {
    const origin = storedMintIdentityConflict({
      plan: {
        id: "github.issue.fallback.other.r.6",
        narratives: { Origin: "Ingested from https://github.com/o/r/issues/6" },
        metadata: {
          "x-directive/plan-id": {
            version: 1,
            source: "github-repo-fallback",
            github_issue_id: null,
            origin: "other/r#6",
            id: "github.issue.fallback.other.r.6",
          },
        },
      },
    });
    expect(origin?.disagree).toBe(false);
    expect(origin?.detail).toContain("disagrees with ingest origin o/r#6");

    const rest = storedMintIdentityConflict({
      plan: {
        id: "github.issue.7",
        metadata: { "x-directive/plan-id": restBinding("github.issue.7", 99) },
      },
    });
    expect(rest?.disagree).toBe(false);
    expect(rest?.detail).toContain("disagrees with github_issue_id 99");

    const fallback = storedMintIdentityConflict({
      plan: {
        id: "github.issue.fallback.o.r.7",
        metadata: {
          "x-directive/plan-id": {
            version: 1,
            source: "github-repo-fallback",
            github_issue_id: null,
            origin: "o/r#6",
            id: "github.issue.fallback.o.r.7",
          },
        },
      },
    });
    expect(fallback?.disagree).toBe(false);
    expect(fallback?.detail).toContain("disagrees with fallback mint for o/r#6");

    const unsafe = storedMintIdentityConflict({
      plan: {
        id: "github.issue.fallback.a.b.1",
        metadata: {
          "x-directive/plan-id": {
            version: 1,
            source: "github-repo-fallback",
            github_issue_id: null,
            origin: "a b/r#1",
            id: "github.issue.fallback.a.b.1",
          },
        },
      },
    });
    expect(unsafe?.disagree).toBe(false);
    expect(unsafe?.detail).toContain("disagrees with fallback mint");
  });

  it("accepts a consistent stored mint", () => {
    expect(
      storedMintIdentityConflict({
        plan: {
          id: "github.issue.42",
          metadata: { "x-directive/plan-id": restBinding("github.issue.42", 42) },
        },
      }),
    ).toBeNull();
    expect(
      storedMintIdentityConflict({
        plan: {
          id: "github.issue.fallback.o.r.6",
          metadata: {
            "x-directive/plan-id": {
              version: 1,
              source: "github-repo-fallback",
              github_issue_id: null,
              origin: "o/r#6",
              id: "github.issue.fallback.o.r.6",
            },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("xbrief:verify stored mint (#4963)", () => {
  it("fails a mismatched plan.id and names xbrief:adopt-stored-plan-id", () => {
    const root = freshRoot("xbrief-verify-mint-");
    const stem = "xbrief/proposed/2026-09-23-mismatch";
    const path = writeCreated(root, stem, "hand-authored");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.42", 42);
    });
    const result = verifyXbrief({ format: "json", out: stem, projectRoot: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "plan.id hand-authored disagrees with stored mint github.issue.42.",
    );
    expect(result.stderr).toContain("xbrief:adopt-stored-plan-id");
    expect(result.stderr).not.toContain("evaluateIssuePlanIdAdmission");
    expect(result.stderr).not.toContain("repairNonterminalIssuePlanIds");
  });

  it("fails other stored-mint clauses without naming the adopt command", () => {
    const root = freshRoot("xbrief-verify-rest-");
    const stem = "xbrief/proposed/2026-09-23-rest-clause";
    const path = writeCreated(root, stem, "github.issue.7");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.7", 99);
    });
    const result = verifyXbrief({ format: "json", out: stem, projectRoot: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disagrees with github_issue_id 99");
    expect(result.stderr).not.toContain("xbrief:adopt-stored-plan-id");
  });

  it("does not scan sibling briefs", () => {
    const root = freshRoot("xbrief-verify-sibling-");
    const stem = "xbrief/proposed/2026-09-23-sibling";
    const other = "xbrief/active/2026-09-23-other-id";
    const path = writeCreated(root, stem, "github.issue.42");
    writeCreated(root, other, "github.issue.42");
    patchPlan(path, (plan) => {
      const meta = plan.metadata as Record<string, unknown>;
      meta["x-directive/plan-id"] = restBinding("github.issue.42", 42);
    });
    const result = verifyXbrief({ format: "json", out: stem, projectRoot: root });
    expect(result.exitCode).toBe(0);
  });

  it("does not call admission, mint, or the sibling census", () => {
    const source = readFileSync(join(here, "verify.ts"), "utf8");
    for (const name of [
      "evaluateIssuePlanIdAdmission",
      "repairNonterminalIssuePlanIds",
      "findParentsByPlanId",
      "attachPlanIdMint",
      "mintIssuePlanId",
    ]) {
      expect(source).not.toContain(name);
    }
  });
});
