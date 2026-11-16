import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate as evaluateOrphanActive } from "../orphan-active/evaluate.js";
import type {
  FetchPrChangedFilesFn,
  MergedPrListNode,
  MergeTimeForge,
} from "../scope/delivery-evidence.js";
import { LANDS_WITH_PRODUCT } from "../scope/lifecycle-write.js";
import { evaluateCompletedTracked } from "./completed-tracked-on-delivery.js";
import {
  defaultResolveLandingPullRequests,
  findLandingCommit,
  LANDS_WITH_PRODUCT_RECOVERY,
  type LandsWithProductProofInput,
  landsWithProductBriefsFromBlobs,
  listTipLandsWithProductBriefs,
  type ProveLandsWithProductFn,
  proveLandsWithProductCompletion,
} from "./lands-with-product-proof.js";

const REPO = "acme/app";
const NAME = "2026-11-16-77-story.xbrief.json";
const ACTIVE = `xbrief/active/${NAME}`;
const COMPLETED = `xbrief/completed/${NAME}`;

function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
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
  }).trim();
}

function plan(landed: boolean): Record<string, unknown> {
  return {
    title: "story 77",
    id: "github.issue.77",
    status: landed ? "completed" : "running",
    references: [{ uri: `https://github.com/${REPO}/issues/77`, type: "x-xbrief/github-issue" }],
    items: [{ title: "Given x, then y returns z.", status: landed ? "completed" : "pending" }],
    metadata: {
      swarm: { file_scope: ["src/app.ts"] },
      ...(landed
        ? {
            lifecycleWrite: {
              action: "complete",
              writtenAt: "2026-11-16T00:00:00Z",
              completionDisposition: LANDS_WITH_PRODUCT,
            },
          }
        : {}),
    },
  };
}

function writeBrief(root: string, rel: string, landed: boolean): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: plan(landed) }),
    "utf8",
  );
}

/** main with the active brief; a story branch that moves it beside a code change; landed on main. */
function landedRepo(mode: "squash" | "merge" | "delete-add"): { root: string; landing: string } {
  const root = mkdtempSync(join(tmpdir(), "lwp-proof-"));
  git(root, ["init", "-q", "-b", "main"]);
  writeBrief(root, ACTIVE, false);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["checkout", "-q", "-b", "story"]);
  mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
  if (mode === "delete-add") {
    git(root, ["rm", "-q", ACTIVE]);
  } else {
    git(root, ["mv", ACTIVE, COMPLETED]);
  }
  writeBrief(root, COMPLETED, true);
  writeFileSync(join(root, "src", "app.ts"), "export const a = 2;\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "story"]);
  git(root, ["checkout", "-q", "main"]);
  if (mode === "merge") {
    git(root, ["merge", "-q", "--no-ff", "-m", "Merge PR #42", "story"]);
  } else {
    git(root, ["merge", "-q", "--squash", "story"]);
    git(root, ["commit", "-q", "-m", "story (#42)"]);
  }
  return { root, landing: git(root, ["rev-parse", "HEAD"]) };
}

function staticForge(merged: readonly MergedPrListNode[] = []): MergeTimeForge {
  const page = <T>(nodes: readonly T[]) => ({
    ok: true as const,
    nodes,
    hasNextPage: false,
    endCursor: null,
  });
  return {
    listMergedPrsPage: () => page(merged),
    fetchBodyRevisionsPage: () => page([]),
    fetchConnectionEventsPage: () => page([]),
    fetchPrFilesPage: () => page([{ status: "modified", filename: "src/app.ts" }]),
    probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
    nowMs: () => 0,
  };
}

function prover(opts: {
  readonly landing: string;
  readonly body: string;
  readonly prs?: number[] | null;
  readonly mergeSha?: string;
  readonly files?: FetchPrChangedFilesFn;
  readonly merged?: readonly MergedPrListNode[];
}): ProveLandsWithProductFn {
  return (input: LandsWithProductProofInput) =>
    proveLandsWithProductCompletion({
      ...input,
      resolveLandingPullRequests: () => (opts.prs === undefined ? [42] : opts.prs),
      fetchPrPayload: (n) => ({
        number: n,
        merged_at: "2026-11-16T01:00:00Z",
        merge_commit_sha: opts.mergeSha ?? opts.landing,
        body: opts.body,
        base: { ref: "main" },
        head: { sha: "f".repeat(40) },
      }),
      mergeTimeForge: staticForge(opts.merged),
      fetchPrChangedFiles: opts.files ?? (() => [{ status: "modified", filename: "src/app.ts" }]),
    });
}

function closeProofs(root: string, prove: ProveLandsWithProductFn) {
  const tracked = evaluateCompletedTracked(root, {
    tip: "main",
    issue: 77,
    repo: REPO,
    resolveIssueState: () => "closed",
    proveLandsWithProduct: prove,
  });
  const orphan = evaluateOrphanActive(root, {
    issue: 77,
    repo: REPO,
    tip: "main",
    runGh: () => ({ returncode: 1, stdout: "", stderr: "" }),
    proveLandsWithProduct: prove,
  });
  return { tracked, orphan };
}

describe("lands-with-product close proof (#6277 Bound 4 / 5 / 8)", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it.each([
    "squash",
    "merge",
    "delete-add",
  ] as const)("an in-PR completion landed by %s passes both close proofs with no second PR", (mode) => {
    const repo = landedRepo(mode);
    root = repo.root;
    expect(findLandingCommit(root, "main", COMPLETED)).toBe(repo.landing);
    const prove = prover({ landing: repo.landing, body: "Closes #77\n" });
    const proof = prove({ projectRoot: root, tip: "main", briefRel: COMPLETED, plan: plan(true) });
    expect(proof).toMatchObject({ ok: true, prNumber: 42, identityBasis: "merge-time-keyword" });
    const { tracked, orphan } = closeProofs(root, prove);
    expect(tracked.code, tracked.message).toBe(0);
    expect(orphan.code, orphan.message).toBe(0);
    expect(listTipLandsWithProductBriefs(root, "main").map((b) => b.rel)).toEqual([COMPLETED]);
  });

  it("passes when earlier merged PRs carry the same sole mark (keyword basis, no mark scan)", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const earlier: MergedPrListNode = {
      number: 40,
      mergedAt: "2026-11-15T00:00:00Z",
      body: "deft-story: 77\n",
    } as unknown as MergedPrListNode;
    const prove = prover({
      landing: repo.landing,
      body: "Closes #77\n",
      merged: [earlier, earlier],
    });
    expect(closeProofs(root, prove).tracked.code).toBe(0);
  });

  it("passes on the diff basis when the body lost its keyword after CI", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const prove = prover({
      landing: repo.landing,
      body: "Refs #77\n",
      files: () => [
        { status: "renamed", filename: COMPLETED, previousFilename: ACTIVE },
        { status: "modified", filename: "src/app.ts" },
      ],
    });
    const proof = prove({ projectRoot: root, tip: "main", briefRel: COMPLETED, plan: plan(true) });
    expect(proof).toMatchObject({ ok: true, identityBasis: "brief-in-pr-diff" });
  });

  it("fails a direct-commit landing, and both close proofs name the brief and the recovery", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const prove = prover({ landing: repo.landing, body: "Closes #77\n", prs: [] });
    const { tracked, orphan } = closeProofs(root, prove);
    expect(tracked.code).toBe(1);
    expect(tracked.message).toContain(COMPLETED);
    expect(tracked.message).toMatch(/not the merge commit of any pull request \(direct commit\)/);
    expect(tracked.message).toContain(LANDS_WITH_PRODUCT_RECOVERY);
    expect(tracked.landsWithProductFailures).toHaveLength(1);
    expect(orphan.code).toBe(1);
    expect(orphan.orphans).toEqual([
      expect.objectContaining({ path: COMPLETED, kind: "lands-with-product-unproven" }),
    ]);
    expect(orphan.message).toMatch(/failed the close proof \(#6277\)/);
  });

  it("fails a failed join, a lookup failure, several PRs and a missing landing commit", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const base = { projectRoot: root, tip: "main", briefRel: COMPLETED, plan: plan(true) };
    const mismatch = prover({
      landing: repo.landing,
      body: "Closes #77\n",
      mergeSha: "a".repeat(40),
    })(base);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.message).toMatch(/PR #42: Delivery identity join failed/);
    const lookup = prover({ landing: repo.landing, body: "", prs: null })(base);
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) expect(lookup.message).toMatch(/could not resolve the pull request/);
    const several = prover({ landing: repo.landing, body: "", prs: [42, 43] })(base);
    expect(several.ok).toBe(false);
    if (!several.ok) expect(several.message).toMatch(/several pull requests \(42, 43\)/);
    const missing = prover({ landing: repo.landing, body: "" })({
      ...base,
      briefRel: "xbrief/completed/none.xbrief.json",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/no commit on main adds/);
    const noIssue = proveLandsWithProductCompletion({
      ...base,
      plan: { ...plan(true), references: [] },
    });
    expect(noIssue.ok).toBe(false);
  });

  it("skips proofs on a repo-wide sweep and offline", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const failing = prover({ landing: repo.landing, body: "", prs: [] });
    const sweep = evaluateCompletedTracked(root, {
      tip: "main",
      repo: REPO,
      resolveIssueState: () => "closed",
      proveLandsWithProduct: failing,
    });
    expect(sweep.landsWithProductFailures ?? []).toEqual([]);
    const offline = evaluateCompletedTracked(root, {
      tip: "main",
      issue: 77,
      repo: REPO,
      skipGh: true,
      resolveIssueState: () => "closed",
    });
    expect(offline.code).toBe(1);
    expect(offline.message).toMatch(/needs a live forge read/);
  });
});

describe("lands-with-product proof edges", () => {
  const failGit = () => ({ code: 1, stdout: "", stderr: "boom" });
  let root = "";
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("returns null or empty when git cannot answer or answers junk", () => {
    expect(findLandingCommit("/x", "main", COMPLETED, failGit)).toBeNull();
    expect(
      findLandingCommit("/x", "main", COMPLETED, () => ({
        code: 0,
        stdout: "not-a-sha\n",
        stderr: "",
      })),
    ).toBeNull();
    expect(listTipLandsWithProductBriefs("/x", "main", failGit)).toEqual([]);
    expect(
      listTipLandsWithProductBriefs("/x", "main", () => ({
        code: 0,
        stdout: "README.md\n",
        stderr: "",
      })),
    ).toEqual([]);
  });

  it("keeps only parseable lands-with-product briefs under completed/", () => {
    const landed = JSON.stringify({ plan: plan(true) });
    const bodies = new Map<string, string | null>([
      [COMPLETED, landed],
      [ACTIVE, landed],
      ["xbrief/completed/null.xbrief.json", null],
      ["xbrief/completed/bad.xbrief.json", "{"],
      ["xbrief/completed/array.xbrief.json", JSON.stringify({ plan: [] })],
      ["xbrief/completed/plain.xbrief.json", JSON.stringify({ plan: plan(false) })],
    ]);
    expect(landsWithProductBriefsFromBlobs([...bodies.keys()], bodies).map((b) => b.rel)).toEqual([
      COMPLETED,
    ]);
  });

  it("uses the forge-backed defaults when no seam is injected", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const seen: string[] = [];
    const proof = proveLandsWithProductCompletion({
      projectRoot: root,
      tip: "main",
      briefRel: COMPLETED,
      plan: plan(true),
      runGh: (args) => {
        seen.push(args.join(" "));
        return args.some((a) => a.includes("/commits/"))
          ? { returncode: 0, stdout: "42\n", stderr: "" }
          : { returncode: 1, stdout: "", stderr: "offline" };
      },
    });
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.message).toMatch(/could not fetch PR #42/);
    expect(seen.some((s) => s.includes(`commits/${repo.landing}/pulls`))).toBe(true);
  });

  it("does not prove a landed brief for another issue", () => {
    const repo = landedRepo("squash");
    root = repo.root;
    const failing = prover({ landing: repo.landing, body: "", prs: [] });
    const tracked = evaluateCompletedTracked(root, {
      tip: "main",
      issue: 99,
      repo: REPO,
      resolveIssueState: () => "closed",
      proveLandsWithProduct: failing,
    });
    expect(tracked.landsWithProductFailures ?? []).toEqual([]);
    const orphan = evaluateOrphanActive(root, {
      issue: 99,
      repo: REPO,
      tip: "main",
      runGh: () => ({ returncode: 1, stdout: "", stderr: "" }),
      proveLandsWithProduct: failing,
    });
    expect(orphan.orphans).toEqual([]);
    const offline = evaluateOrphanActive(root, {
      issue: 77,
      repo: REPO,
      tip: "main",
      skipGh: true,
    });
    expect(offline.orphans).toEqual([]);
  });
});

describe("defaultResolveLandingPullRequests", () => {
  it("reads merged PR numbers whose merge commit is the landing commit", () => {
    const calls: string[][] = [];
    const prs = defaultResolveLandingPullRequests("abc1234", REPO, (args) => {
      calls.push([...args]);
      return { returncode: 0, stdout: "42\n42\n\n", stderr: "" };
    });
    expect(prs).toEqual([42]);
    expect(calls[0]?.[2]).toBe(`repos/${REPO}/commits/abc1234/pulls`);
    expect(
      defaultResolveLandingPullRequests("abc1234", REPO, () => ({
        returncode: 1,
        stdout: "",
        stderr: "",
      })),
    ).toBeNull();
    expect(
      defaultResolveLandingPullRequests("abc1234", "bad", () => ({
        returncode: 0,
        stdout: "",
        stderr: "",
      })),
    ).toBeNull();
    expect(
      defaultResolveLandingPullRequests("abc1234", REPO, () => {
        throw new Error("boom");
      }),
    ).toBeNull();
  });
});
