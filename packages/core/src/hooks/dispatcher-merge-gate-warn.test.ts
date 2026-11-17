import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeAuthorityPolicy } from "../policy/runtime-authority.js";
import { loadStoryWriteFenceFromPath } from "../policy/write-fence.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { writeWorkerAuthAssignment } from "../swarm/worker-auth-assignment.js";
import {
  decideHook,
  type HookDecision,
  type HookPolicySeams,
  renderHostDecision,
} from "./index.js";

/**
 * #6535: under a live merge-gate signal five named local refusal sites warn
 * instead of refusing; every other refusal, and every repository without the
 * signal, refuses as today. The GitHub reads are stubbed through
 * `seams.mergeGateRunGh`; git is a real repository with a real `origin`.
 */
const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};
const STALE_MESSAGE = "Session ritual state is stale (test fixture).";

const runningPlacement = {
  status: "running",
  metadata: {
    intended_placement: {
      schema: "deft.scope.intended_placement.v1",
      files: ["src/new-module.ts"],
      module_boundary: "new focused module",
    },
  },
};

const GATE = "Merge gate (task check)";
const LOCAL_POLICY = { mergeGateContext: GATE, deliveryBranch: "master" };

type Signal = "live" | "off";

/** Stub for the contents read and the required-context read of the signal. */
function ghFor(signal: Signal): { run: RunGhFn; calls: string[] } {
  const calls: string[] = [];
  const remotePolicy = signal === "live" ? LOCAL_POLICY : { deliveryBranch: "master" };
  const run: RunGhFn = (cmd) => {
    const path = cmd[2] ?? "";
    calls.push(path);
    if (path.includes("/contents/")) {
      const body = { xBRIEFInfo: { version: "0.8" }, plan: { policy: remotePolicy } };
      return {
        returncode: 0,
        stdout: JSON.stringify({
          encoding: "base64",
          content: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
        }),
        stderr: "",
      };
    }
    if (path.includes("/rules/branches/")) {
      const rules = [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: GATE }] },
        },
      ];
      return { returncode: 0, stdout: JSON.stringify(rules), stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
  };
  return { run, calls };
}

function seams(signal: Signal, extra: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: "owner" }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    loadStoryWriteFence: (_root, scopePath) => loadStoryWriteFenceFromPath(scopePath),
    mergeGateRunGh: ghFor(signal).run,
    ...extra,
  };
}

function staleRitual(): Partial<HookPolicySeams> {
  return {
    verifyRitual: () => ({
      ...READY_RITUAL,
      code: 1,
      message: STALE_MESSAGE,
      boundSessionId: "owner",
      recoveryTier: "rearm" as const,
    }),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function writeProjectDefinition(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy } }),
    "utf8",
  );
}

function writeRunning(root: string, name: string, fileScope: readonly string[]): void {
  const active = join(root, "xbrief", "active");
  mkdirSync(active, { recursive: true });
  writeFileSync(
    join(active, name),
    JSON.stringify({
      plan: {
        ...runningPlacement,
        metadata: { ...runningPlacement.metadata, swarm: { file_scope: [...fileScope] } },
      },
    }),
    "utf8",
  );
}

/** A real repository with an `origin`, the trigger policy and one running brief. */
function repo(fileScope: readonly string[] = ["packages/a/**"]): string {
  const root = mkdtempSync(join(tmpdir(), "hook-6535-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["remote", "add", "origin", "https://github.com/o/r.git"]);
  git(root, ["commit", "--allow-empty", "-q", "-m", "init"]);
  writeProjectDefinition(root, LOCAL_POLICY);
  writeRunning(root, "a-story.xbrief.json", fileScope);
  return root;
}

function write(
  root: string,
  file: string,
  testSeams: HookPolicySeams,
  environ: NodeJS.ProcessEnv = {},
): HookDecision {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: { toolName: "Write", file_path: file },
      environ: { DEFT_SESSION_ID: "owner", ...environ },
    },
    testSeams,
  );
}

function shell(root: string, command: string, testSeams: HookPolicySeams): HookDecision {
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: "Bash", tool_input: { command } },
      environ: { DEFT_SESSION_ID: "owner" },
    },
    testSeams,
  );
}

function stage(root: string, rel: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "export {};\n", "utf8");
  git(root, ["add", "--", rel]);
}

function expectWarned(decision: HookDecision, contains: string): void {
  expect(decision.verdict).toBe("allow");
  expect(decision.message.startsWith("Warning:")).toBe(true);
  expect(decision.message).toContain(contains);
  expect(decision.message).toContain(`Local enforcement is advisory here: ${GATE} is required on`);
}

describe("site (a): the gated ritual arm", () => {
  it("refuses a stale ritual without the signal and warns with it", () => {
    const root = repo();
    const file = join(root, "packages", "a", "x.ts");
    const off = write(root, file, seams("off", staleRitual()));
    expect(off).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(off.message).toContain(STALE_MESSAGE);

    const live = write(root, file, seams("live", staleRitual()));
    expect(live).toMatchObject({ verdict: "allow", code: "write-ready" });
    expectWarned(live, STALE_MESSAGE);
  });

  it("makes no GitHub call when the worktree copy names no check", () => {
    const root = repo();
    writeProjectDefinition(root, { deliveryBranch: "master" });
    const gh = ghFor("live");
    const decision = write(
      root,
      join(root, "packages", "a", "x.ts"),
      seams("live", { ...staleRitual(), mergeGateRunGh: gh.run }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(gh.calls).toEqual([]);
  });

  it("refuses when the live read fails or the named check is not required", () => {
    const root = repo();
    const file = join(root, "packages", "a", "x.ts");
    const failing: RunGhFn = () => ({ returncode: -1, stdout: "", stderr: "timed out" });
    expect(
      write(root, file, seams("live", { ...staleRitual(), mergeGateRunGh: failing })),
    ).toMatchObject({
      verdict: "deny",
      code: "ritual-not-ready",
    });
    const notRequired: RunGhFn = (cmd) => {
      if ((cmd[2] ?? "").includes("/rules/branches/")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return ghFor("live").run(cmd);
    };
    expect(
      write(root, file, seams("live", { ...staleRitual(), mergeGateRunGh: notRequired })),
    ).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
  });

  it("still refuses a stale ritual whose inspection throws", () => {
    const root = repo();
    const decision = write(
      root,
      join(root, "packages", "a", "x.ts"),
      seams("live", {
        verifyRitual: () => {
          throw new Error("inspect failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(decision.message).toContain("could not inspect");
  });

  it("returns the protected-store refusal after a warned stale ritual", () => {
    const root = repo();
    const decision = write(
      root,
      join(root, ".deft", "authz", "grants.json"),
      seams("live", staleRitual()),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "authz-uat-deny" });
    expect(decision.message).toContain("authz store");
  });
});

describe("site (b): a not-ready scope", () => {
  function twoBriefs(): string {
    const root = repo();
    writeRunning(root, "b-story.xbrief.json", ["packages/b/**"]);
    return root;
  }

  it("refuses multiple eligible briefs without the signal and warns with it", () => {
    const root = twoBriefs();
    const file = join(root, "packages", "a", "x.ts");
    const off = write(root, file, seams("off"));
    expect(off).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(off.message).toContain("Multiple active xBRIEF artifacts");
    const live = write(root, file, seams("live"));
    expect(live).toMatchObject({ verdict: "allow", code: "write-ready" });
    expectWarned(live, "Multiple active xBRIEF artifacts");
  });

  it("warns inside an unbound linked worktree under the repository folder", () => {
    const root = twoBriefs();
    const wt = join(root, ".deft-scratch", "worktrees", "story-x");
    mkdirSync(dirname(wt), { recursive: true });
    git(root, ["worktree", "add", "--detach", "-q", wt]);
    writeProjectDefinition(wt, LOCAL_POLICY);
    writeRunning(wt, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(wt, "b-story.xbrief.json", ["packages/b/**"]);
    const file = join(wt, "packages", "a", "x.ts");
    expect(write(root, file, seams("off"))).toMatchObject({
      verdict: "deny",
      code: "scope-not-ready",
    });
    const live = write(root, file, seams("live"));
    expect(live).toMatchObject({ verdict: "allow", code: "write-ready" });
    expectWarned(live, "Multiple active xBRIEF artifacts");
  });

  it("keeps refusing a worktree binding refusal", () => {
    const root = twoBriefs();
    const wt = join(root, ".deft-scratch", "worktrees", "story-gone");
    mkdirSync(dirname(wt), { recursive: true });
    git(root, ["worktree", "add", "--detach", "-q", wt]);
    writeProjectDefinition(wt, LOCAL_POLICY);
    writeRunning(wt, "a-story.xbrief.json", ["packages/a/**"]);
    const written = writeWorkerAuthAssignment({
      projectRoot: root,
      worktreePath: wt,
      dispatchId: "dispatch-gone",
      storyId: "gone-story",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    const decision = write(root, join(wt, "packages", "a", "x.ts"), seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("(assigned_story_missing)");
  });

  it("keeps refusing a blocked-only scope and a spawn", () => {
    const root = repo();
    const blocked = write(
      root,
      join(root, "packages", "a", "x.ts"),
      seams("live", {
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "Only a blocked brief exists.",
          denyKind: "zero-eligible-blocked" as const,
        }),
      }),
    );
    expect(blocked).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    const spawn = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "spawn_subagent", tool_input: { cwd: root, prompt: "implement" } },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      seams("live", {
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "no ready scope",
          denyKind: "multiple-eligible" as const,
        }),
      }),
    );
    expect(spawn).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });
});

describe("sites (c) and (e): the selected story's file_scope", () => {
  it("warns on a direct write outside file_scope that no project policy refuses", () => {
    const root = repo(["packages/a/**"]);
    const file = join(root, "packages", "b", "x.ts");
    const off = write(root, file, seams("off"));
    expect(off).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(off.message).toContain("story file_scope");
    const live = write(root, file, seams("live"));
    expect(live).toMatchObject({ verdict: "allow", code: "write-ready" });
    expectWarned(live, "story file_scope");
  });

  it("keeps refusing a write that project denyPaths refuses", () => {
    const root = repo(["packages/a/**"]);
    const decision = write(
      root,
      join(root, "packages", "a", "secret", "x.ts"),
      seams("live", {
        loadRuntimeAuthority: () =>
          resolveRuntimeAuthorityPolicy({
            enabled: true,
            denyPaths: ["packages/a/secret/**"],
            scopes: { edits: true, push: false, merge: false },
          }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("denyPaths");
  });

  it("keeps refusing a write that project allowPaths refuses", () => {
    const root = repo(["packages/a/**"]);
    const decision = write(
      root,
      join(root, "packages", "a", "x.ts"),
      seams("live", {
        loadRuntimeAuthority: () =>
          resolveRuntimeAuthorityPolicy({
            enabled: true,
            allowPaths: ["docs/**"],
            scopes: { edits: true, push: false, merge: false },
          }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("allowPaths");
  });

  it("warns when the selected scope has no positive governing allow", () => {
    const root = repo([]);
    const file = join(root, "packages", "a", "x.ts");
    const off = write(root, file, seams("off"));
    expect(off).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    const live = write(root, file, seams("live"));
    expect(live.verdict).toBe("allow");
    expect(live.message.startsWith("Warning:")).toBe(true);
  });
});

describe("site (d): the commit check", () => {
  it("refuses staged paths outside file_scope without the signal and warns with it", () => {
    const root = repo(["packages/a/**"]);
    stage(root, "packages/b/in.ts");
    const off = shell(root, "git commit -m x", seams("off"));
    expect(off).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    const live = shell(root, "git commit -m x", seams("live"));
    expect(live.verdict).toBe("allow");
    expectWarned(live, "staged path(s) outside governing file_scope");
  });

  it("warns on the index-snapshot word and still judges the staged set", () => {
    const root = repo(["packages/a/**"]);
    expect(shell(root, "git commit -am x", seams("off"))).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
    const live = shell(root, "git commit -am x", seams("live"));
    expectWarned(live, "change the file set after the pre-tool index snapshot");
    stage(root, "packages/b/in.ts");
    const both = shell(root, "git commit -am x", seams("live"));
    expectWarned(both, "change the file set after the pre-tool index snapshot");
    expect(both.message).toContain("staged path(s) outside governing file_scope");
  });

  it("judges the index-snapshot word on the checkout the commit names", () => {
    const root = repo(["packages/a/**"]);
    const wt = join(root, ".deft-scratch", "worktrees", "story-no-signal");
    mkdirSync(dirname(wt), { recursive: true });
    git(root, ["worktree", "add", "--detach", "-q", wt]);
    // The payload root has the trigger; the named checkout has none, so it has no signal.
    writeProjectDefinition(wt, { deliveryBranch: "master" });
    writeRunning(wt, "a-story.xbrief.json", ["packages/a/**"]);
    const decision = shell(root, `git -C "${wt}" commit -am x`, seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(decision.message).toContain("change the file set after the pre-tool index snapshot");
  });

  it("keeps refusing an unresolvable commit target", () => {
    const root = repo(["packages/a/**"]);
    const decision = shell(root, "cd $WT && git commit -m x", seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
  });

  it("returns the protected-store refusal when the command also writes one", () => {
    const root = repo(["packages/a/**"]);
    stage(root, "packages/b/in.ts");
    const command = "git commit -m x && echo grant > .deft/authz/grants.json";
    const decision = shell(root, command, seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "authz-uat-deny" });
    expect(decision.message).toContain("authz store");
  });
});

describe("shell writes and the read budget", () => {
  it("carries the warning of a recognized shell write to the final allow", () => {
    const root = repo(["packages/a/**"]);
    const command = `Set-Content -Path "${join(root, "packages", "b", "x.ts")}" -Value x`;
    expect(shell(root, command, seams("off"))).toMatchObject({ verdict: "deny" });
    const live = shell(root, command, seams("live"));
    expectWarned(live, "story file_scope");
  });

  it("shares one signal read across every gate check of one shell call", () => {
    const root = repo(["packages/a/**"]);
    const gh = ghFor("live");
    const enforce = {
      loadRuntimeAuthority: () =>
        resolveRuntimeAuthorityPolicy({
          enabled: true,
          shellDestForms: "enforce",
          scopes: { edits: true, push: false, merge: false },
        }),
      mergeGateRunGh: gh.run,
    };
    const command = `Set-Content -Path "${join(root, "packages", "b", "x.ts")}" -Value x`;
    const live = shell(root, command, seams("live", enforce));
    expect(live.verdict).toBe("allow");
    expect(live.message.startsWith("Warning:")).toBe(true);
    expect(gh.calls.filter((call) => call.includes("/contents/"))).toHaveLength(1);
    expect(gh.calls.filter((call) => call.includes("/rules/branches/"))).toHaveLength(1);
  });
});

describe("the floor stays fail-closed under the signal", () => {
  it("refuses occupancy-occupied", () => {
    const root = repo();
    applyWorktreeOccupancy(root, { sessionId: "someone-else", intent: "mutation" });
    const decision = write(root, join(root, "packages", "a", "x.ts"), seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });

  it("refuses tree-wide destructive git", () => {
    const root = repo();
    const decision = shell(root, "git reset --hard HEAD", seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "git-destructive-deny" });
  });

  it("refuses a write into a different repository", () => {
    const root = repo();
    const other = mkdtempSync(join(tmpdir(), "hook-6535-other-"));
    temps.push(other);
    git(other, ["init", "-q"]);
    const decision = write(root, join(other, "x.ts"), seams("live"));
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
  });
});

describe("rendering and records", () => {
  it("carries the warning in each host's advisory field", () => {
    const root = repo();
    const live = write(root, join(root, "packages", "a", "x.ts"), seams("live", staleRitual()));
    expectWarned(live, STALE_MESSAGE);
    const grok = JSON.parse(renderHostDecision("grok", live)) as { reason: string };
    expect(grok.reason).toContain("Warning:");
    expect(grok.reason).toContain(STALE_MESSAGE);
    const cursor = JSON.parse(renderHostDecision("cursor", live)) as { agent_message: string };
    expect(cursor.agent_message).toContain(STALE_MESSAGE);
    for (const host of ["claude", "codex"] as const) {
      const out = JSON.parse(renderHostDecision(host, live)) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(out.hookSpecificOutput.additionalContext).toContain(STALE_MESSAGE);
    }
  });

  it("records nothing under .deft/", () => {
    const root = repo();
    write(root, join(root, "packages", "a", "x.ts"), seams("live", staleRitual()));
    expect(existsSync(join(root, ".deft", "merge-gate-enforcement"))).toBe(false);
    expect(existsSync(join(root, ".deft", "merge-gate-signal.json"))).toBe(false);
  });
});
