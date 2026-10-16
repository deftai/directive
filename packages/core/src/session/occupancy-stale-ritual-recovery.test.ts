import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decideHook, type HookPolicySeams } from "../hooks/dispatcher.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { canonicalHostSessionId } from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyCeremonyEligibility,
  grantOccupancyMembership,
  OCCUPANCY_MAX_LEASE_MS,
  OCCUPANCY_TTL_MS,
  readOccupancy,
  stealOccupancy,
} from "./occupancy.js";
import {
  applyOccupancyEligibilityToDenial,
  occupancyAwareDenialMessage,
  SHELL_COVERAGE_HONESTY,
} from "./occupancy-recovery.js";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import { runSessionStart, type SessionStartOptions } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  if (result.status !== 0) throw new Error((result.stderr ?? result.stdout ?? "git failed").trim());
  return (result.stdout ?? "").trim();
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-4290-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  writeFileSync(join(root, "README"), "x\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export {}\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function addLinked(root: string, name = "linked"): string {
  const linked = join(root, name);
  git(root, ["worktree", "add", "-q", linked, "HEAD"]);
  return linked;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-4290-plain-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return root;
}

function writeFreshRitual(root: string, sessionId: string, startedAt: Date): void {
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId,
      gitHead: git(root, ["rev-parse", "HEAD"]),
      worktreePath: resolve(root),
      startedAt,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: startedAt }),
        branch_policy: ritualStep({ ok: true, ts: startedAt }),
        triage_welcome: ritualStep({ ok: true, ts: startedAt }),
        verify_tools: ritualStep({ ok: true, ts: startedAt }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts: startedAt }),
        doctor: ritualStep({ ok: true, ts: startedAt }),
        cache_fresh: ritualStep({ ok: true, ts: startedAt }),
      },
    }),
  );
}

const STALE_RITUAL = {
  code: 1,
  message:
    "session ritual state is stale (older than 4h). Compact/resume marked re-arm needed. " +
    "Run `deft session:start --rearm` to re-arm (or `deft session:start` for a full cold ceremony).",
  tier: "gated" as const,
  recoveryTier: "rearm" as const,
  statePath: "/tmp/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const READY_SCOPE = {
  ready: true,
  path: "xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

function staleSeams(): HookPolicySeams {
  return {
    inspectRitual: () => STALE_RITUAL,
    inspectScope: () => READY_SCOPE,
    runningInsideDeftRepo: () => true,
    // #5656: fixture stubs lack merge-base fence bytes; default positive allow.
    loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
  };
}

function readySeams(boundSessionId: string): HookPolicySeams {
  return {
    verifyRitual: () => ({
      code: 0,
      message: "OK session ritual gated tier is fresh.",
      tier: "gated",
      statePath: "/tmp/ritual-state.json",
      bypassed: false,
      wouldFailCode: null,
      posture: "mutation",
      ritualStateRequired: true,
      boundSessionId,
    }),
    inspectScope: () => READY_SCOPE,
    runningInsideDeftRepo: () => true,
    // #5656: fixture stubs lack merge-base fence bytes; default positive allow.
    loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
  };
}

const ceremonyEnvironment: EnvironmentContext = {
  hostPlatform: "darwin",
  shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
};

function ceremonyOptions(root: string, sessionId: string, now: Date): SessionStartOptions {
  return {
    sessionId,
    writeHistory: false,
    now,
    env: { DEFT_SESSION_ID: sessionId },
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    resolveUserMd: () => ({
      path: join(root, ".deft", "USER.md"),
      rung: "workspace-local",
      found: true,
      diagnostic: "USER.md resolved from workspace-local config",
      searched: [],
    }),
    probeEnvironment: () => ceremonyEnvironment,
    probeScm: () => ({
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      injectedTokenPresent: false,
      depth: "shallow",
      detail: "SCM ready: gh present, host-gh authenticated (shallow)",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    }),
    probeReleaseAvailability: () => ({ lines: [] }),
    runStalenessTickler: () => ({ lines: [], prompted: false }),
  };
}

function claimFenceChild(
  tree: string,
  sessionId: string,
): Promise<{
  readonly code: number;
  readonly action: string;
  readonly sessionId: string | null;
  readonly claimedAt: string | null;
}> {
  return new Promise((resolvePromise, reject) => {
    const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
    const workerFile = fileURLToPath(
      new URL("./occupancy-sibling-fence-worker.ts", import.meta.url),
    );
    const child = spawn(process.execPath, [tsxCli, workerFile], {
      env: {
        ...process.env,
        OCCUPANCY_FENCE_ROOT: tree,
        OCCUPANCY_FENCE_SESSION: sessionId,
      },
      cwd: dirname(workerFile),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`fence worker ${sessionId} exited ${code}: ${stderr}`));
        return;
      }
      resolvePromise(
        JSON.parse(stdout.trim()) as {
          readonly code: number;
          readonly action: string;
          readonly sessionId: string | null;
          readonly claimedAt: string | null;
        },
      );
    });
  });
}

function writeDecision(root: string, sessionId: string, target: string, seams: HookPolicySeams) {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: { toolName: "Write", file_path: target },
      environ: { DEFT_SESSION_ID: sessionId },
    },
    seams,
  );
}

describe("occupancy preview matches persist (#4290)", () => {
  it(
    "preview refuses a restricted primary and persist does not write a lease",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date("2026-09-23T12:00:00Z");
      expect(
        applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" }).code,
      ).toBe(0);
      const preview = applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
        write: false,
      });
      const persist = applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
        write: true,
      });
      expect(preview.code).toBe(1);
      expect(persist.code).toBe(1);
      expect(preview.action).toBe("denied");
      expect(persist.action).toBe("denied");
      expect(preview.message).toContain("primary-claim-exception=operator-default-branch");
      expect(persist.message).toContain("primary-claim-exception=operator-default-branch");
      expect(readOccupancy(root)).toBeNull();
    },
  );

  it(
    "revalidates sibling arrival between preview and persist without claiming",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date("2026-09-23T12:00:00Z");
      const preview = applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
        write: false,
      });
      expect(preview.code).toBe(0);
      expect(readOccupancy(root)).toBeNull();
      expect(
        applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" }).code,
      ).toBe(0);
      const persist = applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
        write: true,
      });
      expect(persist.code).toBe(1);
      expect(persist.action).toBe("denied");
      expect(readOccupancy(root)).toBeNull();
    },
  );

  it(
    "steal preview refuses a restricted primary and does not steal",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date("2026-09-23T12:00:00Z");
      applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" });
      const preview = stealOccupancy(root, {
        sessionId: "solo",
        now,
        steal: true,
        confirm: true,
        occupant: "nobody",
        write: false,
      });
      expect(preview.code).toBe(1);
      expect(preview.message).toContain("primary-claim-exception=operator-default-branch");
      expect(readOccupancy(root)).toBeNull();
    },
  );

  it("trusted exception still claims while a sibling is live", destContentionItTimeout(), () => {
    const root = gitRepo();
    const linked = addLinked(root);
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" });
    const claimed = applyWorktreeOccupancy(root, {
      sessionId: "solo",
      now,
      intent: "mutation",
      primaryClaimException: "operator-default-branch",
    });
    expect(claimed.code).toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe("solo");
  });
});

describe("occupancy ceremony eligibility cases (#4290)", () => {
  it("admits absent occupancy on an uncontended tree", () => {
    const root = tempRoot();
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "solo",
      now: new Date("2026-09-23T12:00:00Z"),
    });
    expect(eligibility).toMatchObject({
      admitCeremony: true,
      occupancyCase: "absent",
    });
  });

  it("admits live same-owner heartbeat", () => {
    const root = tempRoot();
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now, intent: "mutation" });
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "owner",
      now,
    });
    expect(eligibility).toMatchObject({
      admitCeremony: true,
      occupancyCase: "live-same-owner",
    });
  });

  it("refuses live foreign-owner and does not print session:ready as recovery", () => {
    const root = tempRoot();
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now, intent: "mutation" });
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "other",
      now,
    });
    expect(eligibility.admitCeremony).toBe(false);
    expect(eligibility.occupancyCase).toBe("live-foreign-owner");
    const denial = applyOccupancyEligibilityToDenial(STALE_RITUAL.message, eligibility, "rearm");
    expect(denial).not.toMatch(/session:ready/);
    expect(denial).not.toMatch(/session:start --rearm/);
    expect(denial).toContain("Worktree occupied");
    expect(denial).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("refuses a granted member owner-claim", () => {
    const root = tempRoot();
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now, intent: "mutation" });
    grantOccupancyMembership(root, {
      sessionId: "owner",
      childSessionId: "child",
      role: "leaf-implementation",
      now,
    });
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "child",
      now,
    });
    expect(eligibility.occupancyCase).toBe("granted-member");
    expect(eligibility.admitCeremony).toBe(false);
    expect(eligibility.denialMessage).toContain(
      "A member's write permission does not authorize an owner claim",
    );
    const persist = applyWorktreeOccupancy(root, { sessionId: "child", now, intent: "mutation" });
    expect(persist.action).toBe("denied");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("names inherited-child rather than steal", () => {
    const root = tempRoot();
    const now = new Date("2026-09-23T12:00:00Z");
    const raw = "01a055e2-b503-7b72-a054-b9dff5bc5e32";
    applyWorktreeOccupancy(root, { sessionId: raw, now, intent: "mutation", env: {} });
    const grok = canonicalHostSessionId("grok", raw);
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: grok,
      now,
      env: {},
    });
    expect(eligibility.occupancyCase).toBe("inherited-child");
    expect(eligibility.admitCeremony).toBe(false);
    expect(eligibility.denialMessage).toContain("Do not steal this lease from yourself");
  });

  it("admits heartbeat-expired residue on an uncontended tree", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "stale", now: claimedAt, intent: "mutation" });
    const later = new Date(claimedAt.getTime() + OCCUPANCY_TTL_MS + 1000);
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "solo",
      now: later,
    });
    expect(eligibility).toMatchObject({
      admitCeremony: true,
      occupancyCase: "heartbeat-expired-residue",
    });
  });

  it("admits age-capped residue on an uncontended tree", () => {
    const root = tempRoot();
    const claimedAt = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "capped", now: claimedAt, intent: "mutation" });
    const later = new Date(claimedAt.getTime() + OCCUPANCY_MAX_LEASE_MS + 1000);
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "solo",
      now: later,
    });
    expect(eligibility).toMatchObject({
      admitCeremony: true,
      occupancyCase: "age-capped-residue",
    });
  });

  it(
    "classifies vacant primary with a live sibling as restricted-primary",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date("2026-09-23T12:00:00Z");
      applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" });
      const eligibility = evaluateOccupancyCeremonyEligibility(root, {
        sessionId: "solo",
        now,
      });
      expect(eligibility).toMatchObject({
        admitCeremony: false,
        occupancyCase: "restricted-primary",
        restrictedPrimary: true,
      });
      expect(eligibility.denialMessage).toContain(
        "Tree/HEAD continuity does not establish operator identity",
      );
    },
  );
});

describe("printed recovery through ceremony and next write (#4290)", () => {
  it(
    "restricted primary stale write names the exception, not session:ready, and next write follows it",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date();
      expect(
        applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" }).code,
      ).toBe(0);
      const eligibility = evaluateOccupancyCeremonyEligibility(root, {
        sessionId: "solo",
        now,
      });
      expect(eligibility.occupancyCase).toBe("restricted-primary");
      expect(eligibility.admitCeremony).toBe(false);
      expect(
        occupancyAwareDenialMessage(
          root,
          STALE_RITUAL.message,
          { sessionId: "solo", now },
          "rearm",
        ),
      ).toContain("primary-claim-exception=operator-default-branch");
      expect(
        occupancyAwareDenialMessage(
          realpathSync(root),
          STALE_RITUAL.message,
          { sessionId: "solo", now, env: { DEFT_SESSION_ID: "solo" } },
          "rearm",
        ),
      ).toContain("primary-claim-exception=operator-default-branch");
      const product = join(root, "src", "app.ts");
      const denied = writeDecision(root, "solo", product, staleSeams());
      expect(denied.verdict).toBe("deny");
      expect(denied.code).toBe("ritual-not-ready");
      expect(denied.message).toContain("primary-claim-exception=operator-default-branch");
      expect(denied.message).toContain("same actor identity");
      expect(denied.message).not.toMatch(/session:ready/);
      expect(denied.message).not.toMatch(/session:start --rearm/);
      expect(denied.message).toContain(SHELL_COVERAGE_HONESTY);

      const unauthorized = applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
      });
      expect(unauthorized.action).toBe("denied");
      expect(readOccupancy(root)).toBeNull();

      const recovered = runSessionStart(root, {
        ...ceremonyOptions(root, "solo", now),
        primaryClaimException: "operator-default-branch",
      });
      expect(recovered.code).toBe(0);
      expect(readOccupancy(root)?.sessionId).toBe("solo");
      const [ritual] = readRitualState(root);
      expect(ritual?.sessionId).toBe("solo");
      const next = writeDecision(root, "solo", product, readySeams("solo"));
      expect(next.verdict).toBe("allow");
      expect(readOccupancy(root)?.sessionId).toBe("solo");
    },
  );

  it(
    "scratch no-toplevel writes use the same recovery as in-project writes",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const now = new Date();
      applyWorktreeOccupancy(linked, { sessionId: "peer", now, intent: "mutation" });
      const scratch = join(mkdtempSync(join(tmpdir(), "occ-4290-scratch-")), "note.md");
      temps.push(resolve(scratch, ".."));
      const product = writeDecision(root, "solo", join(root, "src", "app.ts"), staleSeams());
      const outside = writeDecision(root, "solo", scratch, staleSeams());
      expect(product.verdict).toBe("deny");
      expect(outside.verdict).toBe("deny");
      expect(outside.code).toBe(product.code);
      expect(outside.message).toContain("primary-claim-exception=operator-default-branch");
      expect(product.message).toContain("primary-claim-exception=operator-default-branch");
      expect(outside.message).not.toMatch(/session:ready/);
      expect(product.message).not.toMatch(/session:ready/);

      applyWorktreeOccupancy(root, {
        sessionId: "solo",
        now,
        intent: "mutation",
        primaryClaimException: "operator-default-branch",
      });
      writeFreshRitual(root, "solo", now);
      const nextScratch = writeDecision(root, "solo", scratch, readySeams("solo"));
      const nextProduct = writeDecision(
        root,
        "solo",
        join(root, "src", "app.ts"),
        readySeams("solo"),
      );
      expect(nextScratch.verdict).toBe("allow");
      expect(nextProduct.verdict).toBe("allow");
    },
  );

  it(
    "admitted same-owner stale recovery still names session:ready and the next write succeeds",
    destContentionItTimeout(),
    () => {
      const root = gitRepo();
      const now = new Date();
      applyWorktreeOccupancy(root, { sessionId: "owner", now, intent: "mutation" });
      const denied = writeDecision(root, "owner", join(root, "src", "app.ts"), staleSeams());
      expect(denied.verdict).toBe("deny");
      expect(denied.code).toBe("ritual-not-ready");
      expect(denied.message).toMatch(/session:ready|session:start --rearm/);
      expect(denied.message).toContain(SHELL_COVERAGE_HONESTY);
      const heartbeat = applyWorktreeOccupancy(root, {
        sessionId: "owner",
        now,
        intent: "mutation",
      });
      expect(heartbeat.code).toBe(0);
      writeFreshRitual(root, "owner", now);
      const next = writeDecision(root, "owner", join(root, "src", "app.ts"), readySeams("owner"));
      expect(next.verdict).toBe("allow");
    },
  );

  it("eligibility rewrite covers the whole denial, not only a Recovery suffix", () => {
    const root = tempRoot();
    const now = new Date("2026-09-23T12:00:00Z");
    applyWorktreeOccupancy(root, { sessionId: "owner", now, intent: "mutation" });
    const eligibility = evaluateOccupancyCeremonyEligibility(root, {
      sessionId: "intruder",
      now,
    });
    const whole =
      "Directive denied Write: session ritual state is stale. " +
      "Run `deft session:start --rearm` to re-arm (or `deft session:start` for a full cold ceremony). " +
      "Recovery: run `deft session:ready` (one-shot).";
    const rewritten = applyOccupancyEligibilityToDenial(whole, eligibility, "rearm");
    expect(rewritten).not.toMatch(/session:ready/);
    expect(rewritten).not.toMatch(/session:start --rearm/);
    expect(rewritten).toContain("Worktree occupied");
  });
});

describe("primary vs linked claim serialization (#4290)", () => {
  it(
    "concurrent ordinary primary and linked claims cannot both land with the sibling first",
    destContentionItTimeout(),
    async () => {
      const root = gitRepo();
      const linked = addLinked(root);
      const rounds = process.platform === "win32" ? 2 : 4;
      for (let i = 0; i < rounds; i += 1) {
        rmSync(join(root, ".deft"), { recursive: true, force: true });
        rmSync(join(linked, ".deft"), { recursive: true, force: true });
        await Promise.all([claimFenceChild(root, "solo"), claimFenceChild(linked, "peer")]);
        const primary = readOccupancy(root);
        const sibling = readOccupancy(linked);
        if (primary !== null && sibling !== null) {
          expect(primary.claimedAt.getTime()).toBeLessThanOrEqual(sibling.claimedAt.getTime());
        } else if (primary !== null) {
          expect(sibling).toBeNull();
        } else {
          expect(sibling?.sessionId).toBe("peer");
        }
      }
    },
  );
});
