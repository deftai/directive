/**
 * Per-story one-PR launch (#7083): each story is admitted at its own worktree-map
 * row `base_branch` and its dest is built from that branch's pinned commit. Each
 * branch carries only its own brief and record pair, and each passes
 * scope-provenance and the story-line check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GhRunner, githubApiPath } from "../intake/github-auth-modes.js";
import { evaluateStoryLineRequirement } from "../pr-closing-keywords/main.js";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { evaluateScopeProvenance } from "../scope-provenance/evaluate.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import { swarmLaunch } from "./launch.js";
import { resolveWorktreeMap } from "./worktrees.js";

const REPO = "deftai/directive";
const STORIES = [
  { id: "story-a7083", issue: 7101, branch: "one-pr-a" },
  { id: "story-b7083", issue: 7102, branch: "one-pr-b" },
] as const;
const briefRel = (id: string) => `xbrief/active/${id}.xbrief.json`;
const recordRel = (id: string) => `.deft/approved-scope/${id}.json`;
const intentRel = (id: string) => `.deft/approved-scope/${id}.intent.json`;

const cleanups: string[] = [];
const savedRouting = process.env.DEFT_ROUTING_PATH;
afterEach(() => {
  if (savedRouting === undefined) delete process.env.DEFT_ROUTING_PATH;
  else process.env.DEFT_ROUTING_PATH = savedRouting;
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

function briefText(s: (typeof STORIES)[number]): { raw: string; payload: unknown } {
  const payload = {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: s.id,
      title: s.id,
      status: "running",
      references: [
        {
          uri: `https://github.com/${REPO}/issues/${String(s.issue)}`,
          type: "x-xbrief/github-issue",
        },
      ],
      metadata: {
        kind: "story",
        swarm: {
          readiness: "ready",
          file_scope: [`src/${s.id}.ts`, recordRel(s.id), intentRel(s.id)],
        },
      },
    },
  };
  return { raw: `${JSON.stringify(payload)}\n`, payload };
}

/**
 * origin/master sets onePrScopeProof=mint. Each story's branch, cut from master,
 * carries only that story's brief, its human mint pair and its product file. The
 * coordinator checkout stays on master with every brief present locally.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "launch-7083-"));
  cleanups.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  write(
    root,
    "xbrief/PROJECT-DEFINITION.xbrief.json",
    JSON.stringify({
      plan: { title: "t", status: "running", policy: { onePrScopeProof: "mint" } },
    }),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const bare = mkdtempSync(join(tmpdir(), "launch-7083-bare-"));
  cleanups.push(bare);
  execFileSync("git", ["init", "-q", "--bare", join(bare, "o.git")]);
  git("remote", "add", "origin", join(bare, "o.git"));
  git("push", "-q", "origin", "master");
  for (const s of STORIES) {
    git("checkout", "-q", "-b", s.branch, "master");
    const { raw, payload } = briefText(s);
    write(root, briefRel(s.id), raw);
    const extracted = extractIntentFromRaw(raw, {});
    if (!extracted.ok) throw new Error(extracted.error);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: briefRel(s.id),
        payload,
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-22T00:00:00Z" },
        intentDigest: computeIntentDigest(extracted.preimage),
        digestAlgo: "intent-extract-v1",
      }),
      authHashV1: computeAuthHashV1(payload, briefRel(s.id)) ?? "",
    };
    write(root, recordRel(s.id), JSON.stringify(record));
    write(root, intentRel(s.id), JSON.stringify(extracted.preimage));
    write(root, `src/${s.id}.ts`, "export const x = 1;\n");
    git("add", "-A", "-f");
    git("commit", "-q", "-m", `one-PR ${s.id}`);
    git("push", "-q", "origin", s.branch);
  }
  git("checkout", "-q", "master");
  for (const s of STORIES) write(root, briefRel(s.id), briefText(s).raw);
  const routePath = join(root, "routing.local.json");
  writeFileSync(
    routePath,
    JSON.stringify({
      cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
    }),
  );
  process.env.DEFT_ROUTING_PATH = routePath;
  return root;
}

const stubGh: GhRunner = (args) => {
  const proc = (returncode: number, stdout: string) => ({
    returncode,
    stdout,
    stderr: "",
    args: [...args],
  });
  if (args[0] === "auth") return proc(0, "ok");
  const apiPath = githubApiPath(args);
  if (apiPath === "user") return proc(0, '{"login":"deft-swarm-bot"}');
  if (apiPath?.startsWith("repos/")) return proc(0, "{}");
  return proc(1, "");
};

function launch(
  root: string,
  rows: { story_id: string; base_branch: string }[],
  baseBranch?: string,
) {
  const mapPath = join(root, "worktree-map.json");
  writeFileSync(
    mapPath,
    JSON.stringify(rows.map((r) => ({ ...r, worktree_path: join(root, `wt-${r.story_id}`) }))),
  );
  const seen: { base: string; rows: string[]; rowBases: string[] } = {
    base: "",
    rows: [],
    rowBases: [],
  };
  const result = swarmLaunch({
    stories: STORIES.map((s) => briefRel(s.id)),
    projectRoot: root,
    autonomous: true,
    allocationPlanId: "cohort-7083",
    batchingRationale: "two one-PR stories, one branch each",
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    worktreeMap: mapPath,
    // Stand-in for resolveWorktreeMap: build each dest from the base its row is handed.
    worktreeResolver: (mapping, base, _create, opts) => {
      seen.base = base;
      seen.rows = mapping.map((row) => String(row.base_branch));
      seen.rowBases = [...(opts?.rowBases ?? [])];
      return mapping.map((row) => {
        execFileSync(
          "git",
          ["worktree", "add", "-q", "--detach", String(row.worktree_path), String(row.base_branch)],
          { cwd: root },
        );
        return {
          story_id: String(row.story_id),
          worktree_path: String(row.worktree_path),
          base_branch: String(row.base_branch),
        };
      });
    },
    preflightGate: () => ({ exitCode: 0, message: "" }),
    readinessGate: () => ({ exitCode: 0, report: "" }),
    runtimeAuthProbe: () => ["cloud-headless", "injected-token"],
    environ: {
      CURSOR_AGENT: "1",
      GH_TOKEN: "gho_test_injection_token_7083",
      GH_REPO: "acme/widgets",
    },
    sessionId: "test-session-7083",
    runGh: stubGh,
    workerGithubAuthMode: "injected-token",
    expectedPrincipal: { kind: "user", login: "deft-swarm-bot" },
  });
  return { result, seen };
}

describe("resolveWorktreeMap row bases (#7083)", () => {
  const rows = [
    { story_id: "a", worktree_path: "wt-a", base_branch: "a".repeat(40) },
    { story_id: "b", worktree_path: "wt-b", base_branch: "master" },
  ];
  it("refuses a differing row base that is not listed, as today", () => {
    expect(() => resolveWorktreeMap(rows, "master", false, { repoRoot: tmpdir() })).toThrow(
      /declares base_branch/,
    );
  });
  it("checks a listed row base against its own commit", () => {
    const revParsed: string[] = [];
    const git = (args: readonly string[]) => {
      if (args[0] === "rev-parse") revParsed.push(String(args[args.length - 1]));
      const stdout = args[0] === "rev-parse" ? "f".repeat(40) : "";
      return { returncode: 0, stdout, stderr: "" };
    };
    expect(() =>
      resolveWorktreeMap(rows, "master", false, {
        repoRoot: tmpdir(),
        git,
        rowBases: new Set(["a".repeat(40)]),
      }),
    ).toThrow(/story 'a' maps to/);
    expect(revParsed).toEqual([`${"a".repeat(40)}^{commit}`]);
  });
});

describe("swarm:launch per-story one-PR base (#7083)", { timeout: 120_000 }, () => {
  it("admits each story at its own branch and builds each dest from that branch's pin", () => {
    const root = project();
    const pin = (b: string) =>
      execFileSync("git", ["rev-parse", `origin/${b}`], { cwd: root })
        .toString()
        .trim();
    const { result, seen } = launch(
      root,
      STORIES.map((s) => ({ story_id: s.id, base_branch: s.branch })),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(seen.rows).toEqual([pin("one-pr-a"), pin("one-pr-b")]);
    expect(seen.rowBases.sort()).toEqual([pin("one-pr-a"), pin("one-pr-b")].sort());
    for (const s of STORIES) {
      const dest = join(root, `wt-${s.id}`);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dest }).toString().trim();
      expect(head).toBe(pin(s.branch));
      for (const rel of [briefRel(s.id), recordRel(s.id), intentRel(s.id)]) {
        expect(existsSync(join(dest, ...rel.split("/")))).toBe(true);
      }
      const peer = STORIES.find((p) => p.id !== s.id);
      if (peer === undefined) throw new Error("no peer");
      for (const rel of [briefRel(peer.id), recordRel(peer.id), intentRel(peer.id)]) {
        expect(existsSync(join(dest, ...rel.split("/")))).toBe(false);
      }
      // The product PR from this branch carries only its own brief and pair.
      const changed = execFileSync("git", ["diff", "--name-only", "origin/master", "HEAD"], {
        cwd: dest,
      })
        .toString()
        .trim()
        .split("\n")
        .sort();
      expect(changed).toEqual(
        [briefRel(s.id), recordRel(s.id), intentRel(s.id), `src/${s.id}.ts`].sort(),
      );
      const provenance = evaluateScopeProvenance(dest, { baseRef: "origin/master" });
      expect(provenance.exitCode, JSON.stringify(provenance.findings)).toBe(0);
      const storyLine = evaluateStoryLineRequirement({
        bodyText: `Refs #${String(s.issue)}\n\ndeft-story: ${String(s.issue)}\n`,
        prNumber: 900,
        projectRoot: dest,
        repo: REPO,
        files: changed.map((path) => ({ status: "added", path })),
      });
      expect(storyLine.ok, storyLine.messages.join("\n")).toBe(true);
    }
  });

  it("keeps one shared --base-branch behaving as today", () => {
    const root = project();
    // Story B's brief is not on one-pr-a: one shared branch refuses as before.
    const shared = launch(
      root,
      STORIES.map((s) => ({ story_id: s.id, base_branch: "one-pr-a" })),
      "one-pr-a",
    );
    expect(shared.result.exitCode).not.toBe(0);
    expect(shared.result.stderr).toContain(
      `origin/one-pr-a has no active brief ${briefRel("story-b7083")}`,
    );
  });
});
