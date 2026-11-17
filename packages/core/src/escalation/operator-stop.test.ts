import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatorStopCommands } from "./operator-notify.js";
import {
  formatOperatorCommand,
  formatOperatorStopBody,
  notifyOperatorIfEnabled,
  type OperatorStopInput,
  quoteShellArg,
  recordOperatorStop,
} from "./operator-stop.js";
import { escalationsDir } from "./paths.js";
import { listOpenEscalations } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opstop-"));
  roots.push(root);
  return root;
}

function stop(root: string, overrides: Partial<OperatorStopInput> = {}): OperatorStopInput {
  return {
    projectRoot: root,
    kind: "mint",
    code: "authz-grant-missing",
    target: "edit:src/a.ts",
    sessionId: "s1",
    title: "Grant needed: edit on src/a.ts",
    commands: ["deft authz:grant -- --operations edit --confirm"],
    ...overrides,
  };
}

describe("recordOperatorStop (#6275 limb 1)", () => {
  it("records a mint as approval + dangerous with worktree and command, then spawns the notifier", () => {
    const root = tempRoot();
    const spawned: string[] = [];
    const outcome = recordOperatorStop(stop(root), {
      resolveChannel: () => "os",
      spawnNotifier: (r) => spawned.push(r),
    });
    expect(outcome.recorded).toBe(true);
    const [event] = listOpenEscalations(root);
    expect(event).toMatchObject({ type: "approval", dangerous: true, agentId: "s1" });
    expect(event?.body).toContain(`Worktree: ${resolve(root)}`);
    expect(operatorStopCommands(event?.body ?? "")).toEqual([
      "deft authz:grant -- --operations edit --confirm",
    ]);
    expect(spawned).toEqual([resolve(root)]);
  });

  it("records other steps as cmd_approval, not dangerous", () => {
    const root = tempRoot();
    const outcome = recordOperatorStop(stop(root, { kind: "step", code: "hotfix-label" }), {
      resolveChannel: () => "os",
      spawnNotifier: () => undefined,
    });
    expect(outcome).toMatchObject({
      recorded: true,
      event: { type: "cmd_approval", dangerous: false },
    });
  });

  it("uses an explicit agent id, and dedupes a session-less stop under 'none'", () => {
    const root = tempRoot();
    const deps = { resolveChannel: () => "os" as const, spawnNotifier: () => undefined };
    const input = stop(root, { sessionId: undefined, agentId: "worker-9" });
    expect(recordOperatorStop(input, deps)).toMatchObject({
      recorded: true,
      event: { agentId: "worker-9" },
    });
    expect(recordOperatorStop(stop(root, { sessionId: null }), deps)).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    const anonymous = stop(root, { sessionId: null, target: "other" });
    expect(recordOperatorStop(anonymous, deps)).toMatchObject({
      recorded: true,
      event: { agentId: "agent" },
    });
  });

  it("records a repeated identical stop once (code, target, session)", () => {
    const root = tempRoot();
    const deps = { resolveChannel: () => "os" as const, spawnNotifier: () => undefined };
    expect(recordOperatorStop(stop(root), deps).recorded).toBe(true);
    expect(recordOperatorStop(stop(root), deps)).toEqual({ recorded: false, reason: "duplicate" });
    expect(recordOperatorStop(stop(root, { sessionId: "s2" }), deps).recorded).toBe(true);
    expect(listOpenEscalations(root)).toHaveLength(2);
  });

  it("writes nothing while the notifier is off", () => {
    const root = tempRoot();
    let spawned = 0;
    const outcome = recordOperatorStop(stop(root), {
      resolveChannel: () => "off",
      spawnNotifier: () => {
        spawned += 1;
      },
    });
    expect(outcome).toEqual({ recorded: false, reason: "notifier-off" });
    expect(existsSync(escalationsDir(root))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(spawned).toBe(0);
  });

  it("writes nothing by default (no policy, no USER.md opt-in)", () => {
    const root = tempRoot();
    const outcome = recordOperatorStop(stop(root), { spawnNotifier: () => undefined });
    expect(outcome.recorded).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("swallows its own errors", () => {
    const root = tempRoot();
    // A file where the escalations directory must go makes the key write fail.
    writeFileSync(join(root, ".deft"), "not a directory");
    const outcome = recordOperatorStop(stop(root), {
      resolveChannel: () => "os",
      spawnNotifier: () => undefined,
    });
    expect(outcome).toMatchObject({ recorded: false, reason: "error" });
    const thrown = recordOperatorStop(stop(root), {
      resolveChannel: () => {
        throw new Error("boom");
      },
    });
    expect(thrown).toEqual({ recorded: false, reason: "error", error: "boom" });
  });
});

describe("operator command formatting", () => {
  it("quotes for PowerShell and POSIX", () => {
    expect(quoteShellArg("src/a.ts", "linux")).toBe("src/a.ts");
    expect(quoteShellArg("src/**", "linux")).toBe("'src/**'");
    expect(quoteShellArg("it's", "linux")).toBe("'it'\\''s'");
    expect(quoteShellArg("edit,push", "win32")).toBe("'edit,push'");
    expect(quoteShellArg("C:\\Repos\\x", "win32")).toBe("C:\\Repos\\x");
    expect(quoteShellArg("it's", "win32")).toBe("'it''s'");
    expect(quoteShellArg("", "linux")).toBe("''");
  });

  it("builds cd + deft verb with --confirm appended once", () => {
    const cmd = formatOperatorCommand({
      projectRoot: "/repo/wt",
      verb: "authz:grant",
      args: ["--", "--operations", "edit,push", "--surfaces", "src/**"],
      confirm: true,
      platform: "linux",
    });
    expect(cmd).toBe(
      `cd ${quoteShellArg(resolve("/repo/wt"), "linux")}; deft authz:grant -- --operations edit,push --surfaces 'src/**' --confirm`,
    );
    const again = formatOperatorCommand({
      projectRoot: "/repo",
      verb: "scope:record-approved-scope",
      args: ["--confirm"],
      confirm: true,
      platform: "linux",
    });
    expect(again.match(/--confirm/g)).toHaveLength(1);
    expect(formatOperatorCommand({ projectRoot: "/r", verb: "x:y", args: [] })).toMatch(
      /; deft x:y$/,
    );
  });

  it("formats the body with an optional note and one command per line", () => {
    const body = formatOperatorStopBody("/repo", ["a\nb", "  ", "c"], "Needs a hotfix label");
    expect(body.startsWith("Needs a hotfix label\n\nWorktree: ")).toBe(true);
    expect(operatorStopCommands(body)).toEqual(["a b", "c"]);
  });
});

describe("notifyOperatorIfEnabled", () => {
  it("spawns only when the channel is on and never throws", () => {
    const calls: string[] = [];
    expect(
      notifyOperatorIfEnabled("/r", {
        resolveChannel: () => "off",
        spawnNotifier: (r) => calls.push(r),
      }),
    ).toBe(false);
    expect(
      notifyOperatorIfEnabled("/r", {
        resolveChannel: () => "os",
        spawnNotifier: (r) => calls.push(r),
      }),
    ).toBe(true);
    expect(calls).toEqual(["/r"]);
    expect(
      notifyOperatorIfEnabled("/r", {
        resolveChannel: () => {
          throw new Error("x");
        },
      }),
    ).toBe(false);
  });
});
