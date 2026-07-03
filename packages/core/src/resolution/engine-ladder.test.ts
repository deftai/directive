import { describe, expect, it, vi } from "vitest";
import {
  decideEngineLadder,
  type EngineInstallOutcome,
  type LadderFacts,
  resolveEngine,
} from "./engine-ladder.js";
import type { IntegrityResult } from "./integrity.js";

function intact(): IntegrityResult {
  return {
    usable: true,
    present: true,
    partial: false,
    platformDir: "/proj/.deft/.cli/linux",
    missingMarkers: [],
    reason: "intact",
  };
}

function partial(): IntegrityResult {
  return {
    usable: false,
    present: true,
    partial: true,
    platformDir: "/proj/.deft/.cli/linux",
    missingMarkers: ["node_modules/.bin/directive"],
    reason: "partial local engine",
  };
}

function baseFacts(overrides: Partial<LadderFacts> = {}): LadderFacts {
  return {
    pinVersion: "0.65.0",
    globalEngineVersion: null,
    localEngine: null,
    registryUp: true,
    globalPrefixWritable: true,
    stagedTarballAvailable: false,
    platform: "linux",
    ...overrides,
  };
}

describe("resolution/engine-ladder decideEngineLadder (#2264 a3)", () => {
  it("uses the global engine when reachable and >= pin (matched)", () => {
    const d = decideEngineLadder(baseFacts({ globalEngineVersion: "0.65.0" }));
    expect(d.rung).toBe("global");
    expect(d.usable).toBe(true);
    expect(d.resolvedVersion).toBe("0.65.0");
    expect(d.trace).toContain("use");
  });

  it("uses the intact local engine when global is absent (warm sandbox)", () => {
    const d = decideEngineLadder(
      baseFacts({
        globalEngineVersion: null,
        localEngine: { version: "0.65.0", integrity: intact() },
      }),
    );
    expect(d.rung).toBe("local");
    expect(d.usable).toBe(true);
    expect(d.trace).toContain("global: absent");
    expect(d.trace).toContain("local: 0.65.0 >= pin 0.65.0 -> use");
  });

  it("skips a partial local engine (integrity rejection) and installs", () => {
    const d = decideEngineLadder(
      baseFacts({
        globalEngineVersion: null,
        localEngine: { version: "0.65.0", integrity: partial() },
        globalPrefixWritable: false,
      }),
    );
    expect(d.rung).toBe("install-sandbox");
    expect(d.usable).toBe(false);
    expect(d.trace).toContain("partial install -> not-usable");
  });

  it("skips a stale local engine below the pin", () => {
    const d = decideEngineLadder(
      baseFacts({
        globalEngineVersion: "0.60.0",
        localEngine: { version: "0.63.0", integrity: intact() },
      }),
    );
    expect(d.rung).toBe("install-global");
    expect(d.trace).toContain("global: 0.60.0 < pin 0.65.0");
    expect(d.trace).toContain("local: 0.63.0 < pin 0.65.0");
  });

  it("chooses global install when registry up + prefix writable (cold, writable)", () => {
    const d = decideEngineLadder(baseFacts({ globalPrefixWritable: true }));
    expect(d.rung).toBe("install-global");
  });

  it("chooses sandbox install when registry up + prefix NOT writable (cold sandbox)", () => {
    const d = decideEngineLadder(baseFacts({ globalPrefixWritable: false }));
    expect(d.rung).toBe("install-sandbox");
    expect(d.trace).toContain("--prefix .deft/.cli/linux");
  });

  it("chooses staged install when registry down + tarball available", () => {
    const d = decideEngineLadder(
      baseFacts({ registryUp: false, globalPrefixWritable: false, stagedTarballAvailable: true }),
    );
    expect(d.rung).toBe("install-staged");
  });

  it("hard-fails when registry down and no staged tarball (registry-down)", () => {
    const d = decideEngineLadder(baseFacts({ registryUp: false, stagedTarballAvailable: false }));
    expect(d.rung).toBe("hard-fail");
    expect(d.usable).toBe(false);
    expect(d.reason).toContain("stage a payload");
  });
});

describe("resolution/engine-ladder resolveEngine self-heal", () => {
  it("returns the usable global rung without any install", () => {
    const res = resolveEngine(baseFacts({ globalEngineVersion: "0.65.0" }));
    expect(res.selfHealed).toBe(false);
    expect(res.installOutcome).toBeNull();
    expect(res.resolvedVersion).toBe("0.65.0");
  });

  it("self-heals a mismatched env with zero manual steps and emits a structured trace", () => {
    const installRunner = vi.fn(
      (): EngineInstallOutcome => ({ installed: true, version: "0.65.0", detail: "npm --prefix" }),
    );
    const reproject = vi.fn();
    const res = resolveEngine(
      baseFacts({
        globalEngineVersion: null,
        localEngine: { version: "0.63.0", integrity: intact() },
        globalPrefixWritable: false,
      }),
      { installRunner, reproject },
    );
    expect(res.selfHealed).toBe(true);
    expect(res.resolvedVersion).toBe("0.65.0");
    expect(installRunner).toHaveBeenCalledTimes(1);
    expect(reproject).toHaveBeenCalledWith("0.65.0");
    // Structured trace mirrors the acceptance example shape.
    expect(res.trace).toContain("global: absent");
    expect(res.trace).toContain("local: 0.63.0 < pin 0.65.0");
    expect(res.trace).toContain("installed install-sandbox -> 0.65.0");
    expect(res.trace).toContain("re-projected content 0.65.0");
  });

  it("reports a failed install without self-heal", () => {
    const installRunner = vi.fn(
      (): EngineInstallOutcome => ({ installed: false, version: null, detail: "npm ETIMEDOUT" }),
    );
    const res = resolveEngine(baseFacts({ globalPrefixWritable: true }), { installRunner });
    expect(res.selfHealed).toBe(false);
    expect(res.resolvedVersion).toBeNull();
    expect(res.trace).toContain("install failed: npm ETIMEDOUT");
  });

  it("defers the install when no runner is supplied", () => {
    const res = resolveEngine(baseFacts({ globalPrefixWritable: true }));
    expect(res.selfHealed).toBe(false);
    expect(res.trace).toContain("deferred (no install runner supplied)");
  });

  it("does not attempt an install on a hard-fail rung", () => {
    const installRunner = vi.fn();
    const res = resolveEngine(baseFacts({ registryUp: false, stagedTarballAvailable: false }), {
      installRunner,
    });
    expect(res.decision.rung).toBe("hard-fail");
    expect(installRunner).not.toHaveBeenCalled();
    expect(res.resolvedVersion).toBeNull();
  });

  it("self-heals without a reproject runner (install succeeds, no re-projection line)", () => {
    const installRunner = vi.fn(
      (): EngineInstallOutcome => ({ installed: true, version: "0.65.0", detail: "npm -g" }),
    );
    const res = resolveEngine(baseFacts({ globalPrefixWritable: true }), { installRunner });
    expect(res.selfHealed).toBe(true);
    expect(res.trace).not.toContain("re-projected");
  });
});
