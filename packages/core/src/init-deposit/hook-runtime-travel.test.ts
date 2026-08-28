import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import type { PinReadResult } from "../resolution/pin.js";
import { AGENT_HOOK_PATHS, writeAgentHookDeposit } from "./agent-hooks.js";
import {
  FAIL_CLOSED_HOOK_HOSTS,
  type HookRegistrationRef,
  type HookRuntimeTravelSeams,
  inspectHookRuntimeTravel,
  RUNTIME_ANCHOR_MANIFEST,
} from "./hook-runtime-travel.js";

const CURSOR_REGISTRATION = ".cursor/hooks.json";
const CLAUDE_REGISTRATION = ".claude/settings.json";

const REGISTRATIONS: readonly HookRegistrationRef[] = [
  { host: "claude", path: CLAUDE_REGISTRATION },
  { host: "cursor", path: CURSOR_REGISTRATION },
];

const NO_PIN: PinReadResult = {
  pinVersion: null,
  rawSpec: null,
  isPrivate: false,
  nonExact: false,
};

const EXACT_PIN: PinReadResult = {
  pinVersion: "0.9.1",
  rawSpec: "0.9.1",
  isPrivate: false,
  nonExact: false,
};

const RANGE_PIN: PinReadResult = {
  pinVersion: null,
  rawSpec: "^0.9.0",
  isPrivate: false,
  nonExact: true,
};

function seams(tracked: readonly string[] | null, pin: PinReadResult): HookRuntimeTravelSeams {
  return {
    gitLsFiles: () => (tracked === null ? null : `${tracked.join("\n")}\n`),
    readPin: () => pin,
  };
}

function inspect(
  tracked: readonly string[] | null,
  pin: PinReadResult,
  registrations: readonly HookRegistrationRef[] = REGISTRATIONS,
  policy = DEFAULT_HOST_HOOKS_POLICY,
) {
  return inspectHookRuntimeTravel("/repo", registrations, policy, seams(tracked, pin));
}

describe("inspectHookRuntimeTravel", () => {
  it("warns when a tracked registration names a runtime no clone can obtain", () => {
    const result = inspect([CURSOR_REGISTRATION], NO_PIN);

    expect(result.trackedRegistrations).toEqual([CURSOR_REGISTRATION]);
    expect(result.failClosedRegistrations).toEqual([CURSOR_REGISTRATION]);
    expect(result.runtimeTravels).toBe(false);
    expect(result.warning).toContain("#3785");
    expect(result.warning).toContain(`${CURSOR_REGISTRATION} (fail-closed)`);
    expect(result.warning).toContain("exit 127");
  });

  it("names the disable verb as the recovery and forbids the failClosed hand-edit", () => {
    const warning = inspect([CURSOR_REGISTRATION], NO_PIN).warning ?? "";

    expect(warning).toContain("policy:disable-host-hooks");
    expect(warning).toContain("--host cursor --confirm");
    // #3785 prohibition: the hand-edit works once and the next `deft update`
    // silently re-arms the lockout, so the copy must warn against it.
    expect(warning).toContain("Do not hand-edit `failClosed`");
    expect(warning).toContain("`deft update` restores it");
  });

  it("stays silent when a committed manifest lets a clone install the runtime", () => {
    const result = inspect([CURSOR_REGISTRATION, RUNTIME_ANCHOR_MANIFEST], EXACT_PIN);

    expect(result.runtimeTravels).toBe(true);
    expect(result.warning).toBeNull();
  });

  it("accepts a range spec as reconstitution: npm install still resolves the runtime", () => {
    const result = inspect([CURSOR_REGISTRATION, RUNTIME_ANCHOR_MANIFEST], RANGE_PIN);

    expect(result.runtimeTravels).toBe(true);
    expect(result.warning).toBeNull();
  });

  it("warns when the manifest declares the dependency but is not itself tracked", () => {
    const result = inspect([CURSOR_REGISTRATION], EXACT_PIN);

    expect(result.runtimeTravels).toBe(false);
    expect(result.warning).not.toBeNull();
  });

  it("stays silent when no registration is tracked", () => {
    const result = inspect([RUNTIME_ANCHOR_MANIFEST], NO_PIN);

    expect(result.trackedRegistrations).toEqual([]);
    expect(result.warning).toBeNull();
  });

  it("stays silent when git cannot answer the tracked-ness question", () => {
    const result = inspect(null, NO_PIN);

    expect(result.trackedRegistrations).toEqual([]);
    expect(result.warning).toBeNull();
  });

  it("excludes hosts whose deposit is disabled: a stripped registration denies nothing", () => {
    const result = inspect([CURSOR_REGISTRATION], NO_PIN, REGISTRATIONS, {
      ...DEFAULT_HOST_HOOKS_POLICY,
      cursor: false,
    });

    expect(result.trackedRegistrations).toEqual([]);
    expect(result.warning).toBeNull();
  });

  it("warns without the lockout copy when only fail-open hosts are tracked", () => {
    const result = inspect([CLAUDE_REGISTRATION], NO_PIN);

    expect(result.trackedRegistrations).toEqual([CLAUDE_REGISTRATION]);
    expect(result.failClosedRegistrations).toEqual([]);
    expect(result.warning).toContain(CLAUDE_REGISTRATION);
    expect(result.warning).not.toContain("(fail-closed)");
    expect(result.warning).not.toContain("exit 127");
    expect(result.warning).not.toContain("policy:disable-host-hooks");
  });

  it("classifies cursor as the fail-closed host", () => {
    expect([...FAIL_CLOSED_HOOK_HOSTS]).toEqual(["cursor"]);
  });
});

describe("writeAgentHookDeposit hook-runtime travel warning", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-hook-travel-"));
    temps.push(root);
    return root;
  }

  it("reports at deposit time when the registration travels without the runtime", () => {
    const root = project();
    const lines: string[] = [];

    writeAgentHookDeposit(
      root,
      { printf: (text) => lines.push(text) },
      DEFAULT_HOST_HOOKS_POLICY,
      seams([CURSOR_REGISTRATION], NO_PIN),
    );

    const output = lines.join("");
    expect(output).toContain("Installed Directive agent hooks");
    expect(output).toContain("Hook registration travels without its runtime (#3785)");
    expect(output).toContain("policy:disable-host-hooks");
  });

  it("stays quiet at deposit time once the runtime anchor is committed", () => {
    const root = project();
    const lines: string[] = [];

    writeAgentHookDeposit(
      root,
      { printf: (text) => lines.push(text) },
      DEFAULT_HOST_HOOKS_POLICY,
      seams([CURSOR_REGISTRATION, RUNTIME_ANCHOR_MANIFEST], EXACT_PIN),
    );

    expect(lines.join("")).not.toContain("#3785");
  });

  it("keeps the Cursor deposit fail-closed: absence is never an allow (#3156)", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeAgentHookDeposit(root, { printf: () => undefined });

    const config = JSON.parse(readFileSync(join(root, AGENT_HOOK_PATHS[2]), "utf8")) as {
      hooks: { preToolUse: { failClosed?: boolean }[] };
    };

    expect(config.hooks.preToolUse.length).toBeGreaterThan(0);
    for (const entry of config.hooks.preToolUse) {
      expect(entry.failClosed).toBe(true);
    }
  });

  it("does not warn when the project root is not a repository (default probe)", () => {
    const root = project();
    writeFileSync(join(root, RUNTIME_ANCHOR_MANIFEST), '{"name":"x"}\n', "utf8");
    const lines: string[] = [];

    writeAgentHookDeposit(root, { printf: (text) => lines.push(text) });

    expect(lines.join("")).not.toContain("#3785");
  });
});
