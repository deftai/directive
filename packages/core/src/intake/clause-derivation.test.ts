import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  AMBIGUITY_ATTESTATION_REMEDIATION,
  acceptanceFingerprint,
  applyClauseDerivationToPlan,
  applyClauseQualityForIngest,
  applyClauseQualityToPlan,
  CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION,
  collectTaskStatementFromPlan,
  emitAcceptanceStampFromPlan,
  evaluateAmbiguityAttestation,
  isMaterialAcceptanceChange,
  MISSING_AMBIGUITY_ATTESTATION_CAUSE,
  maybeEmitAcceptanceStampFromChange,
  needsClauseDerivation,
  prepareClauseStamp,
  stampedAmbiguityAttestationError,
  traceClauseProvenance,
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

  it("reads item.title when the item narrative is empty (#3826)", () => {
    const text = collectTaskStatementFromPlan({
      title: "Recut brief",
      narratives: { Overview: "Analysis prose only." },
      items: [
        { title: "A foreign-repository target is refused", narrative: {} },
        { title: "ignored", narrative: { Acceptance: "Declared narrative criterion" } },
        { status: "proposed" },
      ],
    });
    expect(text).toContain("A foreign-repository target is refused");
    expect(text).toContain("Declared narrative criterion");
    expect(text).not.toContain("ignored");
  });
});

/**
 * #3826: the declared `plan.items` surface outranks the statement, and a clause
 * derived from a title must still trace back to the statement so the #3398
 * provenance stamp holds.
 */
describe("applyClauseDerivationToPlan prefers the declared item surface (#3826)", () => {
  const THREAD = `## Summary

Analysis prose.

### Comment by @critic

- Evidence. packages/core/src/hooks/dispatcher.ts:1431-1434 swallowed the failure.
- Cost. The copy under .deft-scratch/worktrees/ is not the shipped path.
`;

  it("derives from item.title instead of scraping the thread, and traces provenance", () => {
    const plan: Record<string, unknown> = {
      title: "recut",
      narratives: { Overview: THREAD },
      items: [
        { title: "A foreign-repository target is refused rather than adopted", narrative: {} },
        { title: "CHANGELOG `[Unreleased]` entry", narrative: {} },
      ],
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(true);
    expect(result.clauses.map((c) => c.text)).toEqual([
      "A foreign-repository target is refused rather than adopted",
      "CHANGELOG `[Unreleased]` entry",
    ]);
    expect(result.clauses.every((c) => c.provenance === "statement")).toBe(true);
    expect(result.clauses.some((c) => c.artifact_path?.includes(".deft-scratch"))).toBe(false);
  });

  it("leaves an already-stamped brief untouched (#3826 item 7)", () => {
    const stamped = {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      clauses: [{ id: 1, text: "already stamped", artifact_path: null, ambiguous: false }],
    };
    const plan: Record<string, unknown> = {
      title: "landed",
      narratives: { Overview: THREAD },
      items: [{ title: "a declared criterion", narrative: {} }],
      acceptance: { ...stamped },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(false);
    expect(plan.acceptance).toEqual(stamped);
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
    applyClauseDerivationToPlan(plan, { projectRoot: root, emitStamp: false });
    expect(existsSync(summary)).toBe(false);
    emitAcceptanceStampFromPlan(root, plan);
    const line = JSON.parse(readFileSync(summary, "utf8").trim()) as {
      event: string;
      payload: {
        rung: string;
        none_stated: boolean;
        clause_count: number;
        provenance_counts: { statement: number; implementation: number };
        ambiguity_attested: boolean;
      };
    };
    expect(line.event).toBe("acceptance_stamp");
    expect(line.payload.rung).toBe("derived");
    expect(line.payload.none_stated).toBe(true);
    expect(line.payload.clause_count).toBe(3);
    expect(line.payload.provenance_counts).toEqual({ statement: 3, implementation: 0 });
    expect(line.payload.ambiguity_attested).toBe(true);
    emitAcceptanceStampFromPlan(root, { title: "no acceptance" });
    emitAcceptanceStampFromPlan(root, null);
    process.env.DEFT_SESSION_ID = "3360-test";
    emitAcceptanceStampFromPlan(root, plan);
    delete process.env.DEFT_SESSION_ID;
    process.env[ENV_RUN_SUMMARY_PATH] = "   ";
    emitAcceptanceStampFromPlan(root, plan);
    expect(readFileSync(summary, "utf8").trim().split(/\r?\n/).length).toBeGreaterThanOrEqual(1);
  });

  it("detects first write and material change for state-observed stamps (#3355)", () => {
    expect(acceptanceFingerprint(null)).toBeNull();
    expect(isMaterialAcceptanceChange(undefined, null)).toBe(false);
    const empty = { commands: [], none_stated: true, source_rung: "project_floor" };
    expect(isMaterialAcceptanceChange(undefined, empty)).toBe(true);
    expect(isMaterialAcceptanceChange(empty, empty)).toBe(false);
    expect(
      isMaterialAcceptanceChange(empty, {
        ...empty,
        clauses: [{ id: 1, text: "now derived", artifact_path: "a.ts" }],
      }),
    ).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "deft-3355-stamp-change-"));
    roots.push(root);
    const summary = join(root, "summary.jsonl");
    expect(maybeEmitAcceptanceStampFromChange(root, undefined, empty, {})).toBe(true);
    expect(existsSync(summary)).toBe(false);
    expect(
      maybeEmitAcceptanceStampFromChange(root, empty, empty, { [ENV_RUN_SUMMARY_PATH]: summary }),
    ).toBe(false);
    expect(
      maybeEmitAcceptanceStampFromChange(
        root,
        undefined,
        { ...empty, clauses: [{ id: 1, text: "x", artifact_path: null }] },
        { [ENV_RUN_SUMMARY_PATH]: summary },
      ),
    ).toBe(true);
    const line = JSON.parse(readFileSync(summary, "utf8").trim()) as { event: string };
    expect(line.event).toBe("acceptance_stamp");
  });
});

const SYMBOL_GREP_STATEMENT = `## Acceptance
- Initialize workers from the config
- Compose output from each worker result
- Propagate derived quantities to the parent
`;

const SYMBOL_GREP_CLAUSES = [
  {
    id: 1,
    text: 'class SessionGate source contains helper "bindExpiry"',
    artifact_path: "src/session-gate.ts",
    ambiguous: false,
  },
  {
    id: 2,
    text: 'class WorkerPool source contains helper "partitionByKey"',
    artifact_path: "src/worker-pool.ts",
    ambiguous: false,
  },
];

describe("statement traceability (#3398)", () => {
  it("marks derived trial clauses as statement provenance", () => {
    const plan: Record<string, unknown> = {
      title: "trial",
      narratives: { Overview: TRIAL_OVERVIEW },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(true);
    expect(result.clauses.every((clause) => clause.provenance === "statement")).toBe(true);
    const acc = plan.acceptance as {
      clauses: { provenance: string }[];
      ambiguity_attestation?: string;
    };
    expect(acc.clauses.every((clause) => clause.provenance === "statement")).toBe(true);
    expect(acc.ambiguity_attestation).toBeUndefined();
  });

  it("refuses a stamp whose every clause is implementation-provenance", () => {
    const prepared = prepareClauseStamp(SYMBOL_GREP_CLAUSES, SYMBOL_GREP_STATEMENT);
    expect(prepared.ok).toBe(false);
    expect(prepared.provenance_counts).toEqual({ statement: 0, implementation: 2 });
    expect(prepared.remediation).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    expect(prepared.remediation).toMatch(
      /derive clauses from the statement's testable constraints/,
    );
  });

  it("allows implementation clauses only as a supplement to statement-traceable ones", () => {
    const implClause = SYMBOL_GREP_CLAUSES[0];
    if (implClause === undefined) {
      throw new Error("expected first symbol-grep clause");
    }
    const mixed = [
      {
        id: 1,
        text: "Initialize workers from the config",
        artifact_path: null,
        ambiguous: false,
      },
      implClause,
    ];
    const prepared = prepareClauseStamp(mixed, SYMBOL_GREP_STATEMENT);
    expect(prepared.ok).toBe(true);
    expect(prepared.provenance_counts).toEqual({ statement: 1, implementation: 1 });
    expect(prepared.clauses[0]?.provenance).toBe("statement");
    expect(prepared.clauses[1]?.provenance).toBe("implementation");
  });

  it("classifies invented identifiers as implementation provenance", () => {
    expect(
      traceClauseProvenance(
        {
          id: 1,
          text: 'constructor uses library method "partitionByKey"',
          artifact_path: "src/pool.ts",
          ambiguous: false,
        },
        SYMBOL_GREP_STATEMENT,
      ),
    ).toBe("implementation");
    expect(
      traceClauseProvenance(
        {
          id: 2,
          text: "Compose output from each worker result",
          artifact_path: null,
          ambiguous: false,
        },
        SYMBOL_GREP_STATEMENT,
      ),
    ).toBe("statement");
  });

  it("rolls back an all-implementation quality pass so the stamp cannot persist", () => {
    const plan: Record<string, unknown> = {
      title: "impl only",
      narratives: { Overview: SYMBOL_GREP_STATEMENT },
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "derived",
        clauses: SYMBOL_GREP_CLAUSES,
      },
    };
    const result = applyClauseQualityToPlan(plan);
    expect(result.applied).toBe(false);
    expect(result.notice).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    const acc = plan.acceptance as { clauses?: unknown };
    expect(acc.clauses).toBeUndefined();
    expect(applyClauseQualityToPlan({ title: "none" }).applied).toBe(false);
    expect(
      applyClauseQualityToPlan({
        acceptance: { commands: [], none_stated: true, clauses: [] },
      }).applied,
    ).toBe(false);
  });

  it("records the remediation on ingest when an implementation-only stamp is stripped", () => {
    const plan: Record<string, unknown> = {
      title: "impl only",
      narratives: { Overview: SYMBOL_GREP_STATEMENT },
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "derived",
        clauses: SYMBOL_GREP_CLAUSES,
      },
    };
    const result = applyClauseQualityForIngest(plan);
    expect(result.applied).toBe(false);
    const acc = plan.acceptance as {
      clauses?: unknown;
      derived_reason?: string;
      quality_notice?: string;
    };
    expect(acc.clauses).toBeUndefined();
    expect(acc.derived_reason).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    expect(acc.quality_notice).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
  });

  it("keeps refused-stamp remediation on the plan when derivation quality rejects (#3398)", async () => {
    const clausesMod = await import("../verify-ac/clauses.js");
    const spy = vi
      .spyOn(clausesMod, "deriveAcceptanceClauses")
      .mockReturnValue(SYMBOL_GREP_CLAUSES);
    try {
      const plan: Record<string, unknown> = {
        title: "impl only",
        narratives: { Overview: SYMBOL_GREP_STATEMENT },
        acceptance: {
          commands: [],
          none_stated: true,
          source_rung: "derived",
        },
      };
      const result = applyClauseDerivationToPlan(plan);
      expect(result.applied).toBe(false);
      expect(result.notice).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
      const acc = plan.acceptance as {
        clauses?: unknown;
        quality_notice?: string;
        derived_reason?: string;
      };
      expect(acc.clauses).toBeUndefined();
      expect(acc.quality_notice).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
      expect(acc.derived_reason).toBe(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ambiguity attestation (#3398)", () => {
  it("records none_found when derivation yields no two-reading clause", () => {
    const plan: Record<string, unknown> = {
      narratives: {
        Overview: `## Acceptance sketch
- Persist the session token in packages/core/src/session/token.ts
- Cite CHANGELOG.md under Unreleased
`,
      },
    };
    const result = applyClauseDerivationToPlan(plan);
    expect(result.applied).toBe(true);
    expect(result.clauses.every((clause) => clause.ambiguous === false)).toBe(true);
    const acc = plan.acceptance as { ambiguity_attestation: string };
    expect(acc.ambiguity_attestation).toBe("none_found");
    expect(evaluateAmbiguityAttestation(acc).ok).toBe(true);
    expect(evaluateAmbiguityAttestation(acc).kind).toBe("none_found");
  });

  it("treats missing attestation and missing ambiguous readings as a config error", () => {
    const check = evaluateAmbiguityAttestation({
      commands: [],
      none_stated: true,
      clauses: [{ id: 1, text: "ship the product", artifact_path: null, ambiguous: false }],
    });
    expect(check.ok).toBe(false);
    expect(check.kind).toBe("missing");
    expect(check.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);
    expect(check.remediation).toBe(AMBIGUITY_ATTESTATION_REMEDIATION);
    expect(check.message).toMatch(/config error/);
    expect(check.message).toContain(AMBIGUITY_ATTESTATION_REMEDIATION);
    expect(evaluateAmbiguityAttestation(null).kind).toBe("missing");
    expect(evaluateAmbiguityAttestation(null).cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);
    expect(evaluateAmbiguityAttestation("nope").ok).toBe(false);
  });

  it("treats only clause stamps as attestation config errors", () => {
    expect(stampedAmbiguityAttestationError({ commands: [], none_stated: true })).toBeNull();
    expect(stampedAmbiguityAttestationError(null)).toBeNull();
    const missing = stampedAmbiguityAttestationError({
      commands: [],
      none_stated: true,
      clauses: [{ id: 1, text: "ship the product", artifact_path: null, ambiguous: false }],
    });
    expect(missing?.ok).toBe(false);
    expect(missing?.cause).toBe(MISSING_AMBIGUITY_ATTESTATION_CAUSE);
    expect(
      stampedAmbiguityAttestationError({
        commands: [],
        none_stated: true,
        ambiguity_attestation: "none_found",
        clauses: [{ id: 1, text: "ship the product", artifact_path: null, ambiguous: false }],
      }),
    ).toBeNull();
  });

  it("accepts an ambiguous clause with readings as the attestation", () => {
    const plan: Record<string, unknown> = {
      narratives: { Overview: TRIAL_OVERVIEW },
    };
    applyClauseDerivationToPlan(plan);
    const check = evaluateAmbiguityAttestation(plan.acceptance);
    expect(check.ok).toBe(true);
    expect(check.kind).toBe("ambiguous-clause");
  });
});
