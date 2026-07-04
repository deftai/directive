/**
 * Cold-clone reconstitution harness (#2272, epic #2203 M1-gap acceptance test).
 *
 * Builds a simulated *cold clone* of a hybrid consumer — a temp project that
 * carries only the git-committed surface (a `package.json` pin + an AGENTS.md
 * managed section) while BOTH `.deft/core/` (content) and `.deft/.cli/` (engine)
 * are absent, exactly as they are on a fresh clone in a mismatched sandbox where
 * those paths are gitignored.
 *
 * `reconstituteColdClone` then drives the ordered reconstitution flow the whole
 * epic exists to make work — read the pin, run the global-first engine ladder,
 * run `update` to re-project `.deft/core/` + stamp VERSION, resolve USER.md, and
 * report whether framework-local gates became runnable — entirely through the
 * INJECTED SEAMS of the merged spine (#2264 ladder, #2266 update, #2271
 * user-config) so no real network / npm / PATH / `DEFT_USER_PATH` step runs.
 *
 * This module is a test-only driver: it is deliberately NOT re-exported from
 * `resolution/index.ts` (it is not part of the public resolution API) and it
 * consumes the keystone modules read-only.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { runRefreshDepositCli } from "../init-deposit/refresh.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { type ResolveUserMdResult, resolveUserMdPath } from "../user-config/resolve-user-md.js";
import type { EngineProbeResult } from "./classify.js";
import {
  type EngineInstallRunner,
  type EngineResolution,
  type LadderFacts,
  type LocalEngineFacts,
  type ReprojectRunner,
  resolveEngine,
} from "./engine-ladder.js";
import { checkLocalEngineIntegrity } from "./integrity.js";
import { type PinReadResult, readPin } from "./pin.js";

/** A simulated cold-clone fixture on disk plus a matching fake content package. */
export interface ColdCloneFixture {
  /** The cold-clone project root (committed pin + AGENTS.md, no `.deft/core|.cli`). */
  readonly projectDir: string;
  /** A fake `@deftai/directive-content` package the `update` seam re-projects from. */
  readonly contentRoot: string;
  /** The exact committed `package.json` pin. */
  readonly pinVersion: string;
  /** The version the fake content package advertises. */
  readonly contentVersion: string;
  /** Remove both temp dirs. */
  cleanup(): void;
}

export interface MakeColdCloneOptions {
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
export function makeColdCloneFixture(options: MakeColdCloneOptions = {}): ColdCloneFixture {
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

  if (options.withWorkspaceUserMd) {
    mkdirSync(join(projectDir, ".deft"), { recursive: true });
    writeFileSync(
      join(projectDir, ".deft", "USER.md"),
      "# USER preferences (bridged into the workspace)\n",
      "utf8",
    );
  }

  return {
    projectDir,
    contentRoot,
    pinVersion,
    contentVersion,
    cleanup() {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(contentRoot, { recursive: true, force: true });
    },
  };
}

/** Injected engine-ladder environment facts for a reconstitution run. */
export interface LadderOverrides {
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

export interface ReconstituteOptions {
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

/** The outcome of the `update` step. */
export interface ReconstitutionUpdateOutcome {
  readonly ran: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The structured result of driving the ordered reconstitution flow. */
export interface ReconstitutionResult {
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
export async function reconstituteColdClone(
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
  const ladderFacts: LadderFacts = {
    pinVersion: pin.pinVersion,
    globalEngineVersion: l.globalEngineVersion ?? null,
    localEngine,
    registryUp: l.registryUp ?? true,
    globalPrefixWritable: l.globalPrefixWritable ?? false,
    stagedTarballAvailable: l.stagedTarballAvailable ?? false,
    platform,
  };
  const ladder = resolveEngine(ladderFacts, {
    installRunner: l.installRunner,
    reproject: l.reproject,
  });
  steps.push(`2 ladder[${ladder.decision.rung}]: ${ladder.trace}`);

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
