/**
 * #6376: a direct write whose every target is outside every checkout skips the
 * payload root's occupancy lease and gated session ritual; every other write is
 * judged as before, and ritual denials name the judged checkout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_AUTHORITY_POLICY } from "../policy/runtime-authority.js";
import { applyWorktreeOccupancy, occupancyPath } from "../session/occupancy.js";
import {
  decideHook,
  formatJudgedCheckoutRecovery,
  type HookDispatchInput,
  type HookPolicySeams,
} from "./index.js";
import { OUTSIDE_EVERY_CHECKOUT_READY_CODE } from "./outside-every-checkout.js";

let base = "";
let primary = "";
let wtA = "";
let foreign = "";
let temp = "";
let home = "";

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.dev"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["commit", "--allow-empty", "-q", "-m", "base"]);
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "hook-6376-")));
  primary = join(base, "repos", "primary");
  wtA = join(base, "repos", "wt-a");
  foreign = join(base, "repos", "foreign");
  temp = join(base, "tmp");
  home = join(base, "home");
  initRepo(primary);
  git(primary, ["worktree", "add", "--detach", "-q", wtA]);
  initRepo(foreign);
  mkdirSync(temp, { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
}, 60_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(join(primary, ".deft", "occupancy.json"), { force: true });
  rmSync(join(primary, ".deft-directive-disable"), { force: true });
});

const STALE_MESSAGE =
  "session ritual state is stale (older than 8h). Run `deft session:start --rearm` to re-arm " +
  "(or `deft session:start` for a full cold ceremony).";

function staleSeams(overrides: Partial<HookPolicySeams> = {}): {
  ritualRoots: string[];
  scopeRoots: string[];
  seams: HookPolicySeams;
} {
  const ritualRoots: string[] = [];
  const scopeRoots: string[] = [];
  return {
    ritualRoots,
    scopeRoots,
    seams: {
      verifyRitual: (root) => {
        ritualRoots.push(resolve(root));
        return {
          code: 1,
          message: STALE_MESSAGE,
          tier: "gated",
          statePath: join(root, ".deft", "ritual-state.json"),
          bypassed: false,
          wouldFailCode: null,
          posture: "mutation" as const,
          ritualStateRequired: true,
          recoveryTier: "rearm",
          boundSessionId: "owner",
        };
      },
      inspectScope: (root) => {
        scopeRoots.push(resolve(root));
        return { ready: false, path: null, message: "no active scope xBRIEF" };
      },
      outsideEveryCheckout: {
        tmpdir: () => temp,
        homedir: () => home,
        runtimePackageDir: null,
      },
      ...overrides,
    },
  };
}

function write(
  target: string,
  environ: NodeJS.ProcessEnv = { DEFT_SESSION_ID: "owner" },
  tool = "Write",
): HookDispatchInput {
  return {
    host: "grok",
    event: "tool.before",
    projectRoot: primary,
    payload: { tool_name: tool, cwd: primary, tool_input: { file_path: target } },
    environ,
  };
}

function patch(paths: readonly string[]): HookDispatchInput {
  const [first, ...rest] = paths;
  return {
    host: "grok",
    event: "tool.before",
    projectRoot: primary,
    payload: {
      tool_name: "ApplyPatch",
      tool_input: {
        path: first,
        patch: `*** Begin Patch\n${rest.map((p) => `*** Update File: ${p}\n+x\n`).join("")}*** End Patch`,
      },
    },
    environ: { DEFT_SESSION_ID: "owner" },
  };
}

function foreignLease(): void {
  applyWorktreeOccupancy(primary, {
    primaryClaimException: "operator-default-branch",
    sessionId: "payload-owner",
    intent: "mutation",
  });
}

describe("writes in the class (#6376)", () => {
  it("allows a Write to the OS temp directory under a stale payload-root ritual", () => {
    const { ritualRoots, scopeRoots, seams } = staleSeams();
    const decision = decideHook(write(join(temp, "note.md")), seams);
    expect(decision).toMatchObject({ verdict: "allow", code: OUTSIDE_EVERY_CHECKOUT_READY_CODE });
    expect(ritualRoots).toEqual([]);
    expect(scopeRoots).toEqual([]);
  });

  it("allows a Write to an ordinary folder under the home directory", () => {
    const { seams } = staleSeams();
    const decision = decideHook(write(join(home, "notes", "n.md")), seams);
    expect(decision).toMatchObject({ verdict: "allow", code: OUTSIDE_EVERY_CHECKOUT_READY_CODE });
  });

  it("allows it under another session's live lease and adds no product-mutation marker", () => {
    foreignLease();
    const before = readFileSync(occupancyPath(primary), "utf8");
    const { seams } = staleSeams();
    const decision = decideHook(write(join(temp, "n.md"), { DEFT_SESSION_ID: "other" }), seams);
    expect(decision).toMatchObject({ verdict: "allow", code: OUTSIDE_EVERY_CHECKOUT_READY_CODE });
    const after = JSON.parse(readFileSync(occupancyPath(primary), "utf8")) as Record<
      string,
      unknown
    >;
    const prior = JSON.parse(before) as Record<string, unknown>;
    expect(after.product_mutation ?? null).toEqual(prior.product_mutation ?? null);
    expect(after.session_id).toBe(prior.session_id);
  });

  it("has no posture condition: requirements posture is allowed and asks no scope", () => {
    const { scopeRoots, seams } = staleSeams();
    const decision = decideHook(
      write(join(temp, "r.md"), { DEFT_SESSION_ID: "owner", DEFT_SESSION_POSTURE: "requirements" }),
      seams,
    );
    expect(decision).toMatchObject({ verdict: "allow", code: OUTSIDE_EVERY_CHECKOUT_READY_CODE });
    expect(scopeRoots).toEqual([]);
  });

  it("allows a patch whose every target is in the class", () => {
    const { seams } = staleSeams();
    const decision = decideHook(patch([join(temp, "a.md"), join(temp, "b.md")]), seams);
    expect(decision).toMatchObject({ verdict: "allow", code: OUTSIDE_EVERY_CHECKOUT_READY_CODE });
  });
});

describe("the gates that still run on a write in the class (#6376)", () => {
  it("keeps the kill switch and the read-only deny", () => {
    const killed = staleSeams({
      detectDeftDirectiveDisable: (() => ({
        active: true,
      })) as unknown as HookPolicySeams["detectDeftDirectiveDisable"],
    });
    expect(decideHook(write(join(temp, "k.md")), killed.seams).code).toBe("directive-disabled");
    const { seams } = staleSeams();
    const readOnly = decideHook(
      write(join(temp, "k.md"), { DEFT_SESSION_ID: "owner", DEFT_HOOK_READ_ONLY: "1" }),
      seams,
    );
    expect(readOnly).toMatchObject({ verdict: "deny", code: "read-only-deny" });
  });

  it("keeps the mutation intent ceiling", () => {
    const { seams } = staleSeams();
    const decision = decideHook(
      write(join(temp, "i.md"), { DEFT_SESSION_ID: "owner", DEFT_SESSION_SLASH_VERB: "triage" }),
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "intent-ceiling-deny" });
  });

  it("keeps runtime authority on the payload root", () => {
    const { seams } = staleSeams({
      loadRuntimeAuthority: () => ({
        ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
        enabled: true,
        scopes: { edits: false, push: false, merge: false },
      }),
    });
    const decision = decideHook(write(join(temp, "e.md")), seams);
    expect(decision.verdict).toBe("deny");
    expect(decision.code).not.toBe(OUTSIDE_EVERY_CHECKOUT_READY_CODE);
  });
});

describe("writes out of the class are judged as today (#6376)", () => {
  it("denies a target inside the payload root on the stale ritual", () => {
    const { ritualRoots, seams } = staleSeams();
    const decision = decideHook(write(join(primary, "src", "a.ts")), seams);
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(ritualRoots).toEqual([resolve(primary)]);
  });

  it("denies a target inside a linked worktree on that worktree's ritual", () => {
    const { ritualRoots, seams } = staleSeams();
    const decision = decideHook(write(join(wtA, "src", "a.ts")), seams);
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(ritualRoots).toEqual([resolve(wtA)]);
    expect(decision.message).toContain(`Judged checkout: ${resolve(wtA)}`);
  });

  it("adds no deny: a no-toplevel target out of the class keeps today's lease deny", () => {
    foreignLease();
    const { seams } = staleSeams();
    const target = join(temp, "deft-notes", "n.md");
    const decision = decideHook(write(target, { DEFT_SESSION_ID: "other" }), seams);
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });

  it("judges a patch with one member out of the class as today", () => {
    const { ritualRoots, seams } = staleSeams();
    const decision = decideHook(patch([join(primary, "src", "a.ts"), join(temp, "b.md")]), seams);
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(ritualRoots).toEqual([resolve(primary)]);
  });

  it("keeps admitMutationTargetSet first: a foreign-repository member still refuses", () => {
    const { seams } = staleSeams();
    const decision = decideHook(patch([join(temp, "a.md"), join(foreign, "src", "b.ts")]), seams);
    expect(decision).toMatchObject({ verdict: "deny", code: "foreign-repository-deny" });
  });

  it("does not reach MCP-shaped writes", () => {
    const { seams } = staleSeams();
    const decision = decideHook(
      write(join(temp, "m.md"), undefined, "tasks__search_replace"),
      seams,
    );
    expect(decision.code).not.toBe(OUTSIDE_EVERY_CHECKOUT_READY_CODE);
  });
});

describe("ritual recovery names the judged checkout (#6376 item 10)", () => {
  it("prints one session:start command with --project-root for the judged checkout", () => {
    const { seams } = staleSeams();
    const decision = decideHook(write(join(primary, "src", "a.ts")), seams);
    expect(decision.message).toContain(`Judged checkout: ${resolve(primary)}.`);
    const commands = decision.message.match(/--project-root=/g) ?? [];
    expect(commands).toHaveLength(1);
    expect(decision.message).toContain(
      `deft session:start --rearm --session-id=owner --project-root=${resolve(primary)}`,
    );
    expect(existsSync(resolve(primary))).toBe(true);
  });

  it("quotes a path with spaces, omits an unsafe session id, and keeps stripped text", () => {
    expect(formatJudgedCheckoutRecovery("Run `deft session:start`.", "/a b/c", "cold", "")).toBe(
      "Run `deft session:start`. Judged checkout: /a b/c. Recovery for that checkout " +
        '(runs as printed from any directory): `deft session:start --project-root="/a b/c"`.',
    );
    expect(formatJudgedCheckoutRecovery("Occupied by another session.", "/r", "rearm", "s1")).toBe(
      "Occupied by another session. Judged checkout: /r.",
    );
  });
});
