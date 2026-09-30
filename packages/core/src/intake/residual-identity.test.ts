import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachResidualLineage,
  briefOwnsIssue,
  findNonterminalResidualHits,
  findOwnedCompletedHits,
  formatCompletedDuplicateWithResidualRecovery,
  isResidualPlanId,
  mintResidualIssuePlanId,
  residualRecoveryCommand,
  selectMostRecentOwnedHit,
} from "./residual-identity.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeOwned(
  dir: string,
  issue: number,
  opts: { planId?: string; source?: string; restId?: number } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const restId = opts.restId ?? issue;
  const planId = opts.planId ?? `github.issue.${restId}`;
  const source = opts.source ?? "github-rest-id";
  const path = join(dir, `2026-09-30-${issue}-sample.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: {
        version: "0.8",
        description: `Scope xBRIEF ingested from GitHub issue #${issue}`,
      },
      plan: {
        title: `Issue ${issue}`,
        id: planId,
        narratives: {
          Origin: `Ingested from https://github.com/deftai/directive/issues/${issue}`,
        },
        metadata: {
          "x-directive/plan-id": {
            version: 1,
            source,
            github_issue_id: restId,
            origin: `deftai/directive#${issue}`,
            id: planId,
          },
        },
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issue}`,
            type: "x-xbrief/github-issue",
          },
        ],
      },
    }),
    "utf8",
  );
  return path;
}

describe("mintResidualIssuePlanId", () => {
  it("mints a distinct residual id that never equals github.issue.REST", () => {
    const minted = mintResidualIssuePlanId({
      issueId: 5453269518,
      owner: "deftai",
      repo: "directive",
      number: 4544,
      leanCommentId: 5913432618,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.id).toBe("github.issue.residual.5453269518.lean.5913432618");
    expect(minted.id).not.toBe("github.issue.5453269518");
    expect(isResidualPlanId(minted.id)).toBe(true);
  });

  it("refuses mint without a positive REST id", () => {
    const minted = mintResidualIssuePlanId({
      issueId: "nope",
      owner: "deftai",
      repo: "directive",
      number: 1,
    });
    expect(minted.ok).toBe(false);
  });
});

describe("briefOwnsIssue shared ownership", () => {
  it("keys on ingest Origin, not bare references", () => {
    const owned = {
      plan: {
        narratives: {
          Origin: "Ingested from https://github.com/deftai/directive/issues/3736",
        },
        references: [
          { uri: "https://github.com/deftai/directive/issues/3739", type: "x-xbrief/github-issue" },
        ],
      },
    };
    expect(briefOwnsIssue(owned, 3736)).toBe(true);
    expect(briefOwnsIssue(owned, 3739)).toBe(false);
  });

  it("does not own from references-only briefs (Prefer-A Bound)", () => {
    const refsOnly = {
      plan: {
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/4544",
            type: "x-xbrief/github-issue",
          },
        ],
      },
    };
    expect(briefOwnsIssue(refsOnly, 4544)).toBe(false);
    expect(briefOwnsIssue(refsOnly, { owner: "deftai", repo: "directive", number: 4544 })).toBe(
      false,
    );
  });

  it("owns bare Origin #N for number-only targets without reopening cross-repo URL holes", () => {
    const bare = {
      plan: {
        narratives: {
          Origin: "Ingested from issue #4544",
        },
      },
    };
    expect(briefOwnsIssue(bare, 4544)).toBe(true);
    // Repo-scoped targets still require URL Origin or plan-id binding.
    expect(briefOwnsIssue(bare, { owner: "deftai", repo: "directive", number: 4544 })).toBe(false);
  });

  it("keeps ownership repo-scoped when the same issue number appears across repos", () => {
    const foreign = {
      plan: {
        narratives: {
          Origin: "Ingested from https://github.com/other/repo/issues/4544",
        },
        metadata: {
          "x-directive/plan-id": {
            version: 1,
            source: "github-rest-id",
            github_issue_id: 99,
            origin: "other/repo#4544",
            id: "github.issue.99",
          },
        },
      },
    };
    expect(briefOwnsIssue(foreign, 4544)).toBe(true);
    expect(briefOwnsIssue(foreign, { owner: "deftai", repo: "directive", number: 4544 })).toBe(
      false,
    );
    expect(briefOwnsIssue(foreign, { owner: "other", repo: "repo", number: 4544 })).toBe(true);
  });
});

describe("attachResidualLineage", () => {
  it("clones plan.metadata before writing residual lineage", () => {
    const sharedMeta: Record<string, unknown> = { kind: "scope" };
    const plan: Record<string, unknown> = { metadata: sharedMeta };
    attachResidualLineage(plan, {
      predecessorPlanId: "github.issue.1",
      predecessorPath: "completed/a.xbrief.json",
      boundLeanCommentId: 9,
    });
    expect(sharedMeta["x-directive/residual-lineage"]).toBeUndefined();
    expect(plan.metadata).not.toBe(sharedMeta);
    expect(
      (plan.metadata as Record<string, unknown>)["x-directive/residual-lineage"],
    ).toMatchObject({
      predecessor_plan_id: "github.issue.1",
      bound_lean_comment_id: 9,
    });
  });
});

describe("owned lifecycle census", () => {
  it("finds owned completed and nonterminal residual", () => {
    const root = mkdtempSync(join(tmpdir(), "residual-own-"));
    temps.push(root);
    writeOwned(join(root, "completed"), 4544, { restId: 5453269518 });
    writeOwned(join(root, "proposed"), 4544, {
      restId: 5453269518,
      planId: "github.issue.residual.5453269518.lean.1",
      source: "github-residual",
    });
    expect(findOwnedCompletedHits(root, 4544)).toHaveLength(1);
    expect(findNonterminalResidualHits(root, 4544)).toHaveLength(1);
  });

  it("selects the most recently completed hit for residual lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "residual-lineage-"));
    temps.push(root);
    const completed = join(root, "completed");
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(completed, "2026-09-01-4544-original.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "github.issue.5453269518",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/4544",
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(completed, "2026-09-30-4544-residual.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "github.issue.residual.5453269518.lean.1",
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/4544",
          },
        },
      }),
      "utf8",
    );
    const hits = findOwnedCompletedHits(root, 4544);
    expect(hits).toHaveLength(2);
    const selected = selectMostRecentOwnedHit(hits);
    expect(selected?.planId).toBe("github.issue.residual.5453269518.lean.1");
    expect(selected?.relPath).toContain("2026-09-30-4544-residual");
    expect(selectMostRecentOwnedHit([])).toBeNull();
  });
});

describe("discoverable recovery naming", () => {
  it("names the same residual verb for duplicate and Stage A", () => {
    expect(residualRecoveryCommand(4544)).toBe("issue:ingest --residual -- 4544");
    expect(formatCompletedDuplicateWithResidualRecovery(4544, "completed/a.xbrief.json")).toContain(
      "issue:ingest --residual -- 4544",
    );
  });
});
