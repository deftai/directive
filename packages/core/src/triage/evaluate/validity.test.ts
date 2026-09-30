import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLiveResidualOverlay,
  evaluateValidity,
  joinValidityWithGithub,
  withNeedsReScopeRecovery,
} from "./validity.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeOwnedBrief(
  dir: string,
  issue: number,
  opts: { planId?: string; source?: string; refs?: number[] } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const planId = opts.planId ?? `github.issue.${issue}`;
  const source = opts.source ?? "github-rest-id";
  const refs = opts.refs ?? [issue];
  writeFileSync(
    join(dir, `2026-09-30-${issue}-sample.xbrief.json`),
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
            github_issue_id: issue,
            origin: `deftai/directive#${issue}`,
            id: planId,
          },
        },
        references: refs.map((n) => ({
          uri: `https://github.com/deftai/directive/issues/${n}`,
          type: "x-xbrief/github-issue",
        })),
      },
    }),
    "utf8",
  );
}

describe("evaluateValidity", () => {
  it("is still-open on an empty detached tree", () => {
    const root = mkdtempSync(join(tmpdir(), "val-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    expect(evaluateValidity(root, 1).state).toBe("still-open");
  });

  it("joins closed GitHub onto still-open as likely-shipped", () => {
    const joined = joinValidityWithGithub(
      {
        state: "still-open",
        evidence: "none",
        worktreePath: "/wt",
        sessionStartReadOnly: true,
      },
      "closed",
    );
    expect(joined.state).toBe("likely-shipped");
  });

  it("reads ADR mention as partial", () => {
    const root = mkdtempSync(join(tmpdir(), "val-adr-"));
    temps.push(root);
    const dir = join(root, "docs", "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ADR-005.md"), "See #99 for the gate.", "utf8");
    expect(evaluateValidity(root, 99).state).toBe("partial");
  });

  it("does not needs-re-scope from a cross-mentioned completed brief (#5177 ownership)", () => {
    const root = mkdtempSync(join(tmpdir(), "val-xref-"));
    temps.push(root);
    writeOwnedBrief(join(root, "xbrief", "completed"), 3736, { refs: [3736, 3739] });
    expect(evaluateValidity(root, 3739).state).toBe("still-open");
    expect(evaluateValidity(root, 3736).state).toBe("likely-shipped");
  });

  it("finds Origin-owned completed briefs even when references omit the issue", () => {
    const root = mkdtempSync(join(tmpdir(), "val-noref-"));
    temps.push(root);
    writeOwnedBrief(join(root, "xbrief", "completed"), 4544, { refs: [] });
    expect(evaluateValidity(root, 4544).state).toBe("likely-shipped");
    expect(evaluateValidity(root, 4544, "deftai/directive").state).toBe("likely-shipped");
    expect(evaluateValidity(root, 4544, "other/repo").state).toBe("still-open");
  });

  it("retires sticky needs-re-scope when a live residual exists", () => {
    const root = mkdtempSync(join(tmpdir(), "val-residual-"));
    temps.push(root);
    writeOwnedBrief(join(root, "xbrief", "completed"), 4544);
    writeOwnedBrief(join(root, "xbrief", "proposed"), 4544, {
      planId: "github.issue.residual.4544",
      source: "github-residual",
    });
    const validity = evaluateValidity(root, 4544);
    expect(validity.state).toBe("residual-in-flight");
    expect(validity.evidence).toContain("live residual");
    expect(validity.evidence).toContain("issue:ingest --residual -- 4544");
  });

  it("names recovery on needs-re-scope and retires it via live overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "val-overlay-"));
    temps.push(root);
    writeOwnedBrief(join(root, "xbrief", "completed"), 4544);
    const needs = withNeedsReScopeRecovery(
      joinValidityWithGithub(evaluateValidity(root, 4544), "open"),
      4544,
    );
    expect(needs.state).toBe("needs-re-scope");
    expect(needs.evidence).toContain("issue:ingest --residual -- 4544");
    writeOwnedBrief(join(root, "xbrief", "proposed"), 4544, {
      planId: "github.issue.residual.4544",
      source: "github-residual",
    });
    const overlaid = applyLiveResidualOverlay(needs, root, 4544);
    expect(overlaid.state).toBe("residual-in-flight");
  });
});
