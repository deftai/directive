import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import {
  claimPlanSequenceApproval,
  formatPlanSequenceApprovalCommand,
  isPlanSequenceApprovalGrant,
  isPlanSequenceApprovalTemplateName,
  mintPlanSequenceApprovalGrant,
  type PlanSequenceApprovalBinding,
  parsePlanSequenceApprovalTarget,
  planSequenceApprovalRequired,
  resolvePlanSequenceApprovalRepo,
  resolvePlanSequenceApprovalStore,
} from "./approval-grant.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Git repo with a GitHub-shaped origin so the repository binds by inference. */
function repoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ps-approval-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
  return root;
}

function writePolicy(root: string, requireBoundPrePrPush: boolean | null): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  const policy = requireBoundPrePrPush === null ? {} : { requireBoundPrePrPush };
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ plan: { title: "pd", status: "running", "x-directive/policy": policy } }),
  );
}

const NOW = new Date("2026-11-16T03:00:00.000Z");

const insertBinding: PlanSequenceApprovalBinding = {
  repo: "acme/app",
  sequenceId: "seq-6205",
  generation: 4,
  action: { kind: "insert", entryKind: "issue", entryId: "900", issue: 900, position: 1 },
};

function mintInsert(root: string, overrides: Partial<{ position: number; target: string }> = {}) {
  return mintPlanSequenceApprovalGrant({
    projectRoot: root,
    target: overrides.target ?? "insert:issue:900",
    sequenceId: "seq-6205",
    generation: 4,
    position: overrides.position ?? 1,
    issue: 900,
    now: NOW,
  });
}

function storedGrant(root: string, id: string): HumanOriginGrant {
  return JSON.parse(
    readFileSync(join(root, ".deft", "authz", "grants", `${id}.json`), "utf8"),
  ) as HumanOriginGrant;
}

describe("planSequenceApprovalRequired (#6205 rulings 6906744687 / 6908156182)", () => {
  it("needs approval for insert, replace and clear only when requireBoundPrePrPush is true", () => {
    const root = repoRoot();
    for (const action of ["insert", "replace", "clear"] as const) {
      expect(planSequenceApprovalRequired(action, root)).toBe(false);
    }
    writePolicy(root, false);
    for (const action of ["insert", "replace", "clear"] as const) {
      expect(planSequenceApprovalRequired(action, root)).toBe(false);
    }
    writePolicy(root, true);
    for (const action of ["insert", "replace", "clear"] as const) {
      expect(planSequenceApprovalRequired(action, root)).toBe(true);
    }
  });
});

describe("plan-sequence-approval target and binding helpers", () => {
  it("parses insert, replace and clear targets and refuses malformed ones", () => {
    expect(parsePlanSequenceApprovalTarget("insert:Issue:900")).toEqual({
      ok: true,
      kind: "insert",
      entryKind: "issue",
      entryId: "900",
    });
    expect(parsePlanSequenceApprovalTarget(" REPLACE ")).toEqual({ ok: true, kind: "replace" });
    expect(parsePlanSequenceApprovalTarget("clear")).toEqual({ ok: true, kind: "clear" });
    for (const bad of ["insert:epic:1", "insert:issue:", "advance", ""]) {
      expect(parsePlanSequenceApprovalTarget(bad).ok).toBe(false);
    }
    expect(isPlanSequenceApprovalTemplateName(" Plan-Sequence-Approval ")).toBe(true);
    expect(isPlanSequenceApprovalTemplateName("finish-loop")).toBe(false);
  });

  it("formats the operator mint command for every action", () => {
    expect(formatPlanSequenceApprovalCommand(insertBinding)).toBe(
      "deft authz:grant -- --template plan-sequence-approval --target insert:issue:900 " +
        "--plan-ref seq-6205 --generation 4 --position 1 --issue-ids 900 --repo acme/app --confirm",
    );
    expect(
      formatPlanSequenceApprovalCommand({ ...insertBinding, action: { kind: "clear" } }),
    ).toContain("--target clear --plan-ref seq-6205 --generation 4 --repo acme/app");
  });

  it("resolves the repository from --repo or origin and refuses when neither exists", () => {
    const root = repoRoot();
    expect(resolvePlanSequenceApprovalRepo(null, root)).toEqual({ ok: true, repo: "acme/app" });
    expect(resolvePlanSequenceApprovalRepo("Other/Repo", root)).toEqual({
      ok: true,
      repo: "other/repo",
    });
    const bare = mkdtempSync(join(tmpdir(), "ps-approval-bare-"));
    roots.push(bare);
    const prev = process.env.DEFT_TRIAGE_REPO;
    delete process.env.DEFT_TRIAGE_REPO;
    try {
      expect(resolvePlanSequenceApprovalRepo(null, bare).ok).toBe(false);
      expect(resolvePlanSequenceApprovalStore(bare).ok).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DEFT_TRIAGE_REPO = prev;
    }
  });
});

describe("mintPlanSequenceApprovalGrant (#6205 clause.11)", () => {
  it("mints a single-use human-origin grant that binds repo, sequence, generation, entry and position", () => {
    const root = repoRoot();
    const minted = mintInsert(root);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const grant = storedGrant(root, minted.grant.id);
    expect(grant.origin.kind).toBe("operator-cli");
    expect(grant.origin.eventRef).toBe("template:plan-sequence-approval");
    expect(grant.semantics.singleUse).toBe(true);
    expect(grant.semantics.expiresAt).toBe("2026-11-17T03:00:00Z");
    expect(grant.scope.repo).toBe("acme/app");
    expect(grant.scope.planRef).toBe("seq-6205");
    expect(grant.scope.issueIds).toEqual([900]);
    expect(grant.scope.surfaces).toEqual(
      expect.arrayContaining([
        "plan-sequence-approval:action:insert",
        "plan-sequence-approval:entry:issue:900",
        "plan-sequence-approval:generation:4",
        "plan-sequence-approval:issue:900",
        "plan-sequence-approval:position:1",
        "plan-sequence-approval:sequence:seq-6205",
      ]),
    );
    expect(isPlanSequenceApprovalGrant(grant)).toBe(true);
  });

  it("returns failures for a bad target, plan ref, generation, position, issue or expiry", () => {
    const root = repoRoot();
    const base = { projectRoot: root, sequenceId: "seq", generation: 0, position: 0 };
    const cases = [
      { ...base, target: "bogus" },
      { ...base, target: "clear", sequenceId: " " },
      { ...base, target: "clear", generation: null },
      { ...base, target: "clear", generation: -1 },
      { ...base, target: "insert:issue:1", position: null },
      { ...base, target: "insert:issue:1", issue: 0 },
      { ...base, target: "clear", expiresAt: "not-a-date" },
    ];
    for (const input of cases) {
      const result = mintPlanSequenceApprovalGrant(input);
      expect(result.ok).toBe(false);
    }
    const noRepo = mkdtempSync(join(tmpdir(), "ps-approval-norepo-"));
    roots.push(noRepo);
    git(noRepo, ["init", "-q"]);
    const prev = process.env.DEFT_TRIAGE_REPO;
    delete process.env.DEFT_TRIAGE_REPO;
    try {
      expect(
        mintPlanSequenceApprovalGrant({ ...base, projectRoot: noRepo, target: "clear" }).ok,
      ).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DEFT_TRIAGE_REPO = prev;
    }
  });
});

describe("claimPlanSequenceApproval (#6205 clause.11)", () => {
  it("spends a matching grant once and refuses its reuse", () => {
    const root = repoRoot();
    const minted = mintInsert(root);
    if (!minted.ok) throw new Error(minted.reason);
    let writes = 0;
    const write = () => {
      writes += 1;
      return { ok: true as const };
    };
    const first = claimPlanSequenceApproval({
      projectRoot: root,
      binding: insertBinding,
      write,
      now: NOW,
    });
    expect(first).toEqual({ ok: true, grantId: minted.grant.id });
    expect(storedGrant(root, minted.grant.id).semantics.usedAt).not.toBeNull();
    const reused = claimPlanSequenceApproval({
      projectRoot: root,
      binding: insertBinding,
      write,
      now: NOW,
    });
    expect(reused.ok).toBe(false);
    if (!reused.ok) {
      expect(reused.reason).toMatch(/already used/);
      expect(reused.reason).toContain("deft authz:grant -- --template plan-sequence-approval");
    }
    expect(writes).toBe(1);
  });

  it("refuses a grant for another entry, position, generation or action", () => {
    const root = repoRoot();
    expect(mintInsert(root, { position: 2 }).ok).toBe(true);
    expect(mintInsert(root, { target: "insert:issue:901" }).ok).toBe(true);
    const write = () => ({ ok: true as const });
    const variants: PlanSequenceApprovalBinding[] = [
      insertBinding,
      { ...insertBinding, generation: 5 },
      { ...insertBinding, repo: "acme/other" },
      { ...insertBinding, action: { kind: "replace" } },
    ];
    for (const binding of variants) {
      const claimed = claimPlanSequenceApproval({ projectRoot: root, binding, write, now: NOW });
      expect(claimed.ok).toBe(false);
      if (!claimed.ok) expect(claimed.reason).toMatch(/no plan-sequence-approval grant binds/);
    }
  });

  it("rolls the spend back when the plan write fails, so the grant stays usable", () => {
    const root = repoRoot();
    const minted = mintInsert(root);
    if (!minted.ok) throw new Error(minted.reason);
    const failed = claimPlanSequenceApproval({
      projectRoot: root,
      binding: insertBinding,
      write: () => ({ ok: false, reason: "disk full" }),
      now: NOW,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toMatch(/write failed \(grant .* not spent\): disk full/);
    expect(storedGrant(root, minted.grant.id).semantics.usedAt).toBeNull();
    const retried = claimPlanSequenceApproval({
      projectRoot: root,
      binding: insertBinding,
      write: (grantId) => {
        expect(grantId).toBe(minted.grant.id);
        return { ok: true };
      },
      now: NOW,
    });
    expect(retried.ok).toBe(true);
  });

  it("refuses an expired grant and a store that cannot be resolved", () => {
    const root = repoRoot();
    expect(mintInsert(root).ok).toBe(true);
    const later = new Date("2026-11-18T00:00:00.000Z");
    const expired = claimPlanSequenceApproval({
      projectRoot: root,
      binding: insertBinding,
      write: () => ({ ok: true }),
      now: later,
    });
    expect(!expired.ok && expired.reason).toMatch(/expired/);
    const bare = mkdtempSync(join(tmpdir(), "ps-approval-nostore-"));
    roots.push(bare);
    const noStore = claimPlanSequenceApproval({
      projectRoot: bare,
      binding: insertBinding,
      write: () => ({ ok: true }),
    });
    expect(!noStore.ok && noStore.reason).toMatch(/cannot be resolved/);
  });

  it("matches a replace or clear grant on sequence, generation and repository only", () => {
    const root = repoRoot();
    const minted = mintPlanSequenceApprovalGrant({
      projectRoot: root,
      target: "clear",
      sequenceId: "seq-6205",
      generation: 4,
      repo: "acme/app",
      now: NOW,
    });
    expect(minted.ok).toBe(true);
    const binding: PlanSequenceApprovalBinding = { ...insertBinding, action: { kind: "clear" } };
    expect(
      claimPlanSequenceApproval({
        projectRoot: root,
        binding,
        write: () => ({ ok: true }),
        now: NOW,
      }).ok,
    ).toBe(true);
  });
});
