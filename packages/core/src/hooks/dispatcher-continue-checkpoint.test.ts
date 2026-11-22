import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthzState } from "../authz/index.js";
import { DEFAULT_RUNTIME_AUTHORITY_POLICY } from "../policy/runtime-authority.js";
import { clearWriteFenceMemosForTests } from "../policy/write-fence.js";
import { resolveStoryWriteAllow } from "../policy/write-fence-budget.js";
import type { GitRunner } from "../session/git.js";
import {
  DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  newRitualStatePayload,
  ritualStep,
  writeRitualState,
} from "../session/index.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { evaluateProspectiveScopeCover } from "./dispatcher.js";
import { decideHook, type HookDecision, type HookPolicySeams } from "./index.js";

/**
 * #6914: the continue checkpoint is process-owned storage. A write whose every
 * target is an eligible checkpoint path is allowed with `write-checkpoint-ready`
 * through the lifecycle exemption, with or without an active story, and spends
 * no extra-path allowance. Anything else falls through to today's checks.
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
const BRIEF_REL = "xbrief/active/s-6914.xbrief.json";
const CP = "xbrief/continue.xbrief.json";
const LEGACY_CP = "vbrief/continue.vbrief.json";
const SPLIT = "Split the extra paths to a follow-up story";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "6914-dispatch-"));
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
      return { code: 0, stdout: `${HEAD}\n${worktree}\nstory/6914`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD"))
      return { code: 0, stdout: HEAD, stderr: "" };
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "story/6914", stderr: "" };
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

/** origin/master holds the brief (scope: src/a.ts); the story branch is clean. */
function storyRepo(): string {
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
        id: "s-6914",
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: ["src/a.ts"] } },
      },
    }),
  );
  write(root, "src/a.ts", "a\n");
  write(root, "tests/old.test.ts", "old\n");
  write(root, ".gitignore", ".deft/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const bare = tempRoot();
  execFileSync("git", ["clone", "--bare", "-q", root, join(bare, "o.git")]);
  git("remote", "add", "origin", join(bare, "o.git"));
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-b", "story/6914");
  mkdirSync(join(root, ".deft"), { recursive: true });
  seedRitual(root);
  delete process.env.DEFT_BASE_REF;
  delete process.env.GITHUB_BASE_REF;
  clearWriteFenceMemosForTests();
  return root;
}

interface Spy {
  readonly fenceTargets: (string | null)[][];
  scopeCalls: number;
}

function seamsFor(
  root: string,
  spy: Spy,
  opts: { activeStory?: boolean; extra?: Partial<HookPolicySeams> } = {},
): HookPolicySeams {
  const active = opts.activeStory ?? true;
  return {
    inspectScope: () => {
      spy.scopeCalls += 1;
      return active
        ? { ready: true, path: join(root, ...BRIEF_REL.split("/")), message: "OK" }
        : { ready: false, path: null, message: "No active xBRIEF artifact was found" };
    },
    ritualRunGit: fakeGit(root),
    detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
    ritualRunner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    resolveStoryWriteAllow: (input) => {
      spy.fenceTargets.push([...input.targets]);
      return resolveStoryWriteAllow(input);
    },
    ...opts.extra,
  };
}

function newSpy(): Spy {
  return { fenceTargets: [], scopeCalls: 0 };
}

function hook(
  root: string,
  payload: Record<string, unknown>,
  seams: HookPolicySeams,
  environ?: NodeJS.ProcessEnv,
): HookDecision {
  return decideHook(
    {
      host: "cursor",
      event: "tool.before",
      projectRoot: root,
      payload,
      ...(environ !== undefined ? { environ } : {}),
    },
    seams,
  );
}

const writeTo = (root: string, rel: string) => ({
  toolName: "Write",
  file_path: join(root, ...rel.split("/")),
});
const editOf = (root: string, rel: string) => ({
  toolName: "Edit",
  file_path: join(root, ...rel.split("/")),
});
const patch = (declared: string, lines: readonly string[]) => ({
  tool_name: "ApplyPatch",
  tool_input: { path: declared, patch: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
});

function trySymlink(target: string, path: string, type: "file" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("continue checkpoint write admission (#6914)", () => {
  it("allows Write, Edit and patch of the checkpoint with an active story; spends nothing", () => {
    const root = storyRepo();
    const spy = newSpy();
    const seams = seamsFor(root, spy);
    expect(hook(root, writeTo(root, CP), seams)).toMatchObject({
      verdict: "allow",
      code: "write-checkpoint-ready",
    });
    expect(hook(root, writeTo(root, LEGACY_CP), seams)).toMatchObject({
      verdict: "allow",
      code: "write-checkpoint-ready",
    });
    write(root, CP, "{}\n");
    expect(hook(root, editOf(root, CP), seams)).toMatchObject({
      verdict: "allow",
      code: "write-checkpoint-ready",
    });
    expect(hook(root, patch(CP, [`*** Update File: ${CP}`, "+x"]), seams)).toMatchObject({
      verdict: "allow",
      code: "write-checkpoint-ready",
    });
    // No story is selected and the extra-path rule is never read.
    expect(spy.scopeCalls).toBe(0);
    expect(spy.fenceTargets).toEqual([]);
  });

  it("allows the checkpoint with no active story", () => {
    const root = storyRepo();
    const spy = newSpy();
    const decision = hook(root, writeTo(root, CP), seamsFor(root, spy, { activeStory: false }));
    expect(decision).toMatchObject({ verdict: "allow", code: "write-checkpoint-ready" });
    expect(spy.scopeCalls).toBe(0);
  });

  it("leaves the story extra-path allowance unchanged", () => {
    const root = storyRepo();
    const spy = newSpy();
    const seams = seamsFor(root, spy);
    expect(hook(root, writeTo(root, CP), seams).code).toBe("write-checkpoint-ready");
    write(root, CP, "{}\n");
    // The production allowance is still free after the checkpoint exists.
    expect(hook(root, writeTo(root, "src/b.ts"), seams)).toMatchObject({ verdict: "allow" });
    write(root, "src/b.ts", "b\n");
    write(root, "tests/old.test.ts", "changed\n");
    const over = hook(root, writeTo(root, "src/c.ts"), seams);
    expect(over).toMatchObject({ verdict: "deny" });
    expect(over.message).toContain("extra-paths-over-budget");
    expect(over.message).not.toContain(CP);
  });

  describe("project checks still refuse", () => {
    it("refuses when the gated ritual is not ready", () => {
      const root = storyRepo();
      const decision = hook(
        root,
        writeTo(root, CP),
        seamsFor(root, newSpy(), {
          extra: {
            inspectRitual: () => ({
              code: 1,
              message: "ritual state missing",
              tier: "gated",
              statePath: join(root, ".deft", "ritual-state.json"),
              bypassed: false,
              wouldFailCode: null,
              posture: "mutation" as const,
              ritualStateRequired: true,
            }),
          },
        }),
      );
      expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    });

    it("refuses a project runtime-authority deny path", () => {
      const root = storyRepo();
      const decision = hook(
        root,
        writeTo(root, CP),
        seamsFor(root, newSpy(), {
          extra: {
            loadRuntimeAuthority: () => ({
              ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
              enabled: true,
              allowPaths: ["**"],
              denyPaths: [CP],
            }),
          },
        }),
      );
      expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    });

    it("refuses under an active UAT lease without a grant (authz)", () => {
      const root = storyRepo();
      const uat = {
        schemaVersion: 1,
        uat: {
          active: true,
          campaignId: "uat-6914",
          startedAt: "2026-11-22T00:00:00.000Z",
          startedBy: {
            kind: "operator-cli",
            actor: "operator",
            mintedAt: "2026-11-22T00:00:00.000Z",
            mintedVia: "cli",
            eventRef: null,
          },
          suspendedAt: null,
          note: null,
        },
        activeGrantIds: [],
      } as AuthzState;
      const decision = hook(
        root,
        writeTo(root, CP),
        seamsFor(root, newSpy(), {
          extra: { loadAuthzState: () => uat, loadAuthzGrants: () => [], authzAudit: false },
        }),
      );
      expect(decision.verdict).toBe("deny");
      expect(decision.code).toMatch(/^authz-/);
    });

    it("refuses a foreign occupancy lease", () => {
      const root = storyRepo();
      applyWorktreeOccupancy(root, { sessionId: "other", intent: "mutation" });
      const decision = hook(root, writeTo(root, CP), seamsFor(root, newSpy()), {
        DEFT_SESSION_ID: "s",
      });
      expect(decision.verdict).toBe("deny");
      expect(decision.code).toMatch(/^occupancy-/);
    });
  });

  describe("does not admit", () => {
    const notCheckpoint = (d: HookDecision) => {
      expect(d.code).not.toBe("write-checkpoint-ready");
    };

    it("a case variant or another file under xbrief/ or vbrief/", () => {
      const root = storyRepo();
      const seams = seamsFor(root, newSpy());
      for (const rel of [
        "xbrief/Continue.xbrief.json",
        "xbrief/notes.xbrief.json",
        "vbrief/continue.xbrief.json",
      ]) {
        const d = hook(root, writeTo(root, rel), seams);
        notCheckpoint(d);
        expect(d.verdict, rel).toBe("deny");
      }
    });

    it("a `..` component; the fence refusal names the checkpoint without split or widen", () => {
      const root = storyRepo();
      mkdirSync(join(root, "xbrief", "hop"), { recursive: true });
      const d = hook(
        root,
        { toolName: "Write", file_path: `${root}/xbrief/hop/../continue.xbrief.json` },
        seamsFor(root, newSpy()),
      );
      notCheckpoint(d);
      expect(d.verdict).toBe("deny");
      expect(d.message).toContain("is the continue checkpoint");
      expect(d.message).not.toContain(SPLIT);
    });

    it("a whitespace-padded spelling the harvest would trim to the checkpoint", () => {
      const root = storyRepo();
      const seams = seamsFor(root, newSpy());
      const padded = hook(
        root,
        { toolName: "Write", file_path: `${join(root, ...CP.split("/"))} ` },
        seams,
      );
      notCheckpoint(padded);
      expect(padded.verdict).toBe("deny");
      const header = hook(root, patch(CP, [`*** Add File: ${CP} `, "+{}"]), seams);
      notCheckpoint(header);
      expect(header.verdict).toBe("deny");
    });

    it("an existing checkpoint with more than one hard link", () => {
      const root = storyRepo();
      mkdirSync(join(root, "xbrief"), { recursive: true });
      linkSync(join(root, "src", "a.ts"), join(root, ...CP.split("/")));
      const d = hook(root, editOf(root, CP), seamsFor(root, newSpy()));
      notCheckpoint(d);
      expect(d.verdict).toBe("deny");
    });

    it("a link on the leaf", (ctx) => {
      const root = storyRepo();
      if (!trySymlink(join(root, "src", "a.ts"), join(root, ...CP.split("/")), "file")) {
        ctx.skip();
      }
      const d = hook(root, editOf(root, CP), seamsFor(root, newSpy()));
      notCheckpoint(d);
      expect(d.verdict).toBe("deny");
    });

    it("a link on a parent component", (ctx) => {
      const root = storyRepo();
      const outside = tempRoot();
      if (!trySymlink(outside, join(root, "vbrief"), "junction")) ctx.skip();
      const d = hook(root, writeTo(root, LEGACY_CP), seamsFor(root, newSpy()));
      notCheckpoint(d);
      expect(d.verdict).toBe("deny");
    });

    it("a patch that moves a product path into or out of the checkpoint", () => {
      const root = storyRepo();
      write(root, CP, "{}\n");
      const seams = seamsFor(root, newSpy());
      const into = hook(
        root,
        patch(CP, ["*** Update File: src/a.ts", `*** Move to: ${CP}`, "+x"]),
        seams,
      );
      notCheckpoint(into);
      expect(into.verdict).toBe("deny");
      const outOf = hook(
        root,
        patch(CP, [`*** Update File: ${CP}`, "*** Move to: src/a.ts", "+x"]),
        seams,
      );
      notCheckpoint(outOf);
      expect(outOf.verdict).toBe("deny");
    });

    it("a write with any non-checkpoint target", () => {
      const root = storyRepo();
      const d = hook(
        root,
        patch(CP, [`*** Add File: ${CP}`, "+{}", "*** Update File: src/a.ts", "+x"]),
        seamsFor(root, newSpy()),
      );
      notCheckpoint(d);
      expect(d.verdict).toBe("deny");
      expect(d.message).toContain("is the continue checkpoint");
    });
  });
});

describe("commit scope-cover drops the checkpoint (#6914)", () => {
  const scope = (root: string) => () => ({
    ready: true,
    path: join(root, ...BRIEF_REL.split("/")),
    message: "OK",
  });

  it("passes a staged checkpoint alone without reading the extra-path rule", () => {
    const root = storyRepo();
    let called = false;
    const result = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: [CP],
      inspectScope: scope(root),
      resolveStoryBinding: () => ({ kind: "none" }),
      resolveStoryWriteAllow: () => {
        called = true;
        return { kind: "unchanged" };
      },
    });
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("passes the checkpoint with a covered product path; the checkpoint spends nothing", () => {
    const root = storyRepo();
    const seen: (string | null)[][] = [];
    const result = evaluateProspectiveScopeCover({
      projectRoot: root,
      stagedRelPaths: [CP, "src/a.ts"],
      inspectScope: scope(root),
      resolveStoryBinding: () => ({ kind: "none" }),
      resolveStoryWriteAllow: (input) => {
        seen.push([...input.targets]);
        return resolveStoryWriteAllow(input);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.uncovered).toEqual([]);
    for (const targets of seen) expect(targets).not.toContain(CP);
  });
});
