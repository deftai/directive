/**
 * Wave 2e launcher doctor bookend tests (AC12.4 / AC14.27 / AC12.5).
 */
import { describe, expect, it } from "vitest";
import { runDoctor } from "./bookends.js";
import { EXIT_CODES, RECOVERY_GUIDANCE } from "./constants.js";
import type { ProjectInstallState } from "./pin.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        out.push(t);
      },
      writeErr: (t: string) => {
        err.push(t);
      },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function baseState(over: Partial<ProjectInstallState> = {}): ProjectInstallState {
  return {
    pin: { kind: "exact", version: "1.2.3", raw: "1.2.3" },
    installed: null,
    pinMatchesInstalled: false,
    contractSupported: true,
    oldStyle: false,
    ...over,
  };
}

describe("runDoctor launcher basic diagnosis (AC12.4)", () => {
  it("no project → non-zero and names directive install (AC14.27)", () => {
    const c = capture();
    const code = runDoctor(null, null, [], "9.9.9", c.io);
    expect(code).toBe(EXIT_CODES.FAILURE);
    expect(c.err() + c.out()).toMatch(/No Directive project here/);
    expect(c.err() + c.out()).toMatch(/directive install/);
  });

  it("missing installed runtime → AC9.7, no global-runtime remedy", () => {
    const c = capture();
    const code = runDoctor("/tmp/proj", baseState(), [], "9.9.9", c.io);
    expect(code).toBe(EXIT_CODES.FAILURE);
    expect(c.out()).toContain(RECOVERY_GUIDANCE);
    expect(c.out()).not.toMatch(/directive-runtime@/);
    expect(c.out()).not.toMatch(/\bnpx\b/);
    expect(c.out()).not.toMatch(/align-pin|accept-engine|DEFT_ACCEPT_ENGINE_SKEW/i);
  });

  it("pin≠installed → reports both versions and AC9.7", () => {
    const c = capture();
    const state = baseState({
      installed: {
        version: "1.0.0",
        contract: 1,
        entryPath: "/tmp/proj/node_modules/@deftai/directive-runtime/dist/bin.js",
        packageJsonPath: "/tmp/proj/node_modules/@deftai/directive-runtime/package.json",
      },
      pinMatchesInstalled: false,
      contractSupported: true,
    });
    const code = runDoctor("/tmp/proj", state, [], "9.9.9", c.io);
    expect(code).toBe(EXIT_CODES.FAILURE);
    expect(c.out()).toMatch(/1\.2\.3/);
    expect(c.out()).toMatch(/1\.0\.0/);
    expect(c.out()).toContain(RECOVERY_GUIDANCE);
    expect(c.out()).not.toMatch(/directive upgrade/);
  });
});
