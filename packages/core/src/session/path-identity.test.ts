/**
 * Windows path identity (#7200): an 8.3 short spelling, a lowercase spelling
 * and the long spelling of one worktree are one worktree at every identity
 * compare. Real git repositories and real folders, no path mocks.
 *
 * The 8.3 cases skip where the host makes no short name for the fixture
 * (8.3 creation off, or a Dev Drive). On the GitHub Windows runners
 * `os.tmpdir()` is itself an 8.3 spelling (`C:\Users\RUNNER~1\...`), so the
 * nightly Windows lane runs them. The lowercase cases need no 8.3 support.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admitEffectiveHookRoot,
  admitMutationTargetSet,
  isOutsideProjectRootWrite,
  toProjectRelativePosix,
} from "../hooks/dispatcher.js";
import { restampOwnerLivenessOnHookEvent } from "../hooks/owner-liveness.js";
import { destPlaceImplementSpawn } from "../swarm/dest-place.js";
import { physicalTargetKey, resolveStoryBindingTarget } from "../swarm/pre-dispatch.js";
import {
  canonicalWorktreePath,
  resolveWorkerAuthDestPath,
  workerAuthRecordName,
} from "../swarm/worker-auth-assignment.js";
import { prepareLinkedWorktree } from "../swarm/worktree-pm-install.js";
import { MissingWorktreeError, resolveWorktreeMap } from "../swarm/worktrees.js";
import {
  canonicalPathIdentity,
  defaultGitRunner,
  gitCommonDir,
  samePathIdentity,
  sameWorktreePath,
  worktreePath,
  worktreePathOrNull,
} from "./git.js";
import { isMainWorktreePath, mainWorktreeRoot } from "./main-worktree.js";
import {
  applyWorktreeOccupancy,
  OCCUPANCY_REFRESH_AFTER_MS,
  occupancyWorktreeMatches,
} from "./occupancy.js";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import { assessRearmEligibility } from "./session-start.js";
import { persistSpawnReservation, readSpawnReservationIncarnation } from "./spawn-occupancy.js";
import { verifySessionRitual } from "./verify-session-ritual.js";

const WIN32 = process.platform === "win32";
const IT_TIMEOUT_MS = 60_000;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@t.local",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@t.local",
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

/**
 * 8.3 spelling from `cmd /c for %I in ("<path>") do @echo %~sI`, checked to
 * resolve back to `<path>`; null when the host gives none.
 */
function shortSpelling(longPath: string): string | null {
  const run = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", `"for %I in ("${longPath}") do @echo %~sI"`],
    {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    },
  );
  const out = (run.stdout ?? "").trim();
  if (run.status !== 0 || out.length === 0 || out === longPath) return null;
  try {
    return realpathSync.native(out) === longPath ? out : null;
  } catch {
    return null;
  }
}

type SpellingKind = "8.3" | "lowercase";

function aliasOf(kind: SpellingKind, longPath: string): string | null {
  if (kind === "8.3") return shortSpelling(longPath);
  const lower = longPath.toLowerCase();
  return lower === longPath ? null : lower;
}

interface Fixture {
  readonly base: string;
  readonly main: string;
  readonly linked: string;
  readonly foreign: string;
  readonly leaseDir: string;
}

let fx: Fixture;

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);
  writeFileSync(join(dir, "README.md"), "x\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

beforeAll(() => {
  if (!WIN32) return;
  // Long spelling of the fixture base: native realpath expands an 8.3 tmpdir.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "path-identity-7200-")));
  const main = join(base, "main-repository");
  const foreign = join(base, "foreign-repository");
  initRepo(main);
  initRepo(foreign);
  const linked = join(main, "linked-worktree");
  git(main, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
  const leaseDir = join(base, "lease-directory");
  mkdirSync(leaseDir, { recursive: true });
  fx = { base, main, linked, foreign, leaseDir };
});

afterAll(() => {
  if (!WIN32 || fx === undefined) return;
  rmSync(fx.base, { recursive: true, force: true });
});

describe.skipIf(!WIN32).each(["8.3", "lowercase"] as const)(
  "win32 path identity, %s spelling (#7200)",
  (kind) => {
    function alias(longPath: string, skip: () => void): string {
      const spelled = aliasOf(kind, longPath);
      if (spelled === null) skip();
      return spelled as string;
    }

    it("canonicalPathIdentity gives the long spelling, keeps case, handles a missing leaf", (ctx) => {
      const a = alias(fx.main, () => ctx.skip());
      expect(canonicalPathIdentity(a)).toBe(fx.main);
      expect(canonicalPathIdentity(join(a, "missing", "leaf.txt"))).toBe(
        join(fx.main, "missing", "leaf.txt"),
      );
      // ENOTDIR: a file in the middle of the path keeps the rest unchanged.
      expect(canonicalPathIdentity(join(a, "README.md", "child"))).toBe(
        join(fx.main, "README.md", "child"),
      );
      expect(samePathIdentity(a, fx.main)).toBe(true);
      expect(samePathIdentity(a, fx.foreign)).toBe(false);
    });

    it(
      "git helpers return the canonical form; gitCommonDir agrees with the linked worktree",
      (ctx) => {
        const a = alias(fx.main, () => ctx.skip());
        const common = join(fx.main, ".git");
        expect(gitCommonDir(a, defaultGitRunner)).toBe(common);
        expect(gitCommonDir(fx.main, defaultGitRunner)).toBe(common);
        expect(gitCommonDir(fx.linked, defaultGitRunner)).toBe(common);
        expect(worktreePath(a, defaultGitRunner)).toBe(fx.main);
        expect(worktreePathOrNull(a, defaultGitRunner)).toBe(fx.main);
      },
      IT_TIMEOUT_MS,
    );

    it(
      "admitEffectiveHookRoot admits the same repository and still refuses a foreign one",
      (ctx) => {
        const payload = alias(fx.main, () => ctx.skip());
        const linked = admitEffectiveHookRoot(
          payload,
          join(fx.linked, "src", "a.ts"),
          defaultGitRunner,
        );
        expect(linked).toMatchObject({ foreign: false, refusal: null, root: fx.linked });
        const own = admitEffectiveHookRoot(payload, join(fx.main, "src", "a.ts"), defaultGitRunner);
        // A match by canonical identity only takes git's spelling as the root.
        expect(own).toMatchObject({ foreign: false, refusal: null, root: fx.main });
        const foreign = admitEffectiveHookRoot(
          payload,
          join(fx.foreign, "src", "a.ts"),
          defaultGitRunner,
        );
        expect(foreign).toMatchObject({ foreign: true, refusal: "foreign-repository" });
        // One target outside every checkout keeps the payload spelling as its
        // root; the de-duplication still sees a single root.
        const set = admitMutationTargetSet(
          payload,
          [join(fx.base, "outside.txt"), join(fx.main, "a.ts")],
          defaultGitRunner,
        );
        expect(set.foreign).toBe(false);
      },
      IT_TIMEOUT_MS,
    );

    it(
      "ritual state recorded under another spelling belongs to this worktree",
      (ctx) => {
        const recorded = alias(fx.main, () => ctx.skip());
        const now = new Date("2026-11-23T12:00:00Z");
        const head = git(fx.main, ["rev-parse", "HEAD"]);
        writeRitualState(
          fx.main,
          newRitualStatePayload({
            sessionId: "s",
            gitHead: head,
            worktreePath: recorded,
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
        );
        const verified = verifySessionRitual(fx.main, {
          tier: "gated",
          now,
          bypass: false,
          posture: "mutation",
          runner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
        });
        expect(verified.message ?? "").not.toContain("different worktree");
        expect(verified.code).toBe(0);
        const rearm = assessRearmEligibility(fx.main, { now });
        if (!rearm.eligible) expect(rearm.reason).not.toContain("different worktree");
        rmSync(join(fx.main, ".deft"), { recursive: true, force: true });
      },
      IT_TIMEOUT_MS,
    );

    it("occupancy and owner-liveness treat both spellings as one tree", (ctx) => {
      const a = alias(fx.leaseDir, () => ctx.skip());
      expect(occupancyWorktreeMatches(a, fx.leaseDir)).toBe(true);
      const claimedAt = new Date("2026-11-23T12:00:00Z");
      applyWorktreeOccupancy(fx.leaseDir, {
        sessionId: "owner",
        intent: "mutation",
        now: claimedAt,
        env: {},
      });
      const outcome = restampOwnerLivenessOnHookEvent({
        projectRoot: a,
        ownerSessionId: "owner",
        hostAuthoritative: true,
        now: new Date(claimedAt.getTime() + OCCUPANCY_REFRESH_AFTER_MS + 1_000),
      });
      expect(outcome).toMatchObject({ restamped: true, sessionId: "owner" });
      rmSync(join(fx.leaseDir, ".deft"), { recursive: true, force: true });
    });

    it(
      "isMainWorktreePath and mainWorktreeRoot accept the main checkout's alias",
      (ctx) => {
        const a = alias(fx.main, () => ctx.skip());
        expect(isMainWorktreePath(a, defaultGitRunner)).toBe(true);
        expect(isMainWorktreePath(fx.linked, defaultGitRunner)).toBe(false);
        expect(mainWorktreeRoot(a, defaultGitRunner)).toBe(fx.main);
      },
      IT_TIMEOUT_MS,
    );

    it("shared worktree compare (spawn, child occupancy, prep, story binding) matches", (ctx) => {
      const a = alias(fx.linked, () => ctx.skip());
      expect(sameWorktreePath(a, fx.linked)).toBe(true);
      expect(sameWorktreePath(fx.main, fx.linked)).toBe(false);
    });

    it(
      "pre-dispatch alias peer key and story binding see one worktree",
      (ctx) => {
        const linkedAlias = alias(fx.linked, () => ctx.skip());
        const mainAlias = alias(fx.main, () => ctx.skip());
        expect(physicalTargetKey(fx.main, linkedAlias)).toBe(physicalTargetKey(fx.main, fx.linked));
        const bound = resolveStoryBindingTarget(mainAlias, fx.linked, defaultGitRunner);
        expect(bound).toMatchObject({ ok: true, worktreePath: fx.linked });
      },
      IT_TIMEOUT_MS,
    );

    it("spawn reservation key is one key for both spellings", (ctx) => {
      const mainAlias = alias(fx.main, () => ctx.skip());
      const leaf = join(".deft-scratch", "worktrees", `leaf-${kind === "8.3" ? "short" : "lower"}`);
      const persisted = persistSpawnReservation(fx.main, {
        agentId: `agent-${kind}`,
        parentId: "parent",
        occupancyOwner: "parent",
        worktreePath: join(fx.main, leaf),
        identitySourceKind: "payload",
        incarnation: `inc-7200-${kind}`,
      });
      expect(persisted.ok).toBe(true);
      expect(readSpawnReservationIncarnation(fx.main, join(mainAlias, leaf))).toBe(
        `inc-7200-${kind}`,
      );
    });

    it(
      "worker-auth key is one key for both spellings and unchanged for the long one",
      (ctx) => {
        const a = alias(fx.linked, () => ctx.skip());
        expect(canonicalWorktreePath(a)).toBe(fx.linked);
        expect(canonicalWorktreePath(fx.linked)).toBe(fx.linked);
        expect(workerAuthRecordName(canonicalWorktreePath(a))).toBe(
          workerAuthRecordName(fx.linked),
        );
        expect(resolveWorkerAuthDestPath(a, defaultGitRunner)).toBe(fx.linked);
      },
      IT_TIMEOUT_MS,
    );

    it(
      "linked-worktree prep and dest-place do not call the alias a foreign worktree",
      (ctx) => {
        const mainAlias = alias(fx.main, () => ctx.skip());
        const prep = prepareLinkedWorktree(fx.linked, {
          repoRoot: mainAlias,
          requirePinOnly: true,
        });
        if (!prep.ok) expect(prep.code).not.toBe("foreign-worktree");
        const placed = destPlaceImplementSpawn({
          repoRoot: mainAlias,
          worktreePath: fx.linked,
          commitIsh: "HEAD",
          pmRunner: () => ({ status: 1, stdout: "", stderr: "no install in this test" }),
        });
        if (!placed.ok) expect(placed.code).not.toBe("foreign-worktree");
      },
      IT_TIMEOUT_MS,
    );

    it("the write fence keeps an alias-spelled target inside its root, both directions", (ctx) => {
      const rootAlias = alias(fx.main, () => ctx.skip());
      const longTarget = join(fx.main, "packages", "secret", "x.ts");
      const shortTarget = join(rootAlias, "packages", "secret", "x.ts");
      // long root / alias target, then alias root / long target: never outside.
      for (const [root, target] of [
        [fx.main, shortTarget],
        [rootAlias, longTarget],
      ] as const) {
        expect(isOutsideProjectRootWrite(root, target)).toBe(false);
        expect(toProjectRelativePosix(root, target)).toBe("packages/secret/x.ts");
      }
      // A real outside target stays outside and keeps its lexical relative.
      expect(isOutsideProjectRootWrite(fx.main, join(fx.foreign, "x.ts"))).toBe(true);
      expect(toProjectRelativePosix(fx.main, join(fx.foreign, "x.ts"))).toBe(
        "../foreign-repository/x.ts",
      );
    });

    it(
      "resolveWorktreeMap finds the registered worktree under an alias spelling",
      (ctx) => {
        const mainAlias = alias(fx.main, () => ctx.skip());
        const linkedAlias = join(mainAlias, "linked-worktree");
        let thrown: unknown = null;
        try {
          resolveWorktreeMap([{ story_id: "s1", worktree_path: linkedAlias }], "master", false, {
            repoRoot: mainAlias,
            pmRunner: () => ({ status: 1, stdout: "", stderr: "no install in this test" }),
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).not.toBeInstanceOf(MissingWorktreeError);
        expect(thrown).toBeNull();
      },
      IT_TIMEOUT_MS,
    );
  },
);

describe.skipIf(!WIN32)("win32 canonicalPathIdentity failures (#7200)", () => {
  it("a failure other than ENOENT or ENOTDIR gives null", () => {
    const denied = (): string => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(canonicalPathIdentity(fx.main, denied)).toBeNull();
  });

  it("null adds no equality beyond the site's existing compare", () => {
    // A NUL byte makes native realpath fail with a non-ENOENT code.
    expect(canonicalPathIdentity("C:\\bad\0one")).toBeNull();
    expect(samePathIdentity("C:\\bad\0one", "C:\\bad\0two")).toBe(false);
    expect(samePathIdentity("C:\\bad\0one", "C:\\bad\0one")).toBe(true);
    expect(sameWorktreePath("C:\\bad\0one", "C:\\BAD\0ONE")).toBe(true);
  });
});

describe.skipIf(WIN32)("POSIX path identity is unchanged (#7200)", () => {
  it("a symlink alias is not made equal by the identity compare", () => {
    const base = mkdtempSync(join(tmpdir(), "path-identity-7200-posix-"));
    try {
      const real = join(base, "real");
      mkdirSync(real);
      const link = join(base, "link");
      symlinkSync(real, link);
      expect(samePathIdentity(link, real)).toBe(false);
      expect(sameWorktreePath(link, real)).toBe(false);
      expect(sameWorktreePath(join(real, "."), real)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
