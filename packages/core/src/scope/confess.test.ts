/**
 * #6644: scope:confess writes a non-criterion sentence to acceptance.confessions.
 * Each test names the Acceptance Criteria clause it covers.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateStatementSentenceCoverage, readAcceptanceClauses } from "../verify-ac/clauses.js";
import { formatBriefJson } from "./brief-io.js";
import { CONFESS_ACTION, CONFESS_VERB, confessOnBrief, confessSentencesOnPlan } from "./confess.js";
import { lifecycleMain } from "./main.js";
import { minimalScopeBrief } from "./scope-test-fixtures.test.js";

const CLAUSE_ONE = "Clause one is an admitted criterion.";
const NOISE_A = "Noise sentence A is prose, not a criterion.";
const NOISE_B = "Noise sentence B is prose, not a criterion.";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function acceptance(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commands: [],
    none_stated: true,
    source_rung: "derived",
    sentences: [CLAUSE_ONE, NOISE_A, NOISE_B],
    admitted_source_sentences: [CLAUSE_ONE],
    clauses: [{ id: 1, text: CLAUSE_ONE, artifact_path: null, ambiguous: false }],
    ...extra,
  };
}

function plan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "github.issue.6644",
    title: "T",
    status: "running",
    items: [],
    acceptance: acceptance(extra),
  };
}

function briefOnDisk(body: Record<string, unknown> = plan()): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "confess-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const file = join(root, "xbrief", "active", "story.xbrief.json");
  writeFileSync(file, formatBriefJson(minimalScopeBrief(body)), "utf8");
  return { root, file };
}

function readPlan(file: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(file, "utf8")) as { plan: Record<string, unknown> }).plan;
}

function unmapped(body: Record<string, unknown>): readonly string[] {
  const acc = body.acceptance as Record<string, unknown>;
  return evaluateStatementSentenceCoverage(acc, readAcceptanceClauses(acc)).unmapped;
}

describe("scope:confess (#6644)", () => {
  it("exports the verb tokens", () => {
    expect(CONFESS_ACTION).toBe("confess");
    expect(CONFESS_VERB).toBe("scope:confess");
  });

  it("clause 19: --sentence appends an unmapped, non-admitted sentence and changes nothing else", () => {
    const { root, file } = briefOnDisk();
    const before = readPlan(file);
    expect(unmapped(before)).toEqual([NOISE_A, NOISE_B]);
    const result = confessOnBrief(file, { projectRoot: root, sentences: [NOISE_A] });
    expect(result).toMatchObject({ ok: true, confessed: [NOISE_A] });
    expect(result.message).toContain(NOISE_A);
    const after = readPlan(file);
    const { confessions, ...afterAcceptance } = after.acceptance as Record<string, unknown>;
    expect(confessions).toEqual([NOISE_A]);
    expect(afterAcceptance).toEqual(before.acceptance);
    expect({ ...after, acceptance: undefined }).toEqual({ ...before, acceptance: undefined });
    expect(unmapped(after)).toEqual([NOISE_B]);
  });

  it("clause 19: a repeated sentence is not written twice and an unknown sentence refuses with no write", () => {
    const { root, file } = briefOnDisk();
    expect(confessOnBrief(file, { projectRoot: root, sentences: [NOISE_A] }).ok).toBe(true);
    const again = confessOnBrief(file, { projectRoot: root, sentences: [NOISE_A] });
    expect(again).toMatchObject({ ok: true, confessed: [] });
    expect((readPlan(file).acceptance as { confessions: string[] }).confessions).toEqual([NOISE_A]);
    const text = readFileSync(file, "utf8");
    const refused = confessOnBrief(file, {
      projectRoot: root,
      sentences: [NOISE_B, "Not in the list."],
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("not in plan.acceptance.sentences: Not in the list.");
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("clause 20: an admitted-source identity refuses, writes nothing and names the grant command for its clause", () => {
    const { root, file } = briefOnDisk();
    const text = readFileSync(file, "utf8");
    const refused = confessOnBrief(file, { projectRoot: root, sentences: [NOISE_A, CLAUSE_ONE] });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("admitted-source identity");
    expect(refused.message).toContain(
      "deft authz:grant -- --template acceptance-disposition --plan-ref github.issue.6644 --story-ids clause.1 --disposition not_applicable",
    );
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("clause 20: a pin removed while its digest remains refuses", () => {
    const body = plan({ admitted_source_digest: "a".repeat(64) });
    delete (body.acceptance as Record<string, unknown>).admitted_source_sentences;
    const result = confessSentencesOnPlan(body, { sentences: [NOISE_A] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("admitted-source pin is missing");
  });

  it("clause 21: --all-unmapped confesses exactly the unmapped non-admitted sentences and prints each", () => {
    const body = plan({
      sentences: [CLAUSE_ONE, NOISE_A, NOISE_B, "Removed admitted criterion."],
      admitted_source_sentences: [CLAUSE_ONE, "Removed admitted criterion."],
    });
    const result = confessSentencesOnPlan(body, { allUnmapped: true });
    expect(result.ok).toBe(true);
    expect(result.confessed).toEqual([NOISE_A, NOISE_B]);
    expect(result.message).toContain(`wrote: ${NOISE_A}`);
    expect(result.message).toContain(`wrote: ${NOISE_B}`);
    expect(result.message).toContain("left unmapped (admitted-source identity");
    expect(unmapped(body)).toEqual(["Removed admitted criterion."]);
  });

  it("refuses when nothing is named, when sentences are absent and for clause text outside the pin", () => {
    expect(confessSentencesOnPlan(plan(), {}).message).toContain("--all-unmapped");
    const noList = plan();
    delete (noList.acceptance as Record<string, unknown>).sentences;
    expect(confessSentencesOnPlan(noList, { allUnmapped: true }).ok).toBe(false);
    const unpinned = plan({ admitted_source_sentences: undefined });
    const clauseText = confessSentencesOnPlan(unpinned, { sentences: [CLAUSE_ONE] });
    expect(clauseText.ok).toBe(false);
    expect(clauseText.message).toContain("clause 1 text");
  });

  it("reports an unreadable brief and an empty --all-unmapped as unchanged", () => {
    const { root, file } = briefOnDisk(plan({ sentences: [CLAUSE_ONE] }));
    expect(confessOnBrief(file, { projectRoot: root, allUnmapped: true })).toMatchObject({
      ok: true,
      confessed: [],
    });
    expect(confessOnBrief(join(root, "missing.xbrief.json"), { sentences: [NOISE_A] }).ok).toBe(
      false,
    );
  });

  it("lifecycleMain routes scope:confess with --sentence and --all-unmapped, and rejects a bare call", () => {
    const { root, file } = briefOnDisk();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(lifecycleMain(["confess", file, "--project-root", root])).toBe(2);
    expect(lifecycleMain(["confess", file, "--sentence"])).toBe(2);
    expect(lifecycleMain(["confess", file, "--clause", "1", "--sentence", NOISE_A])).toBe(2);
    expect(lifecycleMain(["promote", file, "--sentence", NOISE_A])).toBe(2);
    expect(lifecycleMain(["confess", file, "--project-root", root, "--sentence", NOISE_A])).toBe(0);
    expect(lifecycleMain(["confess", file, "--project-root", root, `--sentence=${NOISE_B}`])).toBe(
      0,
    );
    expect(out.join("")).toContain(NOISE_A);
    expect((readPlan(file).acceptance as { confessions: string[] }).confessions).toEqual([
      NOISE_A,
      NOISE_B,
    ]);
    expect(lifecycleMain(["confess", file, "--project-root", root, "--all-unmapped"])).toBe(0);
    expect(lifecycleMain(["confess", file, "--project-root", root, "--sentence", CLAUSE_ONE])).toBe(
      1,
    );
  });
});
