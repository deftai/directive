import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearWriteFenceMemosForTests } from "../policy/write-fence.js";
import type { GitRunner } from "../session/git.js";
import {
  DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  newRitualStatePayload,
  ritualStep,
  writeRitualState,
} from "../session/index.js";
import { evaluateProspectiveScopeCover } from "./dispatcher.js";
import { decideHook, type HookPolicySeams } from "./index.js";
import type { MergeGateSignal } from "./merge-gate-signal.js";

/**
 * #6221: the story write fence uses the shared extra-path rule through the
 * real merge-base fence loader, so a fenced agent can write what
 * verify:scope-provenance admits for the same story, and nothing more.
 */

const temps: string[] = [];
const prevDeft = process.env.DEFT_BASE_REF;
const prevGithub = process.env.GITHUB_BASE_REF;
afterEach(() => {
  clearWriteFenceMemosForTests();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (prevDeft === undefined) delete process.env.DEFT_BASE_REF;
  else process.env.DEFT_BASE_REF = prevDeft;
  if (prevGithub === undefined) delete process.env.GITHUB_BASE_REF;
  else process.env.GITHUB_BASE_REF = prevGithub;
});

const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BRIEF_REL = "xbrief/active/s-6221.xbrief.json";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "extra-path-dispatch-"));
  temps.push(root);
  return root;
}

function write(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

function fakeGit(root: string): GitRunner {
  const worktree = resolve(root);
  return (_r, args) => {
    if (args.includes("--show-toplevel") && args.includes("--abbrev-ref")) {
      return { code: 0, stdout: `${HEAD}\n${worktree}\nstory/6221`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD"))
      return { code: 0, stdout: HEAD, stderr: "" };
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "story/6221", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
}

function seedRitual(root: string): void {
  const now = new Date();
  writeRitualState(root, {
    ...newRitualStatePayload({
      sessionId: "s",
      gitHead: HEAD,
      worktreePath: resolve(root),
      startedAt: now,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: now }),
        branch_policy: ritualStep({ ok: true, ts: now }),
        triage_welcome: ritualStep({ ok: true, ts: now }),
        verify_tools: ritualStep({ ok: true, ts: now }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts: now }),
        doctor: ritualStep({ ok: true, ts: now }),
        cache_fresh: ritualStep({ ok: true, ts: now }),
      },
    }),
    drift_probe: DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  });
}

/** origin/master holds the brief (scope: src/a.ts) and an existing test; the branch is clean. */
function storyRepo(fileScope: readonly string[] = ["src/a.ts"]): string {
  const root = tempRoot();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  write(
    root,
    BRIEF_REL,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "s-6221",
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: fileScope } },
      },
    }),
  );
  write(root, "src/a.ts", "a\n");
  write(root, "tests/old.test.ts", "old\n");
  write(root, "tests/fixtures/data.json", "{}\n");
  write(root, ".gitignore", ".deft/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const bare = tempRoot();
  execFileSync("git", ["clone", "--bare", "-q", root, join(bare, "o.git")]);
  git("remote", "add", "origin", join(bare, "o.git"));
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-b", "story/6221");
  mkdirSync(join(root, ".deft"), { recursive: true });
  seedRitual(root);
  delete process.env.DEFT_BASE_REF;
  delete process.env.GITHUB_BASE_REF;
  clearWriteFenceMemosForTests();
  return root;
}

function writeTo(root: string, rel: string, extra: Partial<HookPolicySeams> = {}) {
  const seams: HookPolicySeams = {
    inspectScope: () => ({ ready: true, path: join(root, ...BRIEF_REL.split("/")), message: "OK" }),
    ritualRunGit: fakeGit(root),
    detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
    ritualRunner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    ...extra,
  };
  return decideHook(
    {
      host: "cursor",
      event: "tool.before",
      projectRoot: root,
      payload: { toolName: "Write", file_path: join(root, ...rel.split("/")) },
    },
    seams,
  );
}

describe("story write fence: shared extra-path rule (#6221)", () => {
  it("admits a declared path and one undeclared test modify (the #5710 case)", () => {
    const root = storyRepo();
    expect(writeTo(root, "src/a.ts")).toMatchObject({ verdict: "allow" });
    expect(writeTo(root, "tests/old.test.ts")).toMatchObject({ verdict: "allow" });
    expect(writeTo(root, "tests/fixtures/data.json")).toMatchObject({ verdict: "allow" });
  });

  it("admits the production allowance membership grants", () => {
    const root = storyRepo();
    expect(writeTo(root, "src/b.ts")).toMatchObject({ verdict: "allow" });
  });

  it("refuses a new undeclared test file with extra-path-not-admitted", () => {
    const root = storyRepo();
    const decision = writeTo(root, "tests/new.test.ts");
    expect(decision).toMatchObject({ verdict: "deny" });
    expect(decision.message).toContain("extra-path-not-admitted");
  });

  it("refuses an other-class undeclared path", () => {
    const root = storyRepo();
    expect(writeTo(root, "docs/notes.md")).toMatchObject({ verdict: "deny" });
  });

  it("refuses a new extra past the budget with extra-paths-over-budget; rewrites stay admitted", () => {
    const root = storyRepo();
    write(root, "src/b.ts", "b\n");
    write(root, "tests/old.test.ts", "changed\n");
    const decision = writeTo(root, "src/c.ts");
    expect(decision).toMatchObject({ verdict: "deny" });
    expect(decision.message).toContain("extra-paths-over-budget");
    expect(writeTo(root, "src/b.ts")).toMatchObject({ verdict: "allow" });
  });

  it("treats a glob match as an extra without a mint", () => {
    const root = storyRepo(["src/**"]);
    write(root, "src/b.ts", "b\n");
    write(root, "src/c.ts", "c\n");
    // Before #6221 the glob admitted this write, so the over-budget refusal is
    // new and warns for one release (#6281): the write is admitted.
    const decision = writeTo(root, "src/d.ts");
    expect(decision).toMatchObject({ verdict: "allow" });
  });

  it("keeps the story deny paths: a budget admit never overrides them", () => {
    const root = storyRepo();
    const decision = writeTo(root, "tests/old.test.ts", {
      loadStoryWriteFence: () => ({
        fileScope: ["src/a.ts"],
        denyPaths: ["tests/old.test.ts"],
        mergeBaseSha: "x",
      }),
      resolveStoryWriteAllow: () => ({
        kind: "scope",
        storyAllow: ["tests/old.test.ts"],
        assessment: null,
      }),
    });
    expect(decision).toMatchObject({ verdict: "deny" });
  });

  describe("under a live merge gate (#6535 site e)", () => {
    class AnyRoot extends Map<string, MergeGateSignal> {
      constructor(private readonly live: boolean) {
        super();
      }
      override get(): MergeGateSignal {
        const live = this.live;
        return {
          evaluate: () => ({
            live,
            check: live ? "Merge gate (task check)" : null,
            branch: live ? "master" : null,
          }),
        };
      }
    }
    const gate = (live: boolean): Partial<HookPolicySeams> => ({
      mergeGateSignals: new AnyRoot(live),
    });

    it("warns instead of refusing an undeclared doc and a new undeclared test", () => {
      const root = storyRepo();
      expect(writeTo(root, "docs/notes.md", gate(false))).toMatchObject({ verdict: "deny" });
      const doc = writeTo(root, "docs/notes.md", gate(true));
      expect(doc).toMatchObject({ verdict: "allow" });
      expect(doc.message).toContain("Warning:");
      expect(doc.message).toContain("extra-path-not-admitted");
      const test = writeTo(root, "tests/new.test.ts", gate(true));
      expect(test).toMatchObject({ verdict: "allow" });
      expect(test.message).toContain("extra-path-not-admitted");
    });

    it("warns instead of refusing a source path past the allowance", () => {
      const root = storyRepo();
      write(root, "src/b.ts", "b\n");
      write(root, "tests/old.test.ts", "changed\n");
      expect(writeTo(root, "src/c.ts", gate(false))).toMatchObject({ verdict: "deny" });
      const live = writeTo(root, "src/c.ts", gate(true));
      expect(live).toMatchObject({ verdict: "allow" });
      expect(live.message).toContain("extra-paths-over-budget");
    });

    it("still refuses a story deny path, and an unreadable approval record", () => {
      const root = storyRepo();
      const denied = writeTo(root, "docs/notes.md", {
        ...gate(true),
        loadStoryWriteFence: () => ({
          fileScope: ["src/a.ts"],
          denyPaths: ["docs/notes.md"],
          mergeBaseSha: "x",
        }),
        resolveStoryWriteAllow: () => ({
          kind: "refuse",
          reason: "extra-path-not-admitted: probe",
          storyAllow: [],
          scopeOnly: true,
        }),
      });
      expect(denied).toMatchObject({ verdict: "deny" });
      const hard = writeTo(root, "docs/notes.md", {
        ...gate(true),
        resolveStoryWriteAllow: () => ({
          kind: "refuse",
          reason: "merge-base mint read failed; fail closed (#6221)",
          storyAllow: [],
        }),
      });
      expect(hard).toMatchObject({ verdict: "deny" });
      expect(hard.message).toContain("merge-base mint read failed");
    });
  });

  it("passes every target of the operation to the shared decision and uses its refusal", () => {
    const root = storyRepo();
    const seen: (string | null)[][] = [];
    const decision = writeTo(root, "src/a.ts", {
      resolveStoryWriteAllow: (input) => {
        seen.push([...input.targets]);
        return { kind: "refuse", reason: "extra-paths-over-budget: probe", storyAllow: [] };
      },
    });
    expect(seen).toEqual([["src/a.ts"]]);
    expect(decision).toMatchObject({ verdict: "deny" });
    expect(decision.message).toContain("extra-paths-over-budget: probe");
  });
});

describe("prospective staged scope-cover: shared extra-path decision (#6221)", () => {
  const scope = (root: string) => () => ({
    ready: true,
    path: join(root, ...BRIEF_REL.split("/")),
    message: "OK",
  });

  it("admits a staged undeclared test modify and refuses a staged new test", () => {
    const root = storyRepo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    write(root, "tests/old.test.ts", "changed\n");
    git("add", "tests/old.test.ts");
    const ok = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: ["tests/old.test.ts"],
      inspectScope: scope(root),
      resolveStoryBinding: () => ({ kind: "none" }),
    });
    expect(ok.ok).toBe(true);

    write(root, "tests/new.test.ts", "new\n");
    git("add", "tests/new.test.ts");
    const refused = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: ["tests/old.test.ts", "tests/new.test.ts"],
      inspectScope: scope(root),
      resolveStoryBinding: () => ({ kind: "none" }),
    });
    expect(refused.ok).toBe(false);
    expect(refused.uncovered).toEqual(["tests/new.test.ts"]);
    expect(refused.message).toContain("extra-path-not-admitted");
  });

  it("keeps the readiness check ahead of the extra-path decision", () => {
    const root = storyRepo();
    let called = false;
    const result = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: ["tests/old.test.ts"],
      inspectScope: () => ({ ready: false, path: null, message: "no scope" }),
      resolveStoryBinding: () => ({ kind: "none" }),
      resolveStoryWriteAllow: () => {
        called = true;
        return { kind: "unchanged" };
      },
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
