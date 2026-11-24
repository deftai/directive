/**
 * #6644: the scope:complete walk leaves the clauses a grant stamped in this run
 * out of its counts. Each test names the Acceptance Criteria clause it covers.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAcceptanceDispositionGrants,
  mintAcceptanceDispositionTemplateGrant,
} from "../policy/acceptance-disposition-grant.js";
import { evaluateVerifyAcFromPlan } from "../product-first-done-gate/evaluate.js";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  evaluateScopeCompleteAcceptanceWalk,
  persistClauseKeyedPendingItems,
} from "./acceptance-evidence.js";

const greenRunner = () => ({ exitCode: 0, stdout: "", stderr: "" });
const NOW = new Date("2026-11-18T10:00:00Z");
const LATER = new Date("2026-11-18T11:00:00Z");

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function tempRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "grant-walk-"));
  bases.push(base);
  return base;
}

function clauses(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    text: `Prose clause number ${String(i + 1)} has no bound path.`,
    artifact_path: null,
    ambiguous: false,
  }));
}

function planWith(
  rows: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "github.issue.6644",
    title: "walk with granted clauses",
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: rows,
    },
    metadata: { swarm: { file_scope: ["src/a.ts"] } },
    items: [],
    ...extra,
  };
}

function walkOptions(projectRoot: string) {
  return {
    projectRoot,
    captureFromNarratives: false,
    hasSuiteFloor: true,
    bankOnPass: false,
    reuseMode: "never" as const,
    runner: greenRunner,
  };
}

const grant = (id: number, disposition = "not_applicable") => ({
  id,
  disposition,
  reason: `operator dropped clause ${String(id)}`,
});

describe("completion walk with a granted set (#6644)", () => {
  it("clause 14: every clause granted passes with no command, keeps the clauses and lists each as granted", () => {
    const root = tempRoot();
    const plan = planWith(clauses(3));
    const baseline = evaluateScopeCompleteAcceptanceWalk(planWith(clauses(3)), walkOptions(root));
    expect(baseline.ok).toBe(false);
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...walkOptions(root),
      grantedClauses: [grant(1), grant(2), grant(3, "waived")],
    });
    expect(walk.ok).toBe(true);
    expect((plan.acceptance as { clauses: unknown[] }).clauses).toHaveLength(3);
    for (const id of [1, 2, 3]) expect(walk.message).toContain(`[granted] clause ${String(id)}:`);
    expect(walk.message).toContain("3 granted");
    expect(walk.message).toContain("waived");
  });

  it("clause 15: two granted and one neither verified nor granted refuses, names that clause and both remedies", () => {
    const root = tempRoot();
    const walk = evaluateScopeCompleteAcceptanceWalk(planWith(clauses(3)), {
      ...walkOptions(root),
      grantedClauses: [grant(1), grant(2)],
    });
    expect(walk.ok).toBe(false);
    expect(walk.message).toContain("1 clause(s) neither verified nor granted");
    expect(walk.message).toContain("  - clause 3:");
    expect(walk.message).not.toContain("  - clause 1:");
    expect(walk.message).toContain("a verify command that covers the clause");
    expect(walk.message).toContain(
      "deft authz:grant -- --template acceptance-disposition --plan-ref github.issue.6644 --story-ids clause.3 --disposition <deferred|not_applicable|waived>",
    );
    expect(walk.message).not.toContain("disposition is not a substitute");
  });

  it("clause 16: a disposition written into the brief by hand does not leave the walk, and no grant means an empty granted set", () => {
    const base = tempRoot();
    const root = join(base, "main");
    mkdirSync(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    writeFileSync(join(root, "README.md"), "x\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    const hand = {
      id: "clause.1",
      title: "Prose clause number 1 has no bound path.",
      status: "pending",
      [ACCEPTANCE_DISPOSITION_KEY]: {
        disposition: "not_applicable",
        reason: "hand written",
        recorded_at: "2026-11-18T10:00:00Z",
        provenance: { kind: "operator-cli", actor: "operator", grantId: "grant-not-in-store" },
      },
    };
    const plan = planWith(clauses(1), { items: [hand] });
    // Readable store with no matching grant: nothing is applied and the granted set is empty.
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: root,
      plan,
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied).toMatchObject({ ok: true, grantedClauses: [] });
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...walkOptions(root),
      grantedClauses: applied.ok ? applied.grantedClauses : [],
    });
    expect(walk.ok).toBe(false);
    expect(walk.message).toContain("  - clause 1:");
  });

  it("clause 17: a grant whose clause text changed refuses and no clause enters the granted set", () => {
    const base = tempRoot();
    const main = join(base, "main");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: main });
    execFileSync("git", ["config", "user.name", "t"], { cwd: main });
    writeFileSync(join(main, "README.md"), "x\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: main });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: main });
    const plan = planWith(clauses(1), {
      items: [
        { id: "clause.1", title: "Prose clause number 1 has no bound path.", status: "pending" },
      ],
    });
    const dir = join(main, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-11-18-6644-story.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
      "utf8",
    );
    const minted = mintAcceptanceDispositionTemplateGrant({
      projectRoot: main,
      planRef: "github.issue.6644",
      storyIds: ["clause.1"],
      disposition: "waived",
      reason: "R",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.reason);
    const changed = planWith(
      [{ id: 1, text: "Prose clause one, reworded.", artifact_path: null, ambiguous: false }],
      { items: [{ id: "clause.1", title: "Prose clause one, reworded.", status: "pending" }] },
    );
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: main,
      plan: changed,
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied.ok).toBe(false);
    expect("grantedClauses" in applied).toBe(false);
  });

  it("clause 18: a granted clause whose token oracle fails does not count as failed", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const unrelated = 1;\n", "utf8");
    const rows = [
      {
        id: 1,
        text: 'The file contains "NEEDLE_TOKEN_THAT_IS_ABSENT" after the change.',
        artifact_path: "src/a.ts",
        ambiguous: false,
      },
    ];
    const refused = evaluateScopeCompleteAcceptanceWalk(planWith(rows), walkOptions(root));
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/1 failed/);
    const granted = evaluateScopeCompleteAcceptanceWalk(planWith(rows), {
      ...walkOptions(root),
      grantedClauses: [grant(1)],
    });
    expect(granted.ok).toBe(true);
    expect(granted.message).not.toMatch(/\[failed\]/);
    expect(granted.message).toContain("[granted] clause 1:");
  });

  it("a granted clause beside a verified clause passes without a command", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const PRESENT_TOKEN = 1;\n", "utf8");
    const rows = [
      {
        id: 1,
        text: 'The file contains "PRESENT_TOKEN" after the change.',
        artifact_path: "src/a.ts",
        ambiguous: false,
      },
      ...clauses(2)
        .slice(1)
        .map((row) => ({ ...row, id: 2 })),
    ];
    const walk = evaluateScopeCompleteAcceptanceWalk(planWith(rows), {
      ...walkOptions(root),
      grantedClauses: [grant(2)],
    });
    expect(walk.ok).toBe(true);
    expect(walk.message).toContain("1 verified");
    expect(walk.message).toContain("1 granted");
  });

  it("clause 22: verify:ac outside scope:complete is unchanged by the option being absent", () => {
    const root = tempRoot();
    const plan = planWith(clauses(2));
    const plain = evaluateVerifyAcFromPlan(plan, walkOptions(root));
    const empty = evaluateVerifyAcFromPlan(planWith(clauses(2)), {
      ...walkOptions(root),
      grantedClauses: [],
    });
    expect(empty.message).toBe(plain.message);
    expect(plain.clauseGranted).toBeUndefined();
    expect(plain.message).not.toContain("granted");
    expect(plain.message).toContain("0 verified, 2 unverifiable, 0 failed");
  });

  it("#7254: persist + apply puts deferred clause.1 into grantedClauses; failing token is left out", () => {
    const base = tempRoot();
    const main = join(base, "main");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: main });
    execFileSync("git", ["config", "user.name", "t"], { cwd: main });
    writeFileSync(join(main, "README.md"), "x\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: main });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: main });
    mkdirSync(join(main, "src"), { recursive: true });
    writeFileSync(join(main, "src", "a.ts"), "export const unrelated = 1;\n", "utf8");
    const rows = [
      {
        id: 1,
        text: 'The file contains "NEEDLE_TOKEN_THAT_IS_ABSENT" after the change.',
        artifact_path: "src/a.ts",
        ambiguous: false,
      },
    ];
    // Clauses-only brief (no plan items) — persist must create clause.1 first.
    const plan = planWith(rows, { id: "story.phase6-desk-research-store", items: [] });
    const dir = join(main, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-11-24-7254-story.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
      "utf8",
    );
    const minted = mintAcceptanceDispositionTemplateGrant({
      projectRoot: main,
      planRef: "story.phase6-desk-research-store",
      storyIds: ["clause.1"],
      disposition: "deferred",
      deferredTo: "#2497",
      reason: "tracking deftvisage#2497",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.reason);
    persistClauseKeyedPendingItems(plan);
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: main,
      plan,
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied).toMatchObject({
      ok: true,
      grantedClauses: [{ id: 1, disposition: "deferred" }],
    });
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...walkOptions(main),
      grantedClauses: applied.ok ? applied.grantedClauses : [],
    });
    expect(walk.ok).toBe(true);
    expect(walk.message).toContain("[granted] clause 1:");
    expect(walk.message).not.toMatch(/\[failed\]/);
  });

  it("#7254: an unreadable grant file under a valid clone refuses apply", () => {
    const base = tempRoot();
    const main = join(base, "main");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: main });
    execFileSync("git", ["config", "user.name", "t"], { cwd: main });
    writeFileSync(join(main, "README.md"), "x\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: main });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: main });
    const grantsDir = join(main, ".deft", "authz", "grants");
    mkdirSync(grantsDir, { recursive: true });
    mkdirSync(join(grantsDir, "broken-grant.json"));
    const applied = applyAcceptanceDispositionGrants({
      projectRoot: main,
      plan: planWith(clauses(1)),
      now: LATER,
      recordedAt: LATER.toISOString(),
    });
    expect(applied).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/grant unreadable/),
    });
  });
});
