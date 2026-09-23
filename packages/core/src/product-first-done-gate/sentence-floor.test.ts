/**
 * Behavior-coverage floor (#3550): a statement sentence that is neither a
 * clause nor an explicit confession fails the oracle walk. An existence
 * clause or a quoted-token clause that verifies does not cover it.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyClauseQualityForIngest } from "../intake/clause-derivation.js";
import { buildIssueVbrief } from "../intake/issue-ingest.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import { evaluateScopeCompleteAcceptanceWalk } from "../scope/acceptance-evidence.js";
import {
  evaluateStatementSentenceCoverage,
  extractStatementSentences,
  stampDerivedClausesOnAcceptance,
} from "../verify-ac/clauses.js";
import { stampAcceptanceFromLiteralCapture } from "./acceptance.js";
import { resolveAcceptanceGateProfile } from "./acceptance-resolver.js";
import { evaluateVerifyAcFromPath, evaluateVerifyAcFromPlan } from "./evaluate.js";

const EXISTENCE = {
  id: 1,
  text: "probe.txt exists",
  artifact_path: "probe.txt",
  ambiguous: false as const,
};

const QUOTED = {
  id: 2,
  text: 'probe.txt contains "marker-token-3550"',
  artifact_path: "probe.txt",
  ambiguous: false as const,
};

const BEHAVIORAL = [
  "Initialize workers from the config.",
  "Propagate derived quantities to the parent.",
];

const INTAKE_SENTENCE = "Initialize workers from the config.";
const PUNCTUATION_FREE = "Initialize workers";
const GENERATED_SENTENCES = [
  "Workers",
  INTAKE_SENTENCE,
  "probe.txt exists",
  'probe.txt contains "marker-token-3550"',
];

function intakeStatementBody(): string {
  return [
    INTAKE_SENTENCE,
    "",
    "## Acceptance Criteria",
    "- probe.txt exists",
    '- probe.txt contains "marker-token-3550"',
    "",
  ].join("\n");
}

function punctuationFreeBody(): string {
  return [
    "## Acceptance Criteria",
    "- probe.txt exists",
    '- probe.txt contains "marker-token-3550"',
    "",
  ].join("\n");
}

function generatedPunctuationFreeBrief(): Record<string, unknown> {
  const [vbrief] = buildIssueVbrief(
    {
      number: 3550,
      title: PUNCTUATION_FREE,
      body: punctuationFreeBody(),
      labels: [],
    },
    "proposed",
    "https://github.com/deftai/directive",
  );
  return vbrief.plan as Record<string, unknown>;
}

function generatedSentenceBrief(): Record<string, unknown> {
  const [vbrief] = buildIssueVbrief(
    {
      number: 3550,
      title: "Workers",
      body: intakeStatementBody(),
      labels: [],
    },
    "proposed",
    "https://github.com/deftai/directive",
  );
  return vbrief.plan as Record<string, unknown>;
}

function bindProbeClauses(plan: Record<string, unknown>): void {
  const acceptance = plan.acceptance as { clauses?: { artifact_path: string | null }[] };
  for (const clause of acceptance.clauses ?? []) {
    clause.artifact_path = "probe.txt";
  }
  const metadata = (plan.metadata as Record<string, unknown> | undefined) ?? {};
  const swarm = (metadata.swarm as Record<string, unknown> | undefined) ?? {};
  plan.metadata = { ...metadata, swarm: { ...swarm, file_scope: ["probe.txt"] } };
}

function floorAcceptance(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commands: [],
    none_stated: true,
    source_rung: "derived",
    ambiguity_attestation: "none_found",
    clauses: [EXISTENCE, QUOTED],
    sentences: BEHAVIORAL,
    ...extra,
  };
}

function floorPlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "3550-floor",
    title: "sentence floor",
    acceptance: floorAcceptance(),
    items: [],
    metadata: { swarm: { file_scope: ["probe.txt"] } },
    ...extra,
  };
}

function writeProbeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-3550-"));
  writeFileSync(join(root, "probe.txt"), "marker-token-3550\n", "utf8");
  return root;
}

function baseOptions(root: string): {
  projectRoot: string;
  captureFromNarratives: false;
  hasSuiteFloor: true;
  bankOnPass: false;
  reuseMode: "never";
} {
  return {
    projectRoot: root,
    captureFromNarratives: false,
    hasSuiteFloor: true,
    bankOnPass: false,
    reuseMode: "never",
  };
}

describe("statement sentence floor (#3550)", () => {
  it("does not treat an existence or quoted-token clause as covering an unmapped sentence", () => {
    const coverage = evaluateStatementSentenceCoverage(floorAcceptance(), [EXISTENCE, QUOTED]);
    expect(coverage.unmapped).toEqual(BEHAVIORAL);
    expect(coverage.behavioralClauseCount).toBe(0);
    expect(coverage.unmappedSentenceCount).toBe(2);
    expect(coverage.unmapped.join("\n")).not.toContain("probe.txt");

    const root = writeProbeRoot();
    const result = evaluateVerifyAcFromPlan(floorPlan(), baseOptions(root));
    expect(result.clauseOutcomes?.map((row) => row.outcome)).toEqual(["verified", "verified"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.resolution).toBe("fail");
    expect(result.unmappedSentenceCount).toBe(2);
    expect(result.behavioralClauseCount).toBe(0);
    expect(result.message).toContain("unmapped-sentence");
    expect(result.message).toContain("Initialize workers from the config.");
    expect(result.message).not.toContain("artifact missing");
    expect(result.message).not.toContain("was read");
  });

  it("does not select a file from a path-shaped unmapped sentence", () => {
    const root = writeProbeRoot();
    const sentence = "src/secret.txt exists";
    const result = evaluateVerifyAcFromPlan(
      floorPlan({
        acceptance: floorAcceptance({ sentences: [sentence] }),
      }),
      baseOptions(root),
    );
    expect(result.ok).toBe(false);
    expect(result.unmappedSentenceCount).toBe(1);
    expect(result.clauseOutcomes?.[0]?.outcome).toBe("verified");
    expect(result.message).toContain(sentence);
    expect(result.message).not.toContain("artifact missing");
    expect(result.message).not.toContain("was read");
  });

  it("fails closed on every reader that reaches the oracle walk", () => {
    const root = writeProbeRoot();
    const plan = floorPlan();
    const summary = join(root, "summary.jsonl");
    const env = { [ENV_RUN_SUMMARY_PATH]: summary };
    const shared = { ...baseOptions(root), env };

    const standalone = evaluateVerifyAcFromPlan(plan, {
      ...shared,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
    });
    expect(standalone.ok).toBe(false);
    expect(standalone.code).toBe(1);
    expect(standalone.cause).toBe("unmapped_statement_sentence");

    const quiet = evaluateVerifyAcFromPlan(plan, {
      ...shared,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
      quiet: true,
    });
    expect(quiet.ok).toBe(false);
    expect(quiet.message).toBe("");
    expect(quiet.unmappedSentenceCount).toBe(2);

    const path = join(root, "story.xbrief.json");
    writeFileSync(path, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2), "utf8");
    const fromPath = evaluateVerifyAcFromPath(path, {
      ...shared,
      ...resolveAcceptanceGateProfile("standalone"),
      reuseMode: "never",
    });
    expect(fromPath.ok).toBe(false);
    expect(fromPath.unmappedSentenceCount).toBe(2);

    const check = evaluateVerifyAcFromPlan(plan, {
      ...shared,
      ...resolveAcceptanceGateProfile("check"),
    });
    expect(check.ok).toBe(false);
    expect(check.code).toBe(1);

    const completeProfile = resolveAcceptanceGateProfile("complete");
    const complete = evaluateVerifyAcFromPlan(plan, {
      ...shared,
      ...completeProfile,
    });
    expect(complete.ok).toBe(false);
    expect(complete.unmappedSentenceCount).toBe(2);

    const completeWalk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...shared,
      ...completeProfile,
    });
    expect(completeWalk.ok).toBe(false);
    expect(completeWalk.predicate).toBe("unmapped-sentence");

    const events = readFileSync(summary, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            payload: {
              outcome?: string;
              unmapped_sentence_count?: number;
              behavioral_clause_count?: number;
            };
          },
      )
      .filter((row) => row.event === "acceptance");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((row) => row.payload.outcome === "fail")).toBe(true);
    expect(events.every((row) => row.payload.unmapped_sentence_count === 2)).toBe(true);
    expect(events.every((row) => row.payload.behavioral_clause_count === 0)).toBe(true);
  });

  it("passes when each sentence is a confession, and counts stay on that pass", () => {
    const root = writeProbeRoot();
    const result = evaluateVerifyAcFromPlan(
      floorPlan({
        acceptance: floorAcceptance({ confessions: BEHAVIORAL }),
      }),
      baseOptions(root),
    );
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("verified-pass");
    expect(result.unmappedSentenceCount).toBe(0);
    expect(result.behavioralClauseCount).toBe(0);
    expect(result.clauseOutcomes?.every((row) => row.outcome === "verified")).toBe(true);
  });

  it("passes when each sentence is itself a clause", () => {
    const root = writeProbeRoot();
    const clauses = [
      EXISTENCE,
      QUOTED,
      {
        id: 3,
        text: BEHAVIORAL[0],
        artifact_path: "probe.txt",
        ambiguous: false as const,
      },
      {
        id: 4,
        text: BEHAVIORAL[1],
        artifact_path: "probe.txt",
        ambiguous: false as const,
      },
    ];
    const result = evaluateVerifyAcFromPlan(
      floorPlan({ acceptance: floorAcceptance({ clauses }) }),
      baseOptions(root),
    );
    expect(result.ok).toBe(true);
    expect(result.unmappedSentenceCount).toBe(0);
    expect(result.behavioralClauseCount).toBe(2);
  });

  it("does not let one mapped sentence cover a different behavioral sentence", () => {
    const root = writeProbeRoot();
    const clauses = [
      EXISTENCE,
      QUOTED,
      {
        id: 3,
        text: BEHAVIORAL[0],
        artifact_path: "probe.txt",
        ambiguous: false as const,
      },
    ];
    const result = evaluateVerifyAcFromPlan(
      floorPlan({ acceptance: floorAcceptance({ clauses }) }),
      baseOptions(root),
    );
    expect(result.ok).toBe(false);
    expect(result.unmappedSentenceCount).toBe(1);
    expect(result.behavioralClauseCount).toBe(1);
    expect(result.message).toContain(BEHAVIORAL[1]);
    expect(result.message).not.toContain("artifact missing");
  });

  it("leaves a stamp with no sentence list on the existing verified pass", () => {
    const root = writeProbeRoot();
    const acceptance = floorAcceptance();
    delete acceptance.sentences;
    const result = evaluateVerifyAcFromPlan(floorPlan({ acceptance }), baseOptions(root));
    expect(result.ok).toBe(true);
    expect(result.resolution).toBe("verified-pass");
    expect(result.unmappedSentenceCount).toBeUndefined();
  });

  it("treats a missing or malformed list as not a sentence floor", () => {
    expect(evaluateStatementSentenceCoverage(null, []).hasSentenceList).toBe(false);
    expect(
      evaluateStatementSentenceCoverage({ sentences: "Initialize workers." }, [EXISTENCE])
        .hasSentenceList,
    ).toBe(false);
    const uncovered = evaluateStatementSentenceCoverage(
      { sentences: [BEHAVIORAL[0]], confessions: [1] },
      [EXISTENCE],
    );
    expect(uncovered.hasSentenceList).toBe(true);
    expect(uncovered.unmappedSentenceCount).toBe(1);
  });

  it("keeps a config error and still records the unmapped count", () => {
    const root = writeProbeRoot();
    const acceptance = floorAcceptance();
    delete acceptance.ambiguity_attestation;
    const result = evaluateVerifyAcFromPlan(floorPlan({ acceptance }), baseOptions(root));
    expect(result.resolution).toBe("config");
    expect(result.code).toBe(2);
    expect(result.unmappedSentenceCount).toBe(2);
    expect(result.cause).not.toBe("unmapped_statement_sentence");
  });

  it("names an unmapped sentence when a clause already failed", () => {
    const root = writeProbeRoot();
    const result = evaluateVerifyAcFromPlan(
      floorPlan({
        acceptance: floorAcceptance({
          clauses: [
            EXISTENCE,
            {
              id: 3,
              text: "missing.txt exists",
              artifact_path: "missing.txt",
              ambiguous: false as const,
            },
          ],
        }),
        metadata: { swarm: { file_scope: ["probe.txt", "missing.txt"] } },
      }),
      baseOptions(root),
    );
    expect(result.ok).toBe(false);
    expect(result.resolution).toBe("fail");
    expect(result.message).toContain(BEHAVIORAL[0]);
    expect(result.message).toContain("artifact missing");
  });

  it("fails a generated brief when a statement sentence is unmapped", () => {
    const plan = generatedSentenceBrief();
    const acceptance = plan.acceptance as {
      sentences?: string[];
      clauses: { text: string; artifact_path: string | null }[];
    };
    expect(acceptance.sentences).toEqual(GENERATED_SENTENCES);
    expect(acceptance.clauses.map((clause) => clause.text)).toEqual([
      "probe.txt exists",
      'probe.txt contains "marker-token-3550"',
    ]);
    expect(acceptance.clauses.every((clause) => clause.artifact_path === null)).toBe(true);

    bindProbeClauses(plan);
    const result = evaluateVerifyAcFromPlan(plan, baseOptions(writeProbeRoot()));
    expect(result.clauseOutcomes?.map((row) => row.outcome)).toEqual(["verified", "verified"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.resolution).toBe("fail");
    expect(result.cause).toBe("unmapped_statement_sentence");
    expect(result.unmappedSentenceCount).toBe(2);
    expect(result.message).toContain("Workers");
    expect(result.behavioralClauseCount).toBe(0);
    expect(result.message).toContain(INTAKE_SENTENCE);
    expect(result.message).not.toContain("artifact missing");
    expect(result.message).not.toContain("was read");
  });

  it("keeps a restamped sentence list and still fails the walk", () => {
    const generated = generatedSentenceBrief();
    const restamped = stampAcceptanceFromLiteralCapture({
      ...generated,
      narratives: {
        ...(generated.narratives as Record<string, unknown>),
        Overview: "A replacement sentence that must not replace the stored list.",
      },
    });
    const acceptance = restamped.acceptance as { sentences?: string[]; clauses?: unknown[] };
    expect(acceptance.sentences).toEqual(GENERATED_SENTENCES);

    const derived = stampDerivedClausesOnAcceptance(restamped, intakeStatementBody());
    applyClauseQualityForIngest(derived.plan);
    const clauses = (derived.plan.acceptance as { clauses: { text: string }[] }).clauses;
    expect(clauses.map((clause) => clause.text)).toEqual([
      "probe.txt exists",
      'probe.txt contains "marker-token-3550"',
    ]);
    bindProbeClauses(derived.plan);
    const result = evaluateVerifyAcFromPlan(derived.plan, baseOptions(writeProbeRoot()));
    expect(result.clauseOutcomes?.map((row) => row.outcome)).toEqual(["verified", "verified"]);
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("unmapped_statement_sentence");
    expect(result.unmappedSentenceCount).toBe(2);
    expect(result.behavioralClauseCount).toBe(0);
    expect(result.message).toContain(INTAKE_SENTENCE);
    expect(result.message).toContain("Workers");
    expect(result.message).not.toContain("A replacement sentence");
  });

  it("fails a generated brief whose statement has no terminal punctuation", () => {
    const plan = generatedPunctuationFreeBrief();
    const acceptance = plan.acceptance as {
      sentences?: string[];
      clauses: { text: string; artifact_path: string | null }[];
    };
    expect(acceptance.sentences).toEqual([
      PUNCTUATION_FREE,
      "probe.txt exists",
      'probe.txt contains "marker-token-3550"',
    ]);
    expect(acceptance.clauses.map((clause) => clause.text)).toEqual([
      "probe.txt exists",
      'probe.txt contains "marker-token-3550"',
    ]);
    expect(acceptance.clauses.every((clause) => clause.artifact_path === null)).toBe(true);

    const restamped = stampAcceptanceFromLiteralCapture({
      ...plan,
      narratives: {
        ...(plan.narratives as Record<string, unknown>),
        Overview: "A replacement sentence that must not replace the stored list.",
      },
    });
    expect((restamped.acceptance as { sentences?: string[] }).sentences).toEqual(
      acceptance.sentences,
    );

    const derived = stampDerivedClausesOnAcceptance(restamped, punctuationFreeBody());
    applyClauseQualityForIngest(derived.plan);
    const clauses = (derived.plan.acceptance as { clauses: { text: string }[] }).clauses;
    expect(clauses.map((clause) => clause.text)).toEqual([
      "probe.txt exists",
      'probe.txt contains "marker-token-3550"',
    ]);
    bindProbeClauses(derived.plan);
    const result = evaluateVerifyAcFromPlan(derived.plan, baseOptions(writeProbeRoot()));
    expect(result.clauseOutcomes?.map((row) => row.outcome)).toEqual(["verified", "verified"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.resolution).toBe("fail");
    expect(result.cause).toBe("unmapped_statement_sentence");
    expect(result.unmappedSentenceCount).toBe(1);
    expect(result.behavioralClauseCount).toBe(0);
    expect(result.message).toContain(PUNCTUATION_FREE);
    expect(result.message).not.toContain("artifact missing");
    expect(result.message).not.toContain("was read");
    expect(result.message).not.toContain("A replacement sentence");
  });

  it("splits statement text without gluing tokens or reading a fence", () => {
    expect(extractStatementSentences("Ship probe.txt now. Fence stays out.")).toEqual([
      "Ship probe.txt now.",
      "Fence stays out.",
    ]);
    expect(
      extractStatementSentences(
        "```\nthis.should.not.split as a sentence.\n```\nKeep this sentence.",
      ),
    ).toEqual(["Keep this sentence."]);
    expect(extractStatementSentences("- Initialize workers from the config.")).toEqual([
      INTAKE_SENTENCE,
    ]);
    expect(extractStatementSentences("## Ship the workers.")).toEqual(["Ship the workers."]);
    expect(extractStatementSentences("Done!!! Next stays. Next stays.")).toEqual([
      "Done!!!",
      "Next stays.",
    ]);
    expect(extractStatementSentences("1.")).toEqual([]);
    expect(extractStatementSentences("Initialize workers")).toEqual([PUNCTUATION_FREE]);
    expect(extractStatementSentences("Ship it. Initialize workers")).toEqual([
      "Ship it.",
      PUNCTUATION_FREE,
    ]);
    expect(extractStatementSentences("Ship probe.txt now")).toEqual(["Ship probe.txt now"]);
    expect(
      extractStatementSentences(
        '## Acceptance Criteria\n- probe.txt exists\n- probe.txt contains "marker-token-3550"',
      ),
    ).toEqual(["probe.txt exists", 'probe.txt contains "marker-token-3550"']);
  });

  it("preserves confessions on restamp and reads an item acceptance sentence", () => {
    const stamped = stampAcceptanceFromLiteralCapture({
      items: [{ narrative: { Acceptance: "Propagate derived quantities to the parent." } }],
    });
    expect((stamped.acceptance as { sentences?: string[] }).sentences).toEqual([
      "Propagate derived quantities to the parent.",
    ]);
    const restamped = stampAcceptanceFromLiteralCapture({
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "project_floor",
        sentences: undefined,
        confessions: ["Propagate derived quantities to the parent."],
      },
      narratives: { Overview: INTAKE_SENTENCE },
    });
    const acceptance = restamped.acceptance as { sentences?: string[]; confessions?: string[] };
    expect(acceptance.sentences).toEqual([INTAKE_SENTENCE]);
    expect(acceptance.confessions).toEqual(["Propagate derived quantities to the parent."]);
  });

  it("rejects a sentence list that is not an array of non-empty strings", () => {
    const root = writeProbeRoot();
    const result = evaluateVerifyAcFromPlan(
      floorPlan({
        acceptance: floorAcceptance({ sentences: ["Initialize workers.", ""] }),
      }),
      baseOptions(root),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.resolution).toBe("config");
    expect(result.message).toContain(
      "plan.acceptance.sentences must be an array of non-empty strings",
    );
  });
});
