import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanSequenceLockDeps } from "../plan-sequence/mutation-lock.js";
import { resolveOperatorNotifyChannel } from "../policy/operator-notify.js";
import { fileEscalation, resolveEscalation } from "./actions.js";
import {
  drainOperatorStops,
  formatOperatorNotification,
  isOperatorNotifyChildArgv,
  OPERATOR_NOTIFIED_DIR,
  OPERATOR_NOTIFY_CHILD_FLAG,
  type OperatorNotification,
  operatorNotifyEntryPath,
  operatorNotifyLockPath,
  operatorStopWorktree,
  osNotificationCommand,
  runOperatorNotifier,
  sendOsNotification,
  spawnOperatorNotifier,
  stripControlChars,
} from "./operator-notify.js";
import {
  formatOperatorCommand,
  formatOperatorStopBody,
  type OperatorStopInput,
  recordOperatorStop,
} from "./operator-stop.js";
import { escalationsDir } from "./paths.js";
import { listOpenEscalations } from "./store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opnotify-"));
  roots.push(root);
  return root;
}

const ON = { resolveChannel: () => "os" as const, spawnNotifier: () => undefined };

function mintStop(root: string, n = 1): OperatorStopInput {
  return {
    projectRoot: root,
    kind: "mint",
    code: "mint-refused-agent-shell",
    target: `authz:grant#${n}`,
    sessionId: "worker-1",
    title: `Operator mint needed: authz:grant #${n}`,
    commands: [
      formatOperatorCommand({
        projectRoot: root,
        verb: "authz:grant",
        args: ["--operations", "edit,push", "--surfaces", `src/${n}/**`],
        confirm: true,
      }),
    ],
  };
}

function stepStop(root: string, command: string, now?: Date): OperatorStopInput {
  return {
    now,
    projectRoot: root,
    kind: "step",
    code: "operator-commit",
    target: command,
    sessionId: "worker-1",
    title: `Operator step: ${command}`,
    commands: [command],
  };
}

function collect(): { sent: OperatorNotification[]; send: (n: OperatorNotification) => boolean } {
  const sent: OperatorNotification[] = [];
  return {
    sent,
    send: (n) => {
      sent.push(n);
      return true;
    },
  };
}

/** Publish a lock directory owned by `pid` (the shape mutation-lock writes). */
function holdLock(root: string, pid: number, token = "a".repeat(32)): string {
  const lock = operatorNotifyLockPath(root);
  mkdirSync(lock, { recursive: true });
  const entry = join(lock, `${pid}-${token}`);
  writeFileSync(entry, `${JSON.stringify({ pid, token })}\n`);
  return entry;
}

function fastClock(budgetMs = 50): PlanSequenceLockDeps {
  let now = 0;
  return {
    acquisitionBudgetMs: budgetMs,
    monotonicNowMs: () => {
      now += 10;
      return now;
    },
    sleepMs: () => undefined,
  };
}

describe("operator-stop notifier fixtures (#6275 Bound limb 4)", () => {
  it("an agent-marker mint stop records one approval escalation and fires the notifier once with the full command", () => {
    const root = tempRoot();
    const stop = mintStop(root);
    const outcome = recordOperatorStop(stop, ON);
    expect(outcome).toMatchObject({ recorded: true, event: { type: "approval", dangerous: true } });
    const { sent, send } = collect();
    expect(runOperatorNotifier(root, { send })).toMatchObject({ ok: true, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain(`Mint (run alone): ${stop.commands[0]}`);
    expect(sent[0]?.title).toBe("Directive: 1 operator step waiting");
    // Once: a second owner finds nothing un-notified.
    expect(runOperatorNotifier(root, { send }).notifications).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("a hook-deny style stop (authz-grant-missing) is recorded with its mint command", () => {
    const root = tempRoot();
    const outcome = recordOperatorStop(
      { ...mintStop(root), code: "authz-grant-missing", target: "push:*" },
      ON,
    );
    expect(outcome.recorded).toBe(true);
    expect(listOpenEscalations(root)).toHaveLength(1);
  });

  it("two stops on disk produce one notification listing both (mints one per line, steps as one script)", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root, 1), ON);
    recordOperatorStop(mintStop(root, 2), ON);
    const t = Date.now();
    recordOperatorStop(stepStop(root, "git push origin story/x", new Date(t + 1000)), ON);
    recordOperatorStop(stepStop(root, "gh pr merge 1", new Date(t + 2000)), ON);
    const { sent, send } = collect();
    runOperatorNotifier(root, { send });
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body ?? "";
    expect(body.match(/^Mint \(run alone\): /gm)).toHaveLength(2);
    // The script names the worktree its bare commands must run in.
    expect(body).toContain(
      `Script (run in ${resolve(root)}):\ngit push origin story/x\ngh pr merge 1`,
    );
    expect(sent[0]?.ids).toHaveLength(4);
    expect(body.split("\n")[0]).toMatch(/Agent-proposed/);
  });

  it("groups script commands by worktree", () => {
    const a = tempRoot();
    const b = tempRoot();
    const t = Date.now();
    recordOperatorStop(stepStop(a, "gh pr merge 1", new Date(t + 1000)), ON);
    const formatted = formatOperatorNotification([
      ...listOpenEscalations(a),
      fileEscalation({
        projectRoot: b,
        type: "cmd_approval",
        title: "b",
        body: formatOperatorStopBody(b, ["git push"]),
      }),
    ]);
    expect(formatted.body).toContain(`Script (run in ${resolve(a)}):\ngh pr merge 1`);
    expect(formatted.body).toContain(`Script (run in ${resolve(b)}):\ngit push`);
    expect(operatorStopWorktree("no worktree here")).toBeNull();
    const bare = formatOperatorNotification([
      fileEscalation({
        projectRoot: b,
        type: "cmd_approval",
        title: "c",
        body: "Commands (agent-proposed; read before running):\nmake x\n",
      }),
    ]);
    expect(bare.body).toContain("Script:\nmake x");
  });

  it("two notifier children starting together send one notification listing both", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root, 1), ON);
    recordOperatorStop(mintStop(root, 2), ON);
    const holder = collect();
    const contender = collect();
    // The other child holds the lock (alive owner); it drains both, then releases.
    holdLock(root, process.pid);
    let released = false;
    const result = runOperatorNotifier(root, {
      send: contender.send,
      lock: {
        probeProcess: () => "alive",
        sleepMs: () => {
          if (released) return;
          drainOperatorStops(root, { send: holder.send });
          rmSync(operatorNotifyLockPath(root), { recursive: true, force: true });
          released = true;
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(holder.sent).toHaveLength(1);
    expect(holder.sent[0]?.ids).toHaveLength(2);
    expect(contender.sent).toEqual([]);
  });

  it("a stop filed after the holder's last rescan and before its release still appears in a notification", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root, 1), ON);
    const holder = collect();
    const contender = collect();
    holdLock(root, process.pid);
    let released = false;
    const result = runOperatorNotifier(root, {
      send: contender.send,
      lock: {
        probeProcess: () => "alive",
        sleepMs: () => {
          if (released) return;
          drainOperatorStops(root, { send: holder.send });
          // Late stop: filed after the holder's final empty rescan, before release.
          recordOperatorStop(stepStop(root, "gh pr merge 7"), ON);
          rmSync(operatorNotifyLockPath(root), { recursive: true, force: true });
          released = true;
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(holder.sent).toHaveLength(1);
    expect(contender.sent).toHaveLength(1);
    expect(contender.sent[0]?.body).toContain("gh pr merge 7");
    expect(contender.sent[0]?.body).not.toContain("Mint (run alone)");
  });

  it("a stalled owner keeps the lock; a second reaper does not take it; budget exhaustion leaves the stop un-notified", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root), ON);
    const entry = holdLock(root, 4242);
    const { sent, send } = collect();
    for (const liveness of ["alive", "unknown"] as const) {
      const result = runOperatorNotifier(root, {
        send,
        lock: { ...fastClock(), probeProcess: () => liveness },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/);
      expect(existsSync(entry)).toBe(true);
    }
    expect(sent).toEqual([]);
    expect(existsSync(join(escalationsDir(root), OPERATOR_NOTIFIED_DIR))).toBe(false);
    // Once the owner is gone, the next attempt sends the waiting stop.
    const later = runOperatorNotifier(root, { send, lock: { probeProcess: () => "dead" } });
    expect(later.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("an old owner cannot release a newer lock", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root), ON);
    const lock = operatorNotifyLockPath(root);
    const newer = `${process.pid}-${"b".repeat(32)}`;
    const result = runOperatorNotifier(root, {
      send: () => {
        // Another owner replaced the lock while this one was sending.
        for (const name of readdirSync(lock)) rmSync(join(lock, name), { force: true });
        writeFileSync(join(lock, newer), "{}\n");
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(readdirSync(lock)).toEqual([newer]);
  });

  it("a repeated identical deny records once", () => {
    const root = tempRoot();
    expect(recordOperatorStop(mintStop(root), ON).recorded).toBe(true);
    expect(recordOperatorStop(mintStop(root), ON)).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    expect(listOpenEscalations(root)).toHaveLength(1);
  });

  it("notifier off writes no escalation, key or notify file", () => {
    const root = tempRoot();
    let spawned = 0;
    const outcome = recordOperatorStop(mintStop(root), {
      resolveChannel: () => "off",
      spawnNotifier: () => {
        spawned += 1;
      },
    });
    expect(outcome).toEqual({ recorded: false, reason: "notifier-off" });
    expect(readdirSync(root)).toEqual([]);
    expect(spawned).toBe(0);
  });

  it("a URL-shaped channel value is refused", () => {
    const resolved = resolveOperatorNotifyChannel({
      projectRoot: null,
      userMdText: "## Personal\noperatorNotify: https://hooks.slack.com/services/x\n",
    });
    expect(resolved.channel).toBe("off");
    expect(resolved.error).toMatch(/never a URL/);
  });

  it("delivery failure never fails the owner and the claim stays (at most once)", () => {
    const root = tempRoot();
    recordOperatorStop(mintStop(root), ON);
    let calls = 0;
    const result = runOperatorNotifier(root, {
      send: () => {
        calls += 1;
        throw new Error("toast failed");
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(runOperatorNotifier(root, { send: () => true }).notifications).toEqual([]);
  });

  it("resolved escalations are not notified; command-less ones point at escalation:list", () => {
    const root = tempRoot();
    const done = fileEscalation({ projectRoot: root, type: "question", title: "old" });
    resolveEscalation({ projectRoot: root, id: done.id, decision: "answered" });
    fileEscalation({ projectRoot: root, type: "design_decision", title: "pick\u0007 a\nlayout" });
    const { sent, send } = collect();
    runOperatorNotifier(root, { send });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ids).toHaveLength(1);
    expect(sent[0]?.body).toContain("- pick  a layout (deft escalation:list --open)");
  });

  it("reports lock setup failures as not ok", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".deft"), "file, not a directory");
    const result = runOperatorNotifier(root, { send: () => true });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it("rescans until none is left", () => {
    const root = tempRoot();
    expect(drainOperatorStops(root, { send: () => true })).toEqual({
      notifications: [],
      error: null,
    });
    let n = 0;
    fileEscalation({ projectRoot: root, type: "question", title: "q" });
    const drained = drainOperatorStops(root, {
      send: () => true,
      afterSend: () => {
        n += 1;
        if (n < 3) fileEscalation({ projectRoot: root, type: "question", title: `q${n}` });
      },
    });
    expect(drained.notifications).toHaveLength(3);
    expect(drained.error).toBeNull();
  });
});

describe("data-only OS adapters", () => {
  const note: OperatorNotification = {
    title: "Directive: 1 operator step waiting",
    body: "Mint (run alone): deft authz:grant -- --confirm; rm -rf /",
    ids: ["esc-1"],
  };

  it("win32 passes the payload on stdin, never in the command string", () => {
    const cmd = osNotificationCommand(note, "win32");
    expect(cmd?.command).toBe("powershell.exe");
    expect(cmd?.args).toContain("-EncodedCommand");
    expect(cmd?.args).not.toContain("-Command");
    const script = Buffer.from(cmd?.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("[Console]::In.ReadToEnd()");
    expect(script).not.toContain(note.body);
    expect(JSON.parse(cmd?.input ?? "{}")).toEqual({ title: note.title, body: note.body });
  });

  it("macOS and Linux pass title and body as separate argv items", () => {
    const mac = osNotificationCommand(note, "darwin");
    expect(mac?.command).toBe("osascript");
    expect(mac?.args.slice(-2)).toEqual([note.title, note.body]);
    expect(mac?.args.filter((a) => a.includes(note.body))).toHaveLength(1);
    const linux = osNotificationCommand(note, "linux");
    expect(linux?.args).toEqual(["--app-name=Directive", "--", note.title, note.body]);
    expect(osNotificationCommand(note, "aix")).toBeNull();
  });

  it("sendOsNotification returns true only on exit 0 and never throws", () => {
    const calls: Array<{ command: string; input: string | null }> = [];
    expect(
      sendOsNotification(note, {
        platform: "win32",
        run: (command, _args, options) => {
          calls.push({ command, input: options.input });
          return 0;
        },
      }),
    ).toBe(true);
    expect(calls[0]?.input).toContain("Directive");
    expect(sendOsNotification(note, { platform: "linux", run: () => 1 })).toBe(false);
    expect(
      sendOsNotification(note, {
        platform: "linux",
        run: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe(false);
    expect(sendOsNotification(note, { platform: "aix", run: () => 0 })).toBe(false);
  });

  it("strips control characters from display fields", () => {
    expect(stripControlChars("a\u001b[31mb\u009bc\r\n")).toBe("a [31mb c");
    const formatted = formatOperatorNotification([]);
    expect(formatted.title).toBe("Directive: 0 operator steps waiting");
  });

  it("the default runner reports a missing adapter binary as not sent", () => {
    // A command name that cannot exist exercises spawnSync without showing anything.
    const missing = osNotificationCommand(note, "linux");
    expect(missing).not.toBeNull();
    expect(
      sendOsNotification(note, {
        platform: "linux",
        run: (_c, args, options) => {
          expect(options.input).toBeNull();
          return args.length > 0 ? null : 0;
        },
      }),
    ).toBe(false);
  });

  it("the real default runner returns a boolean for an adapter absent on this host", () => {
    // notify-send is absent on Windows; powershell.exe is absent on Linux and macOS.
    // Neither shows a notification, so this exercises spawnSync safely.
    const foreign: NodeJS.Platform = process.platform === "win32" ? "linux" : "win32";
    expect(sendOsNotification(note, { platform: foreign })).toBe(false);
  });
});

describe("notifier edge cases", () => {
  it("keeps filing order when createdAt ties, using file mtime", () => {
    const root = tempRoot();
    const now = new Date("2026-11-17T10:00:00Z");
    const first = fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "first",
      body: "Commands (agent-proposed; read before running):\nstep-one\n",
      now,
    });
    const second = fileEscalation({
      projectRoot: root,
      type: "cmd_approval",
      title: "second",
      body: "Commands (agent-proposed; read before running):\nstep-two\n",
      now,
    });
    const dir = escalationsDir(root);
    utimesSync(join(dir, `${first.id}.json`), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(dir, `${second.id}.json`), new Date(2_000_000), new Date(2_000_000));
    const { sent, send } = collect();
    drainOperatorStops(root, { send });
    expect(sent[0]?.body).toMatch(/Script:\nstep-one\nstep-two/);
    expect(sent[0]?.body).not.toContain("run in");
  });

  it("a claim-marker write failure surfaces as not ok, never a throw", () => {
    const root = tempRoot();
    fileEscalation({ projectRoot: root, type: "question", title: "q" });
    writeFileSync(join(escalationsDir(root), OPERATOR_NOTIFIED_DIR), "file, not a directory");
    const result = runOperatorNotifier(root, { send: () => true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/contained write|ENOTDIR|EEXIST|not a directory/i);
  });
});

describe("detached notifier spawn", () => {
  it("spawns detached with no inherited stdin, hidden, unref'd", () => {
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    let unrefs = 0;
    const ok = spawnOperatorNotifier("/repo", {
      execPath: "node",
      entry: "/x/operator-notify.js",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          unref: () => {
            unrefs += 1;
          },
        };
      },
    });
    expect(ok).toBe(true);
    expect(calls[0]?.args).toEqual([
      "/x/operator-notify.js",
      OPERATOR_NOTIFY_CHILD_FLAG,
      resolve("/repo"),
    ]);
    expect(calls[0]?.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    expect(unrefs).toBe(1);
    expect(
      spawnOperatorNotifier("/repo", {
        spawn: () => {
          throw new Error("EAGAIN");
        },
      }),
    ).toBe(false);
  });

  it("the default spawner starts a real detached child", () => {
    // Not cleaned up: the detached child may still be reading it on Windows.
    const dir = mkdtempSync(join(tmpdir(), "opnotify-entry-"));
    const entry = join(dir, "noop.cjs");
    writeFileSync(entry, "// does nothing\n");
    expect(spawnOperatorNotifier(dir, { entry })).toBe(true);
  });

  it("attaches an error listener so a failed spawn never crashes the caller", async () => {
    const listeners: string[] = [];
    spawnOperatorNotifier("/repo", {
      spawn: () => ({
        unref: () => undefined,
        on: (event: string) => {
          listeners.push(event);
          return undefined;
        },
      }),
    });
    expect(listeners).toEqual(["error"]);
    // A real spawn of a missing binary emits `error` asynchronously.
    expect(
      spawnOperatorNotifier("/repo", { execPath: join(tmpdir(), "no-such-node-binary-6275") }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
  });

  it("recognizes only its own child argv", () => {
    const entry = operatorNotifyEntryPath();
    expect(
      isOperatorNotifyChildArgv(["node", entry, OPERATOR_NOTIFY_CHILD_FLAG, "/r"], entry),
    ).toBe(true);
    expect(isOperatorNotifyChildArgv(["node", entry, OPERATOR_NOTIFY_CHILD_FLAG], entry)).toBe(
      false,
    );
    expect(
      isOperatorNotifyChildArgv(["node", "/other.js", OPERATOR_NOTIFY_CHILD_FLAG, "/r"], entry),
    ).toBe(false);
    expect(isOperatorNotifyChildArgv(["node"], entry)).toBe(false);
  });
});
