import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  type ChangeSetRecord,
  changeSetRecordsToPrFiles,
  discoverLandsWithProductMoves,
  evaluateInPrCompletionInputs,
  evaluateLandsWithProductAdmission,
  IN_PR_POST_MERGE_PATH,
  isInPrProductionPath,
  listBranchChangedPaths,
  parseNameStatus,
  pinNamesLandsWithProductMove,
  planFileScope,
  resolveBranchMergeBase,
  resolveInPrBaseRef,
  soleLandsWithProductMove,
} from "./lands-with-product.js";
import { LANDS_WITH_PRODUCT } from "./lifecycle-write.js";

const ISSUE_URI = "https://github.com/acme/app/issues/77";
const BRIEF = "2026-11-16-77-story.xbrief.json";
const ACTIVE = `xbrief/active/${BRIEF}`;
const COMPLETED = `xbrief/completed/${BRIEF}`;

function storyPlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "story 77",
    id: "github.issue.77",
    status: "running",
    references: [{ uri: ISSUE_URI, type: "x-xbrief/github-issue" }],
    acceptance: {
      clauses: [{ id: 1, text: "Given x, then y returns z.", artifact_path: "src/app.ts" }],
    },
    items: [{ id: "clause.1", title: "Given x, then y returns z.", status: "pending" }],
    metadata: { swarm: { file_scope: ["src/app.ts", "tests/app.test.ts"] } },
    ...extra,
  };
}

function landedPlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = storyPlan();
  return {
    ...base,
    status: "completed",
    metadata: {
      ...(base.metadata as Record<string, unknown>),
      lifecycleWrite: {
        action: "complete",
        writtenAt: "2026-11-16T00:00:00Z",
        completionDisposition: LANDS_WITH_PRODUCT,
      },
    },
    ...extra,
  };
}

describe("evaluateInPrCompletionInputs (#6277 Bound 1)", () => {
  it("admits a story whose inputs carry no merge dependence", () => {
    expect(evaluateInPrCompletionInputs(storyPlan(), { changedPaths: ["src/app.ts"] })).toEqual({
      ok: true,
    });
  });

  it.each([
    [
      "an item that declares the merge requirement",
      storyPlan({
        items: [{ id: "clause.1", title: "t", status: "pending", "x-directive/requires": "merge" }],
      }),
      /clause\.1 declares the merge requirement/,
    ],
    [
      "pre-stamped merge evidence",
      storyPlan({
        items: [
          {
            id: "clause.1",
            title: "t",
            status: "pending",
            "x-directive/evidence": { kind: "merge", pointer: "abc1234" },
          },
        ],
      }),
      /stores acceptance evidence of kind merge/,
    ],
    [
      "bare merge evidence on a nested sub-item",
      storyPlan({
        items: [
          {
            id: "clause.1",
            title: "t",
            status: "pending",
            subItems: [{ title: "nested", evidence: { kind: "MERGE" } }],
          },
        ],
      }),
      /item 2 stores acceptance evidence of kind merge/,
    ],
    [
      "stored completion provenance",
      storyPlan({
        metadata: {
          swarm: { file_scope: ["src/app.ts"] },
          completionProvenance: { disposition: "delivered" },
        },
      }),
      /already stores completionProvenance/,
    ],
    ["clause-less acceptance", storyPlan({ acceptance: { commands: [] } }), /has no clauses/],
    ["no GitHub issue reference", storyPlan({ references: [] }), /no GitHub issue reference/],
  ])("refuses %s and names the post-merge path and #6303", (_label, plan, reason) => {
    const result = evaluateInPrCompletionInputs(plan, { changedPaths: ["src/app.ts"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(reason);
    expect(result.message).toContain(IN_PR_POST_MERGE_PATH);
    expect(result.message).toContain("#6303");
  });

  it("refuses a branch with no production file inside file_scope", () => {
    for (const changed of [
      [],
      ["docs/other.md"],
      ["tests/app.test.ts"],
      [ACTIVE, "CHANGELOG.md"],
    ]) {
      const result = evaluateInPrCompletionInputs(storyPlan(), { changedPaths: changed });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/no production file inside/);
    }
    const unreadable = evaluateInPrCompletionInputs(storyPlan(), { changedPaths: null });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.message).toMatch(/could not be read/);
  });
});

describe("evaluateLandsWithProductAdmission (#6277 Bound 3)", () => {
  const rename: ChangeSetRecord[] = [
    { status: "R", src: ACTIVE, dest: COMPLETED },
    { status: "M", src: "src/app.ts", dest: "src/app.ts" },
  ];
  const deleteAdd: ChangeSetRecord[] = [
    { status: "D", src: ACTIVE, dest: ACTIVE },
    { status: "A", src: COMPLETED, dest: COMPLETED },
    { status: "M", src: "src/app.ts", dest: "src/app.ts" },
  ];

  it("admits a rename and a delete plus add with the closing keyword, without a sole-mark scan", () => {
    for (const records of [rename, deleteAdd]) {
      expect(
        evaluateLandsWithProductAdmission({
          completedRel: COMPLETED,
          plan: landedPlan(),
          records,
          prBody: "Closes #77\n",
        }),
      ).toEqual({ ok: true, notes: [] });
    }
  });

  it("refuses a missing keyword, a part line and a completed add that leaves active/ in place", () => {
    const noKeyword = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: rename,
      prBody: "Refs #77\n\ndeft-story: 77\n",
    });
    expect(noKeyword).toEqual({
      ok: false,
      reasons: ["the PR body has no closing keyword for #77"],
    });
    const part = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: rename,
      prBody: "Closes #77\n\ndeft-story-part: 77\n",
    });
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reasons.join(" ")).toMatch(/deft-story-part: 77/);
    const leftInPlace = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: [
        { status: "A", src: COMPLETED, dest: COMPLETED },
        { status: "M", src: "src/app.ts", dest: "src/app.ts" },
      ],
      prBody: "Closes #77\n",
    });
    expect(leftInPlace.ok).toBe(false);
    if (!leftInPlace.ok)
      expect(leftInPlace.reasons).toContain(`the change set does not remove ${ACTIVE}`);
  });

  it("refuses production files outside file_scope and a lifecycle-only move", () => {
    const outside = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: [...rename, { status: "A", src: "src/other.ts", dest: "src/other.ts" }],
      prBody: "Closes #77\n",
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok)
      expect(outside.reasons.join(" ")).toMatch(/outside the brief's file_scope: src\/other\.ts/);
    const lifecycleOnly = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: [{ status: "R", src: ACTIVE, dest: COMPLETED }],
      prBody: "Closes #77\n",
    });
    expect(lifecycleOnly.ok).toBe(false);
    if (!lifecycleOnly.ok) expect(lifecycleOnly.reasons.join(" ")).toMatch(/beside a code change/);
  });

  it("refuses stored provenance, a missing issue reference and a non-completed path", () => {
    const withProv = landedPlan();
    (withProv.metadata as Record<string, unknown>).completionProvenance = {
      disposition: "delivered",
    };
    const prov = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: withProv,
      records: rename,
      prBody: "Closes #77\n",
    });
    expect(prov.ok).toBe(false);
    const noIssue = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan({ references: [] }),
      records: rename,
      prBody: "Closes #77\n",
    });
    expect(noIssue.ok).toBe(false);
    const wrongPath = evaluateLandsWithProductAdmission({
      completedRel: ACTIVE,
      plan: landedPlan(),
      records: rename,
    });
    expect(wrongPath).toEqual({ ok: false, reasons: [`${ACTIVE} is not a completed/ brief path`] });
  });

  it("notes the keyword condition outside a PR context", () => {
    const result = evaluateLandsWithProductAdmission({
      completedRel: COMPLETED,
      plan: landedPlan(),
      records: rename,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes[0]).toMatch(/not evaluated outside a pull_request context/);
  });
});

describe("pinNamesLandsWithProductMove (#6277)", () => {
  const move = { activeRel: ACTIVE, completedRel: COMPLETED, plan: landedPlan(), planId: "p" };
  it("follows a pin to the moved brief by either path or basename, and nothing else", () => {
    const root = resolve(tmpdir(), "proj");
    expect(pinNamesLandsWithProductMove(root, ACTIVE, move)).toBe(true);
    expect(pinNamesLandsWithProductMove(root, COMPLETED.replace(/\//g, "\\"), move)).toBe(true);
    expect(pinNamesLandsWithProductMove(root, join(root, ...COMPLETED.split("/")), move)).toBe(
      true,
    );
    expect(pinNamesLandsWithProductMove(root, BRIEF, move)).toBe(true);
    expect(pinNamesLandsWithProductMove(root, "xbrief/active/other.xbrief.json", move)).toBe(false);
    expect(pinNamesLandsWithProductMove(root, "  ", move)).toBe(false);
  });
});

describe("change-set helpers", () => {
  it("parses name-status and maps records to PR file entries", () => {
    const records = parseNameStatus(
      `R100\t${ACTIVE}\t${COMPLETED}\nM\tsrc/app.ts\nD\told.ts\nA\tnew.ts\n?\tignored\n`,
    );
    expect(records).toEqual([
      { status: "R", src: ACTIVE, dest: COMPLETED },
      { status: "M", src: "src/app.ts", dest: "src/app.ts" },
      { status: "D", src: "old.ts", dest: "old.ts" },
      { status: "A", src: "new.ts", dest: "new.ts" },
    ]);
    expect(changeSetRecordsToPrFiles(records)).toEqual([
      { status: "renamed", filename: COMPLETED, previousFilename: ACTIVE },
      { status: "modified", filename: "src/app.ts" },
      { status: "removed", filename: "old.ts" },
      { status: "added", filename: "new.ts" },
    ]);
  });

  it("classifies production paths and reads file_scope", () => {
    expect(isInPrProductionPath("src/app.ts")).toBe(true);
    expect(isInPrProductionPath("xbrief/plan.xbrief.json")).toBe(false);
    expect(isInPrProductionPath("CHANGELOG.md")).toBe(false);
    expect(isInPrProductionPath("")).toBe(false);
    expect(planFileScope(storyPlan())).toEqual(["src/app.ts", "tests/app.test.ts"]);
    expect(planFileScope({ metadata: {} })).toEqual([]);
  });
});

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.DEFT_BASE_REF;
  delete env.GITHUB_BASE_REF;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(cwd));
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.test",
    },
  });
}

function writeJson(root: string, rel: string, plan: Record<string, unknown>): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2), "utf8");
}

describe("discoverLandsWithProductMoves (#6277 Bound 6)", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function repoWithBase(): string {
    const dir = mkdtempSync(join(tmpdir(), "lwp-moves-"));
    git(dir, ["init", "-q", "-b", "main"]);
    writeJson(dir, ACTIVE, storyPlan());
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["checkout", "-q", "-b", "story"]);
    mkdirSync(join(dir, "xbrief", "completed"), { recursive: true });
    return dir;
  }

  it("finds a renamed lands-with-product brief and lists the branch's changed paths", () => {
    root = repoWithBase();
    git(root, ["mv", ACTIVE, COMPLETED]);
    writeJson(root, COMPLETED, landedPlan());
    writeFileSync(join(root, "src", "app.ts"), "export const a = 2;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "story"]);
    writeFileSync(join(root, "src", "untracked.ts"), "x\n", "utf8");
    const moves = discoverLandsWithProductMoves(root, { baseRef: "origin/main" });
    expect(moves.map((m) => [m.activeRel, m.completedRel, m.planId])).toEqual([
      [ACTIVE, COMPLETED, "github.issue.77"],
    ]);
    expect(soleLandsWithProductMove(root, { baseRef: "origin/main" })?.completedRel).toBe(
      COMPLETED,
    );
    const changed = listBranchChangedPaths(root, { baseRef: "origin/main" }) ?? [];
    expect(changed).toEqual(expect.arrayContaining(["src/app.ts", "src/untracked.ts", COMPLETED]));
    expect(
      resolveInPrBaseRef(root, (cwd, args) => {
        try {
          return { code: 0, stdout: git(cwd, [...args]), stderr: "" };
        } catch {
          return { code: 1, stdout: "", stderr: "" };
        }
      }),
    ).toBe("origin/main");
  });

  it("ignores a completed brief without the disposition and a deleted active brief with no twin", () => {
    root = repoWithBase();
    git(root, ["mv", ACTIVE, COMPLETED]);
    writeJson(root, COMPLETED, {
      ...landedPlan(),
      metadata: { lifecycleWrite: { action: "complete", writtenAt: "x" } },
    });
    expect(discoverLandsWithProductMoves(root, { baseRef: "origin/main" })).toEqual([]);
    git(root, ["rm", "-q", "-f", COMPLETED]);
    expect(discoverLandsWithProductMoves(root, { baseRef: "origin/main" })).toEqual([]);
  });

  it("returns empty or null when git cannot answer", () => {
    const failing: GitRunner = () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(discoverLandsWithProductMoves("/nowhere", { runGit: failing })).toEqual([]);
    expect(listBranchChangedPaths("/nowhere", { runGit: failing })).toBeNull();
    expect(resolveBranchMergeBase("/nowhere", { baseRef: "", runGit: failing })).toBeNull();
    expect(soleLandsWithProductMove("/nowhere", { runGit: failing })).toBeNull();
  });
});
