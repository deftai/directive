/**
 * Cold-clone reconstitution — end-to-end acceptance test (#2272, epic #2203).
 *
 * This is the M1-gap acceptance test that ties the whole epic together: it
 * proves the scenario Directive's hybrid adoption path exists to make work.
 * A fresh clone of a hybrid consumer lands in a mismatched sandbox where BOTH
 * `.deft/core/` (content) and `.deft/.cli/` (engine) are gitignored — so
 * NEITHER is present on clone — and must reach a ready-to-use state with zero
 * manual npm / PATH / `DEFT_USER_PATH` steps.
 *
 * The test drives the ordered flow against the MERGED spine read-only via
 * injected seams (#2264 ladder + trace, #2266 update re-projection, #2271
 * USER.md resolution); no real network / npm runs. It pins CURRENT behavior and
 * changes no production code.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_USER_MD_DIAGNOSTIC } from "../user-config/resolve-user-md.js";
import type { EngineInstallOutcome } from "./engine-ladder.js";
import {
  type ColdCloneFixture,
  makeColdCloneFixture,
  reconstituteColdClone,
} from "./reconstitution-harness.js";

describe("cold-clone reconstitution end-to-end (#2272 / epic #2203 M1 gap)", () => {
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
    return { installed: true, version, detail: `fake npm install @deftai/directive@${version}` };
  }

  // ---------------------------------------------------------------------------
  // a1 — zero-manual reconstitution of engine + content from a bare clone.
  // ---------------------------------------------------------------------------
  it("a1: reconstitutes engine + content from a cold clone with zero manual steps", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });

    // Precondition: this really is a cold clone — neither payload is present.
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
    expect(existsSync(join(fixture.projectDir, ".deft", ".cli"))).toBe(false);

    const installRunner = vi.fn(() => okInstall("0.65.0"));
    const reproject = vi.fn();

    const result = await reconstituteColdClone(fixture, {
      // Mismatched sandbox: no global engine, global prefix not writable ->
      // the ladder self-heals via a sandbox (`--prefix .deft/.cli`) install.
      ladder: { globalEngineVersion: null, globalPrefixWritable: false, installRunner, reproject },
      // After the ladder heals the engine it is reachable at the pin.
      engineProbe: { reachable: true, version: "0.65.0" },
      // Empty env (no DEFT_USER_PATH) + a non-persistent home => the #2124 gap.
      userMd: { env: {} },
    });

    // The ladder healed the engine with a single injected install (zero manual npm/PATH).
    expect(installRunner).toHaveBeenCalledTimes(1);
    expect(installRunner).toHaveBeenCalledWith(
      expect.objectContaining({ rung: "install-sandbox", pinVersion: "0.65.0" }),
    );
    expect(reproject).toHaveBeenCalledWith("0.65.0");
    expect(result.ladder.selfHealed).toBe(true);
    expect(result.ladder.resolvedVersion).toBe("0.65.0");

    // `update` re-projected the content payload and stamped VERSION.
    expect(result.update.ran).toBe(true);
    expect(result.update.exitCode).toBe(0);
    expect(existsSync(join(fixture.projectDir, ".deft", "core", "main.md"))).toBe(true);
    expect(readFileSync(join(fixture.projectDir, ".deft", "core", "VERSION"), "utf8")).toContain(
      "v0.65.0",
    );

    // USER.md resolved with zero manual DEFT_USER_PATH — degraded to the sensible
    // default (never throwing / hanging) since no USER.md exists on the clone.
    expect(result.userMd.rung).toBe("default");
    expect(result.userMd.diagnostic).toContain(NO_USER_MD_DIAGNOSTIC);

    // Framework-local gates are now runnable.
    expect(result.gatesRunnable).toBe(true);
  });

  it("a1: resolves a bridged workspace-local USER.md with no DEFT_USER_PATH", async () => {
    // A cold clone whose operator committed preferences to the workspace-local
    // bridge path — resolves without $HOME being a persistent mount.
    const fixture = fresh({ pinVersion: "0.65.0", withWorkspaceUserMd: true });

    const result = await reconstituteColdClone(fixture, {
      ladder: {
        globalPrefixWritable: false,
        installRunner: vi.fn(() => okInstall("0.65.0")),
        reproject: vi.fn(),
      },
      engineProbe: { reachable: true, version: "0.65.0" },
      userMd: { env: {} },
    });

    expect(result.userMd.rung).toBe("workspace-local");
    expect(result.userMd.found).toBe(true);
    expect(result.userMd.path).toBe(join(fixture.projectDir, ".deft", "USER.md"));
    expect(result.gatesRunnable).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // a2 — the structured reconstitution trace from the keystone ladder.
  // ---------------------------------------------------------------------------
  it("a2: emits and asserts the keystone ladder trace step-by-step", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });

    const result = await reconstituteColdClone(fixture, {
      ladder: {
        globalEngineVersion: null,
        globalPrefixWritable: false,
        installRunner: vi.fn(() => okInstall("0.65.0")),
        reproject: vi.fn(),
      },
      engineProbe: { reachable: true, version: "0.65.0" },
    });

    // The keystone ladder trace narrates each rung it evaluated and the heal.
    const trace = result.ladder.trace;
    expect(trace).toContain("global: absent");
    expect(trace).toContain("local: absent");
    expect(trace).toContain("--prefix .deft/.cli/linux");
    expect(trace).toContain("installed install-sandbox -> 0.65.0");
    expect(trace).toContain("re-projected content 0.65.0");

    // The harness narrates the full ordered flow keyed off the ladder trace.
    expect(result.steps[0]).toContain("1 pin: 0.65.0");
    expect(result.steps[1]).toContain("2 ladder[install-sandbox]");
    expect(result.steps[2]).toContain("3 update: exit 0");
    expect(result.steps[4]).toContain("5 gates-runnable: true");
  });

  // ---------------------------------------------------------------------------
  // a3 — registry-down hard-fails with the canonical "stage" message.
  // ---------------------------------------------------------------------------
  it("a3: registry-down hard-fails with the stage-a-payload message (never hangs / fails open)", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });
    const installRunner = vi.fn();

    const result = await reconstituteColdClone(fixture, {
      ladder: {
        globalEngineVersion: null,
        registryUp: false,
        globalPrefixWritable: false,
        stagedTarballAvailable: false,
        installRunner,
      },
    });

    // Fails closed on the hard-fail rung with the canonical remediation.
    expect(result.ladder.decision.rung).toBe("hard-fail");
    expect(result.ladder.decision.reason).toContain("stage a payload");
    expect(result.ladder.trace).toContain("hard-fail: registry down and no staged tarball");

    // Never hangs / fails open: no install is attempted, no engine resolves, and
    // reconstitution does NOT proceed to a content copy.
    expect(installRunner).not.toHaveBeenCalled();
    expect(result.ladder.resolvedVersion).toBeNull();
    expect(result.update.ran).toBe(false);
    expect(result.gatesRunnable).toBe(false);
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // a4 — matched-env clone short-circuits with no reinstall.
  // ---------------------------------------------------------------------------
  it("a4: matched-env clone short-circuits the ladder at step 1/2 with no reinstall", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });
    const installRunner = vi.fn();
    const reproject = vi.fn();

    const result = await reconstituteColdClone(fixture, {
      // Engine already global and >= pin: the ladder must use it, not reinstall.
      ladder: { globalEngineVersion: "0.65.0", installRunner, reproject },
      engineProbe: { reachable: true, version: "0.65.0" },
    });

    // Short-circuit at the global rung with no install / re-projection.
    expect(result.ladder.decision.rung).toBe("global");
    expect(result.ladder.decision.usable).toBe(true);
    expect(result.ladder.selfHealed).toBe(false);
    expect(result.ladder.resolvedVersion).toBe("0.65.0");
    expect(installRunner).not.toHaveBeenCalled();
    expect(reproject).not.toHaveBeenCalled();

    // Content is still reconstituted on the clone; the ladder simply did no reinstall.
    expect(result.update.ran).toBe(true);
    expect(result.gatesRunnable).toBe(true);
  });
});
