import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  applyClauseDerivationToPlan,
  collectTaskStatementFromPlan,
  emitAcceptanceStampFromPlan,
  needsClauseDerivation,
} from "./clause-derivation.js";

/** Multi-clause contract with one two-reading clause (modeled on the #3351 trial). */
const TRIAL_OVERVIEW = `## Acceptance sketch
- Persist the session token in packages/core/src/session/token.ts
- Write the verifier to packages/core/src/verify-ac/clauses.ts or packages/core/src/verify-ac/evaluate.ts
- Cite CHANGELOG.md under Unreleased
`;

describe("needsClauseDerivation (#3360)", () => {
  it("is true when acceptance is absent, empty-with-none_stated, or command-only", () => {
    expect(needsClauseDerivation(undefined)).toBe(true);
    expect(needsClauseDerivation(null)).toBe(true);
    expect(needsClauseDerivation("prose dump")).toBe(true);
    expect(needsClauseDerivation({ commands: [], none_stated: true })).toBe(true);
    expect(
      needsClauseDerivation({
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
      }),
    ).toBe(true);
  });

  it("is false when clauses already exist", () => {
    expect(
      needsClauseDerivation({
        commands: [],
        none_stated: true,
        source_rung: "derived",
        clauses: [{ id: 1, text: "already stamped", artifact_path: null, ambiguous: false }],
      }),
    ).toBe(false);
  });
});

describe("collectTaskStatementFromPlan (#3360)", () => {
  it("joins title, preferred narratives, and item Acceptance", () => {
    const text = collectTaskStatementFromPlan({
      title: "Hand-authored trial",
      narratives: { Overview: TRIAL_OVERVIEW, Extra: "also this" },
      items: [{ narrative: { Acceptance: "Item clause binds docs/notes.md" } }],
    });
    expect(text).toContain("Hand-authored trial");
    expect(text).toContain("packages/core/src/session/token.ts");
    expect(text).toContain("also this");
    expect(text).toContain("docs/notes.md");
  });
});

describe("applyClauseDerivationToPlan (#3360)", () => {
  const roots: string[] = [];
  afterEach(() => {
    const prev = process.env[ENV_RUN_SUMMARY_PATH];
    if (prev === undefined) {
      delete process.env[ENV_RUN_SUMMARY_PATH];
    } else {
      process.env[ENV_RUN_SUMMARY_PATH] = prev;
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives N clauses and flags the two-reading trial clause", () => {
    const plan: Record<string, unknown> = {
      title: "trial",
      narratives: { Overview: TRIAL_OVERVIEW },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(true);
    expect(result.clauses).toHaveLength(3);
    expect(result.clauses[0]?.ambiguous).toBe(false);
    expect(result.clauses[0]?.artifact_path).toBe("packages/core/src/session/token.ts");
    expect(result.clauses[1]?.ambiguous).toBe(true);
    expect(result.clauses[1]?.readings).toHaveLength(2);
    expect(result.clauses[1]?.chosen_reading).toBe(0);
    expect(result.clauses[1]?.artifact_path).toBe("packages/core/src/verify-ac/clauses.ts");
    expect(result.notice).toMatch(/flagged-ambiguous: 1/);
    expect(result.notice).toMatch(/chosen_reading=0/);
    expect(result.notice).not.toMatch(/\?/);
    const acc = plan.acceptance as {
      none_stated: boolean;
      source_rung: string;
      clauses: unknown[];
    };
    expect(acc.none_stated).toBe(true);
    expect(acc.source_rung).toBe("derived");
    expect(acc.clauses).toHaveLength(3);
  });

  it("keeps stated commands when stamping clauses onto command-only acceptance", () => {
    const plan: Record<string, unknown> = {
      narratives: { Overview: TRIAL_OVERVIEW },
      acceptance: {
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
      },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(true);
    const acc = plan.acceptance as {
      commands: { command: string }[];
      none_stated: boolean;
      source_rung: string;
      clauses: unknown[];
    };
    expect(acc.commands).toEqual([{ command: "pnpm test" }]);
    expect(acc.none_stated).toBe(false);
    expect(acc.source_rung).toBe("stated");
    expect(acc.clauses).toHaveLength(3);
  });

  it("does not overwrite existing clauses", () => {
    const existing = [{ id: 1, text: "keep me", artifact_path: null, ambiguous: false }];
    const plan: Record<string, unknown> = {
      narratives: { Overview: TRIAL_OVERVIEW },
      acceptance: { commands: [], none_stated: true, source_rung: "derived", clauses: existing },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(false);
    expect(plan.acceptance).toEqual({
      commands: [],
      none_stated: true,
      source_rung: "derived",
      clauses: existing,
    });
  });

  it("no-ops when no extractable clauses exist", () => {
    const plan: Record<string, unknown> = {
      title: "plain",
      narratives: { Overview: "narrative without a list or path" },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(false);
    expect(plan.acceptance).toBeUndefined();
  });

  it("defaults source_rung to stated when command-only acceptance omits it", () => {
    const plan: Record<string, unknown> = {
      narratives: { Overview: TRIAL_OVERVIEW },
      acceptance: { commands: [{ command: "pnpm test" }], none_stated: false },
    };
    applyClauseDerivationToPlan(plan);
    expect((plan.acceptance as { source_rung: string }).source_rung).toBe("stated");
  });

  it("skips non-record items and non-string extra narratives when collecting text", () => {
    const text = collectTaskStatementFromPlan({
      narratives: { Overview: TRIAL_OVERVIEW, Extra: 12, OverviewDup: "" },
      items: [null, "x", { narrative: "nope" }, { narrative: { Acceptance: 3 } }],
    });
    expect(text).toContain("packages/core/src/session/token.ts");
    expect(text).not.toContain("nope");
  });

  it("emits acceptance_stamp when a run-summary dest is set", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3360-stamp-"));
    roots.push(root);
    const summary = join(root, "summary.jsonl");
    process.env[ENV_RUN_SUMMARY_PATH] = summary;
    const plan: Record<string, unknown> = {
      narratives: { Overview: TRIAL_OVERVIEW },
    };
    applyClauseDerivationToPlan(plan, { projectRoot: root });
    const line = JSON.parse(readFileSync(summary, "utf8").trim()) as {
      event: string;
      payload: { rung: string; none_stated: boolean; clause_count: number };
    };
    expect(line.event).toBe("acceptance_stamp");
    expect(line.payload.rung).toBe("derived");
    expect(line.payload.none_stated).toBe(true);
    expect(line.payload.clause_count).toBe(3);
    emitAcceptanceStampFromPlan(root, { title: "no acceptance" });
    emitAcceptanceStampFromPlan(root, null);
    process.env.DEFT_SESSION_ID = "3360-test";
    emitAcceptanceStampFromPlan(root, plan);
    delete process.env.DEFT_SESSION_ID;
    process.env[ENV_RUN_SUMMARY_PATH] = "   ";
    emitAcceptanceStampFromPlan(root, plan);
    expect(readFileSync(summary, "utf8").trim().split(/\r?\n/).length).toBeGreaterThanOrEqual(1);
  });
});
