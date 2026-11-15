/**
 * Pin-mismatch recovery admit (#6313): only the named recovery commands, as
 * simple uncompounded commands at the project root, when pin ≠ installed is the
 * only fault.
 */
import { describe, expect, it } from "vitest";
import {
  admitPinMismatchRecovery,
  isPinMismatchOnly,
  matchPinMismatchRecoveryCommand,
  PIN_MISMATCH_RECOVERY_COMMANDS,
} from "./index.js";
import type { CheapInSyncResult } from "./types.js";

function cheap(overrides: Partial<CheapInSyncResult> = {}): CheapInSyncResult {
  return {
    ok: false,
    pinVersion: "0.129.9",
    installedVersion: "0.129.8",
    identityMatch: false,
    readinessValid: false,
    failClosed: true,
    pinMismatchOnly: true,
    allowSetup: false,
    recoveryGuidance: "x",
    ...overrides,
  };
}

describe("matchPinMismatchRecoveryCommand (#6313)", () => {
  it.each([
    ["pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile"],
    ["npm install", "npm install"],
    ["npm ci", "npm ci"],
    ["npm i -g @deftai/directive", "npm i -g @deftai/directive"],
    ["directive install --repair", "directive install --repair"],
    ["  pnpm   install\t--frozen-lockfile  ", "pnpm install --frozen-lockfile"],
  ])("admits %j", (command, canonical) => {
    expect(matchPinMismatchRecoveryCommand(command)).toBe(canonical);
  });

  it.each([
    "pnpm install --frozen-lockfile && git status",
    "pnpm install --frozen-lockfile; rm -rf x",
    "pnpm install --frozen-lockfile || true",
    "pnpm install --frozen-lockfile | tee log",
    "pnpm install --frozen-lockfile > log",
    "pnpm install --frozen-lockfile &",
    "cd other && pnpm install --frozen-lockfile",
    "pnpm install --frozen-lockfile\ngit status",
    "pnpm install --frozen-lockfile $(echo x)",
    "pnpm install --frozen-lockfile `echo x`",
    'pnpm install "--frozen-lockfile"',
    "pnpm --dir other install --frozen-lockfile",
    "pnpm -C other install --frozen-lockfile",
    "pnpm install",
    "pnpm install --frozen-lockfile --force",
    "npm install left-pad",
    "npm i -g @deftai/directive@latest",
    "directive install",
    "git status",
    "",
  ])("refuses %j", (command) => {
    expect(matchPinMismatchRecoveryCommand(command)).toBeNull();
  });

  it("refuses a null command", () => {
    expect(matchPinMismatchRecoveryCommand(null)).toBeNull();
  });

  it("names exactly the refusal's recovery set", () => {
    expect(PIN_MISMATCH_RECOVERY_COMMANDS.map((tokens) => tokens.join(" "))).toEqual([
      "pnpm install --frozen-lockfile",
      "npm install",
      "npm ci",
      "npm i -g @deftai/directive",
      "directive install --repair",
    ]);
  });
});

describe("isPinMismatchOnly (#6313)", () => {
  it("is true only for a fail-closed pin mismatch with no other fault", () => {
    expect(isPinMismatchOnly(cheap())).toBe(true);
    expect(isPinMismatchOnly(cheap({ pinMismatchOnly: false }))).toBe(false);
    expect(isPinMismatchOnly(cheap({ failClosed: false }))).toBe(false);
  });

  it("reads an absent field as false", () => {
    const { pinMismatchOnly: _omit, ...rest } = cheap();
    expect(isPinMismatchOnly(rest)).toBe(false);
  });
});

describe("admitPinMismatchRecovery (#6313)", () => {
  const base = {
    cheap: cheap(),
    shellTool: true,
    command: "pnpm install --frozen-lockfile",
    atProjectRoot: true,
  };

  it("admits the named recovery through a shell tool at the project root", () => {
    expect(admitPinMismatchRecovery(base)).toBe("pnpm install --frozen-lockfile");
  });

  it("refuses when an overlay or other fault is present", () => {
    expect(admitPinMismatchRecovery({ ...base, cheap: cheap({ pinMismatchOnly: false }) })).toBe(
      null,
    );
  });

  it("refuses outside a shell tool", () => {
    expect(admitPinMismatchRecovery({ ...base, shellTool: false })).toBeNull();
  });

  it("refuses away from the project root", () => {
    expect(admitPinMismatchRecovery({ ...base, atProjectRoot: false })).toBeNull();
  });

  it("refuses any other command", () => {
    expect(admitPinMismatchRecovery({ ...base, command: "git status" })).toBeNull();
  });
});
