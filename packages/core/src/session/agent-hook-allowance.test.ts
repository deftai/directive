import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentHookHostEntry,
  decideAgentHookTimeoutAllowance,
  nextAgentHookHostEntry,
  readAgentHookHostEntries,
  registrationDigest,
  resolveAgentHookAllowanceGraceMs,
  takeAgentHookTimeoutAllowance,
} from "./agent-hook-allowance.js";
import {
  mergeSameOwnerRitualPayload,
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  withRitualStateLock,
  writeRitualState,
} from "./ritual-sentinel.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

const T0 = new Date("2026-11-27T10:00:00Z");
const minutesAfter = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const IDENTITY = { path: "/bin/deft-hook", size: 10, mtimeMs: 1_000 };
const CURRENT = { identity: IDENTITY, registrationDigest: "digest-a" };

function functionalEntry(now = T0): AgentHookHostEntry {
  return nextAgentHookHostEntry(
    null,
    { status: "functional", ok: true, identity: IDENTITY, registrationDigest: "digest-a" },
    now,
  );
}

function plant(hosts: Record<string, AgentHookHostEntry>): string {
  const root = resolve(mkdtempSync(join(tmpdir(), "allowance-")));
  temps.push(root);
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId: "s1",
      gitHead: "abc",
      worktreePath: root,
      startedAt: T0,
      gatedSteps: { agent_hooks: { ...ritualStep({ ok: true, ts: T0 }), hosts } },
    }),
  );
  return root;
}

describe("per-host agent_hooks entries (#7416)", () => {
  it("only a functional result opens the allowance, and a timeout never renews it", () => {
    const opened = functionalEntry();
    expect(opened.allowance_open).toBe(true);
    const timedOut = nextAgentHookHostEntry(
      opened,
      { status: "timed-out", ok: true, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(5),
    );
    expect(timedOut.allowance_open).toBe(false);
    expect(timedOut.functional).toEqual(opened.functional);
    expect(timedOut.functional?.ts).toBe(T0.toISOString());
  });

  it.each([
    "non-functional",
    "unavailable",
    "structural",
  ] as const)("a %s result closes the allowance until a new functional result", (status) => {
    const closed = nextAgentHookHostEntry(
      functionalEntry(),
      { status, ok: false, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(1),
    );
    expect(closed.allowance_open).toBe(false);
    // functional, then failure, then timeout: the timeout cannot be admitted.
    const afterTimeout = nextAgentHookHostEntry(
      closed,
      { status: "timed-out", ok: false, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(2),
    );
    expect(
      decideAgentHookTimeoutAllowance(afterTimeout, CURRENT, minutesAfter(3), 60_000_000),
    ).toMatchObject({ admit: false });
    const reopened = nextAgentHookHostEntry(
      afterTimeout,
      { status: "functional", ok: true, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(4),
    );
    expect(reopened.allowance_open).toBe(true);
    expect(
      decideAgentHookTimeoutAllowance(reopened, CURRENT, minutesAfter(5), 60_000_000),
    ).toMatchObject({ admit: true });
  });

  it("an unreadable command identity never opens an allowance", () => {
    const entry = nextAgentHookHostEntry(
      null,
      { status: "functional", ok: true, identity: null, registrationDigest: "digest-a" },
      T0,
    );
    expect(entry.allowance_open).toBe(false);
  });

  it("derives the grace window from the ritual freshness window", () => {
    const root = resolve(mkdtempSync(join(tmpdir(), "allowance-grace-")));
    temps.push(root);
    expect(resolveAgentHookAllowanceGraceMs(root)).toBe(8 * 60 * 60 * 1000);
  });

  it("registrationDigest is per host and changes with the registration", () => {
    const base = {
      host: "claude",
      path: ".claude/settings.json",
      status: "healthy",
      detail: "ok",
    } as never;
    const drifted = { ...(base as object), detail: "other" } as never;
    expect(registrationDigest("claude", [base])).toBe(registrationDigest("claude", [base]));
    expect(registrationDigest("claude", [base])).not.toBe(registrationDigest("claude", [drifted]));
    expect(registrationDigest("grok", [base])).toBeNull();
  });
});

describe("decideAgentHookTimeoutAllowance (#7416)", () => {
  const grace = 60 * 60 * 1000;
  const admit = (entry: AgentHookHostEntry | null, now: Date, current = CURRENT) =>
    decideAgentHookTimeoutAllowance(entry, current, now, grace).admit;

  it("admits one timeout inside the window on an unchanged identity and digest", () => {
    expect(admit(functionalEntry(), minutesAfter(10))).toBe(true);
  });

  it("blocks with no earlier functional record", () => {
    expect(admit(null, minutesAfter(1))).toBe(false);
  });

  it("blocks on a changed hook-command identity, registration digest, or an expired window", () => {
    expect(
      admit(functionalEntry(), minutesAfter(10), {
        ...CURRENT,
        identity: { ...IDENTITY, size: 11 },
      }),
    ).toBe(false);
    expect(
      admit(functionalEntry(), minutesAfter(10), {
        ...CURRENT,
        identity: { ...IDENTITY, mtimeMs: 2 },
      }),
    ).toBe(false);
    expect(admit(functionalEntry(), minutesAfter(10), { ...CURRENT, identity: null })).toBe(false);
    expect(
      admit(functionalEntry(), minutesAfter(10), { ...CURRENT, registrationDigest: "digest-b" }),
    ).toBe(false);
    expect(admit(functionalEntry(), minutesAfter(60))).toBe(false);
  });
});

describe("takeAgentHookTimeoutAllowance (#7416)", () => {
  const grace = 8 * 60 * 60 * 1000;

  it("admits at most one of two same-host timeouts and preserves other hosts", () => {
    const grok = nextAgentHookHostEntry(
      null,
      { status: "non-functional", ok: false, identity: IDENTITY, registrationDigest: "g" },
      T0,
    );
    const root = plant({ claude: functionalEntry(), grok });
    const first = takeAgentHookTimeoutAllowance(root, "claude", CURRENT, minutesAfter(1), grace);
    const second = takeAgentHookTimeoutAllowance(root, "claude", CURRENT, minutesAfter(1), grace);
    expect(first).toMatchObject({ admitted: true, saveFailed: false });
    expect(second).toMatchObject({ admitted: false, saveFailed: false });
    const [state] = readRitualState(root);
    const hosts = readAgentHookHostEntries(state?.gatedSteps.agent_hooks);
    expect(hosts.claude).toMatchObject({ status: "timed-out", allowance_open: false });
    expect(hosts.claude?.functional?.ts).toBe(T0.toISOString());
    expect(hosts.grok).toEqual(grok);
  });

  it("refuses when the host entry is closed or missing", () => {
    const closed = nextAgentHookHostEntry(
      functionalEntry(),
      { status: "non-functional", ok: false, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(1),
    );
    const root = plant({ claude: closed });
    expect(
      takeAgentHookTimeoutAllowance(root, "claude", CURRENT, minutesAfter(2), grace).admitted,
    ).toBe(false);
    expect(
      takeAgentHookTimeoutAllowance(root, "grok", CURRENT, minutesAfter(2), grace).admitted,
    ).toBe(false);
  });

  it("does not let a Claude functional entry admit a Grok timeout", () => {
    const root = plant({ claude: functionalEntry() });
    const take = takeAgentHookTimeoutAllowance(root, "grok", CURRENT, minutesAfter(1), grace);
    expect(take.admitted).toBe(false);
    const [state] = readRitualState(root);
    expect(readAgentHookHostEntries(state?.gatedSteps.agent_hooks).claude?.allowance_open).toBe(
      true,
    );
  });

  it("refuses the write when the allowance step cannot be saved", () => {
    const root = plant({ claude: functionalEntry() });
    // The ritual lock is held (non-reentrant), so the step cannot take it.
    const take = withRitualStateLock(root, () =>
      takeAgentHookTimeoutAllowance(root, "claude", CURRENT, minutesAfter(1), grace, {
        acquisitionBudgetMs: 1,
      }),
    );
    expect(take).toMatchObject({ admitted: false, saveFailed: true });
    const [state] = readRitualState(root);
    expect(readAgentHookHostEntries(state?.gatedSteps.agent_hooks).claude?.allowance_open).toBe(
      true,
    );
  });
});

describe("per-host merge (#7416)", () => {
  it("keeps other hosts' entries and lets the newer entry win for the same host", () => {
    const older = functionalEntry(T0);
    const newer = nextAgentHookHostEntry(
      older,
      { status: "non-functional", ok: false, identity: IDENTITY, registrationDigest: "digest-a" },
      minutesAfter(5),
    );
    const grokEntry = functionalEntry(minutesAfter(2));
    const disk = {
      gated_steps: {
        agent_hooks: {
          ...ritualStep({ ok: true, ts: T0 }),
          hosts: { claude: newer, grok: grokEntry },
        },
      },
    };
    const staleIncoming = {
      gated_steps: {
        agent_hooks: { ...ritualStep({ ok: true, ts: T0 }), hosts: { claude: older } },
      },
    };
    const merged = mergeSameOwnerRitualPayload(disk, staleIncoming);
    const hosts = readAgentHookHostEntries(
      (merged.gated_steps as Record<string, Record<string, unknown>>).agent_hooks,
    );
    expect(hosts.claude).toEqual(newer);
    expect(hosts.grok).toEqual(grokEntry);
  });

  it("keeps the disk host entries when the incoming step carries none", () => {
    const disk = {
      gated_steps: {
        agent_hooks: { ...ritualStep({ ok: true, ts: T0 }), hosts: { claude: functionalEntry() } },
      },
    };
    const incoming = {
      gated_steps: { agent_hooks: ritualStep({ ok: true, ts: minutesAfter(1) }) },
    };
    const merged = mergeSameOwnerRitualPayload(disk, incoming);
    const hosts = readAgentHookHostEntries(
      (merged.gated_steps as Record<string, Record<string, unknown>>).agent_hooks,
    );
    expect(Object.keys(hosts)).toEqual(["claude"]);
  });
});
