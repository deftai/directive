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
 *
 * The cold-clone fixture + flow driver live INLINE here on purpose: they are
 * test-only helpers, so keeping them inside this excluded `*.test.ts` file (vs.
 * a shipped `src/` module) means no test scaffolding is ever compiled into the
 * published `@deftai/directive-core` package.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { runRefreshDepositCli } from "../init-deposit/refresh.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import {
  NO_USER_MD_DIAGNOSTIC,
  type ResolveUserMdResult,
  resolveUserMdPath,
} from "../user-config/resolve-user-md.js";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import type { EngineProbeResult } from "./classify.js";
import {
  type EngineFacts,
  type EngineInstallRunner,
  type EngineResolution,
  type LocalEngineFacts,
  type ReprojectRunner,
  resolveEngine,
} from "./engine-resolve.js";
import { checkLocalEngineIntegrity } from "./integrity.js";
import { type PinReadResult, readPin } from "./pin.js";

// ---------------------------------------------------------------------------
// Cold-clone fixture (test-only, never shipped).
// ---------------------------------------------------------------------------

/** A simulated cold-clone fixture on disk plus a matching fake content package. */
interface ColdCloneFixture {
  /** The cold-clone project root (committed pin + AGENTS.md, no `.deft/core|.cli`). */
  readonly projectDir: string;
  /** A fake `@deftai/directive-content` package the `update` seam re-projects from. */
  readonly contentRoot: string;
  /** The exact committed `package.json` pin. */
  readonly pinVersion: string;
  /** The version the fake content package advertises. */
  readonly contentVersion: string;
}

interface MakeColdCloneOptions {
  /** Committed `package.json` pin. Defaults to `0.65.0`. */
  readonly pinVersion?: string;
  /** Version the fake content package advertises. Defaults to `pinVersion`. */
  readonly contentVersion?: string;
  /**
   * Write a bridged workspace-local `.deft/USER.md` so USER.md resolves with
   * zero manual `DEFT_USER_PATH` even when `$HOME` is not a persistent mount.
   */
  readonly withWorkspaceUserMd?: boolean;
}

/**
 * Materialise a cold-clone fixture: a project carrying only its committed git
 * surface (pin + managed AGENTS.md) with `.deft/core/` and `.deft/.cli/` absent,
 * alongside a separate fake content package the `update` seam re-projects from.
 */
function makeColdCloneFixture(options: MakeColdCloneOptions = {}): ColdCloneFixture {
  const pinVersion = options.pinVersion ?? "0.65.0";
  const contentVersion = options.contentVersion ?? pinVersion;

  const projectDir = mkdtempSync(join(tmpdir(), "cold-clone-"));
  const contentRoot = mkdtempSync(join(tmpdir(), "cold-clone-content-"));

  // Committed surface #1: the canonical package.json pin (always present in git).
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify(
      { private: true, devDependencies: { "@deftai/directive": pinVersion } },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Committed surface #2: AGENTS.md with a managed section (so the project reads
  // as initialized even though the .deft/core payload is absent on clone).
  writeFileSync(
    join(projectDir, "AGENTS.md"),
    `# Operator prose\n\n<!-- deft:managed-section v3 sha=deadbeefcafe -->\nbody\n${AGENTS_MANAGED_CLOSE}\n`,
    "utf8",
  );

  // Fake content package the update seam re-projects .deft/core from.
  mkdirSync(join(contentRoot, "templates"), { recursive: true });
  mkdirSync(join(contentRoot, "vbrief", "schemas"), { recursive: true });
  writeFileSync(
    join(contentRoot, "package.json"),
    JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: contentVersion }),
    "utf8",
  );
  copyFileSync(
    join(process.cwd(), "content/templates/agents-entry.md"),
    join(contentRoot, "templates", "agents-entry.md"),
  );
  writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");
  writeFileSync(
    join(contentRoot, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
    "{}\n",
    "utf8",
  );

  if (options.withWorkspaceUserMd) {
    mkdirSync(join(projectDir, ".deft"), { recursive: true });
    writeFileSync(
      join(projectDir, ".deft", "USER.md"),
      "# USER preferences (bridged into the workspace)\n",
      "utf8",
    );
  }

  return { projectDir, contentRoot, pinVersion, contentVersion };
}

function cleanupFixture(fixture: ColdCloneFixture): void {
  rmSync(fixture.projectDir, { recursive: true, force: true });
  rmSync(fixture.contentRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Reconstitution flow driver (test-only, never shipped).
// ---------------------------------------------------------------------------

/** Injected engine-ladder environment facts for a reconstitution run. */
interface LadderOverrides {
  /** Version of a globally-reachable engine, or null (cold clone default). */
  readonly globalEngineVersion?: string | null;
  /** The npm registry is reachable. Defaults to `true`. */
  readonly registryUp?: boolean;
  /** The global npm prefix is writable. Defaults to `false` (sandbox). */
  readonly globalPrefixWritable?: boolean;
  /** A pre-staged tarball is available for offline install. Defaults to `false`. */
  readonly stagedTarballAvailable?: boolean;
  /** Platform id for the ladder + local-engine probe. Defaults to `linux`. */
  readonly platform?: string;
  /** Injected side-effecting install runner (no real npm). */
  readonly installRunner?: EngineInstallRunner;
  /** Injected content re-projection invoked after a successful install. */
  readonly reproject?: ReprojectRunner;
  /** Override the local-engine facts (default: probed from the fixture, absent on clone). */
  readonly localEngine?: LocalEngineFacts | null;
}

interface ReconstituteOptions {
  /** Injected engine-ladder environment facts. */
  readonly ladder?: LadderOverrides;
  /**
   * Engine reachability `update`'s classifier sees AFTER the ladder ran.
   * Defaults to reachable at the fixture content version (the ladder healed it).
   */
  readonly engineProbe?: EngineProbeResult;
  /**
   * Run step 3 (`update` re-projection). Defaults to `true` when the ladder
   * resolved an engine; a hard-fail run leaves it off so reconstitution stops.
   */
  readonly runUpdate?: boolean;
  /** USER.md resolution overrides (default: empty env + a non-persistent home). */
  readonly userMd?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
  };
}

interface ReconstitutionUpdateOutcome {
  readonly ran: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The structured result of driving the ordered reconstitution flow. */
interface ReconstitutionResult {
  /** Step 1: the committed pin read from `package.json`. */
  readonly pin: PinReadResult;
  /** Step 2: the keystone global-first ladder resolution (carries the trace). */
  readonly ladder: EngineResolution;
  /** Step 3: the `update` re-projection outcome. */
  readonly update: ReconstitutionUpdateOutcome;
  /** Step 4: the resolved USER.md location. */
  readonly userMd: ResolveUserMdResult;
  /** Step 5: framework-local gates are runnable (engine resolved + content present). */
  readonly gatesRunnable: boolean;
  /** Ordered per-step narration for readable assertions / diagnostics. */
  readonly steps: readonly string[];
}

/**
 * Drive the ordered cold-clone reconstitution flow against the merged spine via
 * injected seams — no real network / npm / PATH / `DEFT_USER_PATH`:
 *
 *   1. read the committed `package.json` pin
 *   2. run the global-first engine ladder (`resolveEngine`)
 *   3. run `update` (`runRefreshDepositCli`) to re-project `.deft/core/` + stamp VERSION
 *   4. resolve USER.md (`resolveUserMdPath`)
 *   5. report whether framework-local gates became runnable
 */
async function reconstituteColdClone(
  fixture: ColdCloneFixture,
  options: ReconstituteOptions = {},
): Promise<ReconstitutionResult> {
  const steps: string[] = [];
  const l = options.ladder ?? {};
  const platform = l.platform ?? "linux";

  // Step 1: read the committed pin (always present in git).
  const pin = readPin(fixture.projectDir);
  steps.push(`1 pin: ${pin.pinVersion ?? "absent"}`);

  // Step 2: global-first ladder. The local-engine facts are probed from the
  // (absent on a cold clone) `.deft/.cli/<platform>` unless overridden.
  const integrity = checkLocalEngineIntegrity(fixture.projectDir, { platform });
  const localEngine =
    l.localEngine !== undefined
      ? l.localEngine
      : integrity.present
        ? { version: null, integrity }
        : null;
  const engineFacts: EngineFacts = {
    pinVersion: pin.pinVersion,
    globalEngineVersion: l.globalEngineVersion ?? null,
    localEngine,
    platform,
  };
  const ladder = resolveEngine(engineFacts, {
    installRunner: l.installRunner,
    reproject: l.reproject,
  });
  steps.push(`2 engine[${ladder.decision.usable ? "usable" : "unusable"}]: ${ladder.trace}`);

  // Step 3: run `update` to re-project .deft/core + stamp VERSION. Skipped when
  // the ladder resolved no engine (registry-down hard-fail) so a failed engine
  // resolution can never be papered over by a content copy.
  const runUpdate = options.runUpdate ?? ladder.resolvedVersion !== null;
  let update: ReconstitutionUpdateOutcome = {
    ran: false,
    exitCode: null,
    stdout: "",
    stderr: "",
  };
  if (runUpdate) {
    const out: string[] = [];
    const err: string[] = [];
    const engineProbe = options.engineProbe ?? {
      reachable: true,
      version: fixture.contentVersion,
    };
    const exitCode = await runRefreshDepositCli({
      projectDir: fixture.projectDir,
      jsonOut: false,
      nonInteractive: true,
      upgrade: true,
      classifySeams: { engineProbe: () => engineProbe, preCutoverProbe: () => false },
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      seams: {
        resolveContentRoot: async () => fixture.contentRoot,
        readEngineVersion: () => fixture.contentVersion,
        nowIso: () => "2026-07-03T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => ({
          code: 0,
          message: "hooks ready",
          stream: "stdout",
          skipped: false,
          liveStatus: "functional",
          hosts: [],
          registrations: [],
          liveProbe: null,
        }),
      },
    });
    update = { ran: true, exitCode, stdout: out.join(""), stderr: err.join("") };
    steps.push(`3 update: exit ${exitCode}`);
  } else {
    steps.push("3 update: skipped (engine unresolved)");
  }

  // Step 4: resolve USER.md with an EMPTY env (no DEFT_USER_PATH) and a
  // non-persistent home dir, proving the #2124 mismatched-sandbox path.
  const userMd = resolveUserMdPath({
    projectRoot: fixture.projectDir,
    env: options.userMd?.env ?? {},
    homeDir: options.userMd?.homeDir ?? join(fixture.projectDir, "__nonexistent_home__"),
    platform: options.userMd?.platform ?? "linux",
  });
  steps.push(`4 user-md[${userMd.rung}]: ${userMd.diagnostic}`);

  // Step 5: framework-local gates are runnable once the engine resolved AND the
  // content payload was reconstituted.
  const gatesRunnable =
    ladder.resolvedVersion !== null &&
    existsSync(join(fixture.projectDir, ".deft", "core", "main.md"));
  steps.push(`5 gates-runnable: ${gatesRunnable}`);

  return { pin, ladder, update, userMd, gatesRunnable, steps };
}

// ---------------------------------------------------------------------------
// Fixture self-checks — the simulated clone really is cold.
// ---------------------------------------------------------------------------

describe("cold-clone fixture (#2272)", () => {
  const fixtures: ColdCloneFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      cleanupFixture(fixture);
    }
  });

  function fresh(options?: MakeColdCloneOptions): ColdCloneFixture {
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

  it("writes a bridged workspace-local .deft/USER.md without smuggling in a deposit", () => {
    const fixture = fresh({ withWorkspaceUserMd: true });
    expect(existsSync(join(fixture.projectDir, ".deft", "USER.md"))).toBe(true);
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
  });

  it("defaults the content version to the pin version", () => {
    const fixture = fresh({ pinVersion: "0.66.0" });
    expect(fixture.contentVersion).toBe("0.66.0");
  });
});

// ---------------------------------------------------------------------------
// End-to-end acceptance criteria.
// ---------------------------------------------------------------------------

describe("cold-clone reconstitution end-to-end (#2272 / epic #2203 M1 gap)", () => {
  const fixtures: ColdCloneFixture[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      cleanupFixture(fixture);
    }
  });

  function fresh(options?: MakeColdCloneOptions): ColdCloneFixture {
    const fixture = makeColdCloneFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  function okInstall(version: string): { installed: boolean; version: string; detail: string } {
    return { installed: true, version, detail: `fake npm install @deftai/directive@${version}` };
  }

  // -------------------------------------------------------------------------
  // a1 — AC12.6: no auto-install; missing engine stays unusable + AC9.7.
  // -------------------------------------------------------------------------
  it(
    "a1: missing engine does not auto-install (AC12.5/AC12.6); points at AC9.7",
    destContentionItTimeout(),
    async () => {
      const fixture = fresh({ pinVersion: "0.65.0" });
      expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
      expect(existsSync(join(fixture.projectDir, ".deft", ".cli"))).toBe(false);

      const installRunner = vi.fn(() => okInstall("0.65.0"));
      const reproject = vi.fn();

      const result = await reconstituteColdClone(fixture, {
        ladder: {
          globalEngineVersion: null,
          installRunner,
          reproject,
        },
        userMd: { env: {} },
      });

      expect(installRunner).not.toHaveBeenCalled();
      expect(reproject).not.toHaveBeenCalled();
      expect(result.ladder.selfHealed).toBe(false);
      expect(result.ladder.resolvedVersion).toBeNull();
      expect(result.ladder.decision.usable).toBe(false);
      expect(result.ladder.decision.reason).toMatch(/directive install --repair/);
      expect(result.update.ran).toBe(false);
      expect(result.gatesRunnable).toBe(false);
      expect(result.userMd.rung).toBe("default");
      expect(result.userMd.diagnostic).toContain(NO_USER_MD_DIAGNOSTIC);
    },
  );

  it(
    "a1: with a usable global engine, reconstitutes content + workspace USER.md",
    destContentionItTimeout(),
    async () => {
      const fixture = fresh({ pinVersion: "0.65.0", withWorkspaceUserMd: true });

      const result = await reconstituteColdClone(fixture, {
        ladder: { globalEngineVersion: "0.65.0" },
        engineProbe: { reachable: true, version: "0.65.0" },
        userMd: { env: {} },
      });

      expect(result.ladder.decision.usable).toBe(true);
      expect(result.ladder.resolvedVersion).toBe("0.65.0");
      expect(result.update.ran).toBe(true);
      expect(result.userMd.rung).toBe("workspace-local");
      expect(result.userMd.found).toBe(true);
      expect(result.userMd.path).toBe(join(fixture.projectDir, ".deft", "USER.md"));
      expect(result.gatesRunnable).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // a2 — structured trace under AC12.6 (no install rungs).
  // -------------------------------------------------------------------------
  it(
    "a2: emits engine resolve trace without install rungs",
    destContentionItTimeout(),
    async () => {
      const fixture = fresh({ pinVersion: "0.65.0" });

      const result = await reconstituteColdClone(fixture, {
        ladder: { globalEngineVersion: null },
      });

      const trace = result.ladder.trace;
      expect(trace).toContain("global: absent");
      expect(trace).toContain("local: absent");
      expect(trace).toContain("directive install --repair");
      expect(trace).not.toMatch(/install-sandbox|install-global|accept-engine/i);

      expect(result.steps[0]).toContain("1 pin: 0.65.0");
      expect(result.steps[1]).toContain("2 engine[unusable]");
      expect(result.update.ran).toBe(false);
      expect(result.gatesRunnable).toBe(false);
    },
  );

  // -------------------------------------------------------------------------
  // a3 — missing engine fails closed (never hangs / fails open).
  // -------------------------------------------------------------------------
  it("a3: missing engine fails closed without install attempt", async () => {
    const fixture = fresh({ pinVersion: "0.65.0" });
    const installRunner = vi.fn();

    const result = await reconstituteColdClone(fixture, {
      ladder: {
        globalEngineVersion: null,
        installRunner,
      },
    });

    expect(result.ladder.decision.usable).toBe(false);
    expect(result.ladder.decision.reason).toMatch(/directive install --repair/);
    expect(installRunner).not.toHaveBeenCalled();
    expect(result.ladder.resolvedVersion).toBeNull();
    expect(result.update.ran).toBe(false);
    expect(result.gatesRunnable).toBe(false);
    expect(existsSync(join(fixture.projectDir, ".deft", "core"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // a4 — matched-env clone uses global engine with no reinstall.
  // -------------------------------------------------------------------------
  it(
    "a4: matched-env clone uses global engine with no reinstall",
    destContentionItTimeout(),
    async () => {
      const fixture = fresh({ pinVersion: "0.65.0" });
      const installRunner = vi.fn();
      const reproject = vi.fn();

      const result = await reconstituteColdClone(fixture, {
        ladder: { globalEngineVersion: "0.65.0", installRunner, reproject },
        engineProbe: { reachable: true, version: "0.65.0" },
      });

      expect(result.ladder.decision.usable).toBe(true);
      expect(result.ladder.selfHealed).toBe(false);
      expect(result.ladder.resolvedVersion).toBe("0.65.0");
      expect(installRunner).not.toHaveBeenCalled();
      expect(reproject).not.toHaveBeenCalled();

      expect(result.update.ran).toBe(true);
      expect(result.gatesRunnable).toBe(true);
    },
  );
});
