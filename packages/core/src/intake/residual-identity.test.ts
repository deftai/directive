import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  briefOwnsIssue,
  findNonterminalResidualHits,
  findOwnedCompletedHits,
  formatCompletedDuplicateWithResidualRecovery,
  isResidualPlanId,
  mintResidualIssuePlanId,
  residualRecoveryCommand,
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
});

describe("discoverable recovery naming", () => {
  it("names the same residual verb for duplicate and Stage A", () => {
    expect(residualRecoveryCommand(4544)).toBe("issue:ingest --residual -- 4544");
    expect(formatCompletedDuplicateWithResidualRecovery(4544, "completed/a.xbrief.json")).toContain(
      "issue:ingest --residual -- 4544",
    );
  });
});
