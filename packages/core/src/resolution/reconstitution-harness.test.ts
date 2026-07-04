import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineInstallOutcome } from "./engine-ladder.js";
import {
  type ColdCloneFixture,
  makeColdCloneFixture,
  reconstituteColdClone,
} from "./reconstitution-harness.js";

describe("resolution/reconstitution-harness makeColdCloneFixture (#2272)", () => {
  const fixtures: ColdCloneFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.cleanup();
    }
  });

  function fresh(options?: Parameters<typeof makeColdCloneFixture>[0]): ColdCloneFixture {
    const fixture = makeColdCloneFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  it("materialises the committed surface but NEITHER .deft/core nor .deft/.cli", () => {
    const fixture = fresh({ pinVersion: "0.65.0" });

    // Committed git surface is present.
    expect(existsSync(join(fixture.projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(fixture.projectDir, "AGENTS.md"))).toBe(true);

    // Both gitignored payloads are ABSENT on the simulated cold clone.
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
    expect(existsSync(join(fixture.projectDir, ".deft", ".cli"))).toBe(false);

    // The fake content package exists in a separate temp location.
    expect(existsSync(join(fixture.contentRoot, "package.json"))).toBe(true);
    expect(existsSync(join(fixture.contentRoot, "main.md"))).toBe(true);
  });

  it("writes a bridged workspace-local .deft/USER.md when requested (without a deposit)", () => {
    const fixture = fresh({ withWorkspaceUserMd: true });
    expect(existsSync(join(fixture.projectDir, ".deft", "USER.md"))).toBe(true);
    // Writing USER.md must NOT smuggle in a .deft/core deposit.
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
  });

  it("defaults the content version to the pin version", () => {
    const fixture = fresh({ pinVersion: "0.66.0" });
    expect(fixture.contentVersion).toBe("0.66.0");
  });
});

describe("resolution/reconstitution-harness reconstituteColdClone (#2272)", () => {
  const fixtures: ColdCloneFixture[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      fixture.cleanup();
    }
  });

  function fresh(options?: Parameters<typeof makeColdCloneFixture>[0]): ColdCloneFixture {
    const fixture = makeColdCloneFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  function okInstall(version: string): EngineInstallOutcome {
    return { installed: true, version, detail: `fake npm install @${version}` };
  }

  it("drives all five ordered steps and reports gates runnable", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });
    const installRunner = vi.fn(() => okInstall("0.65.0"));

    const result = await reconstituteColdClone(fixture, {
      ladder: { globalPrefixWritable: false, installRunner, reproject: vi.fn() },
    });

    // Step ordering is stable and complete.
    expect(result.steps.map((s) => s[0])).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.pin.pinVersion).toBe("0.65.0");
    expect(result.ladder.resolvedVersion).toBe("0.65.0");
    expect(result.update.ran).toBe(true);
    expect(result.update.exitCode).toBe(0);
    expect(result.gatesRunnable).toBe(true);
  });

  it("skips update by default on a registry-down hard-fail", async () => {
    const fixture = fresh();
    const installRunner = vi.fn();

    const result = await reconstituteColdClone(fixture, {
      ladder: { registryUp: false, stagedTarballAvailable: false, installRunner },
    });

    expect(result.ladder.decision.rung).toBe("hard-fail");
    expect(result.update.ran).toBe(false);
    expect(installRunner).not.toHaveBeenCalled();
    expect(result.gatesRunnable).toBe(false);
  });
});
