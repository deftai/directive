/**
 * Global-first engine-resolution ladder for the resolution spine (#2264, from #2124).
 *
 * The defect this closes is `execution-env != install-env`: an agent can read
 * every rule in `.deft/core/` yet execute no gate because the engine that is
 * reachable in the environment it is ACTUALLY running in is absent or stale.
 * The ladder detects that mismatch and self-heals only then:
 *
 *   1. global `deft` reachable AND >= pin                       -> use it
 *   2. local `.deft/.cli/<platform>` reachable, intact, >= pin  -> use it
 *   3. must install:
 *      a. registry up + global prefix writable                 -> npm i -g @deftai/directive@<pin>
 *      b. registry up + global prefix NOT writable (sandbox)    -> npm install --prefix .deft/.cli/<platform>
 *      c. registry down + staged tarball                        -> install from staged payload
 *      d. registry down + no tarball                            -> hard-fail ("stage this")
 *
 * `decideEngineLadder` is a PURE decision function (no I/O). The side-effecting
 * install is factored behind an injected runner in `resolveEngine` so the whole
 * self-heal path is unit-testable without touching the network.
 */

import type { IntegrityResult } from "./integrity.js";
import { semverGte } from "./pin.js";

export type LadderRung =
  | "global"
  | "local"
  | "install-global"
  | "install-sandbox"
  | "install-staged"
  | "hard-fail";

export interface LocalEngineFacts {
  /** Version reported by the local engine, or null. */
  readonly version: string | null;
  /** Integrity classification of `.deft/.cli/<platform>`. */
  readonly integrity: IntegrityResult;
}

export interface LadderFacts {
  /** Canonical committed pin. */
  readonly pinVersion: string | null;
  /** Version of the globally-reachable engine, or null when absent. */
  readonly globalEngineVersion: string | null;
  /** Local engine facts, or null when never installed. */
  readonly localEngine: LocalEngineFacts | null;
  /** The npm registry is reachable. */
  readonly registryUp: boolean;
  /** The global npm prefix is writable (false inside a sandbox). */
  readonly globalPrefixWritable: boolean;
  /** A pre-staged tarball / vendored payload is available for offline install. */
  readonly stagedTarballAvailable: boolean;
  /** Platform id (for trace / install target). */
  readonly platform: string;
}

export interface LadderDecision {
  readonly rung: LadderRung;
  /** True when the engine is resolved WITHOUT an install (global or local). */
  readonly usable: boolean;
  /** Version the ladder resolved to when usable, else null. */
  readonly resolvedVersion: string | null;
  /** Structured trace of every rung evaluated. */
  readonly trace: string;
  /** One-line reason for the chosen rung. */
  readonly reason: string;
}

function fmt(version: string | null): string {
  return version ?? "absent";
}

/**
 * Pure global-first ladder decision. Emits a structured trace describing each
 * rung it evaluated and why it was skipped or chosen.
 */
export function decideEngineLadder(facts: LadderFacts): LadderDecision {
  const { pinVersion } = facts;
  const steps: string[] = [];

  // Rung 1: global engine.
  if (facts.globalEngineVersion !== null && semverGte(facts.globalEngineVersion, pinVersion)) {
    steps.push(`global: ${fmt(facts.globalEngineVersion)} >= pin ${fmt(pinVersion)} -> use`);
    return {
      rung: "global",
      usable: true,
      resolvedVersion: facts.globalEngineVersion,
      trace: steps.join("; "),
      reason: `global engine ${facts.globalEngineVersion} satisfies pin ${fmt(pinVersion)}`,
    };
  }
  if (facts.globalEngineVersion === null) {
    steps.push("global: absent");
  } else {
    steps.push(`global: ${facts.globalEngineVersion} < pin ${fmt(pinVersion)}`);
  }

  // Rung 2: local sandbox engine (must be intact AND >= pin).
  const local = facts.localEngine;
  if (local !== null) {
    if (!local.integrity.usable) {
      steps.push(
        local.integrity.partial
          ? `local: partial install -> not-usable`
          : `local: ${local.integrity.reason}`,
      );
    } else if (!semverGte(local.version, pinVersion)) {
      steps.push(`local: ${fmt(local.version)} < pin ${fmt(pinVersion)}`);
    } else {
      steps.push(`local: ${fmt(local.version)} >= pin ${fmt(pinVersion)} -> use`);
      return {
        rung: "local",
        usable: true,
        resolvedVersion: local.version,
        trace: steps.join("; "),
        reason: `local engine ${local.version} satisfies pin ${fmt(pinVersion)}`,
      };
    }
  } else {
    steps.push("local: absent");
  }

  // Rung 3: must install.
  if (facts.registryUp && facts.globalPrefixWritable) {
    steps.push(`install: npm i -g @deftai/directive@${fmt(pinVersion)}`);
    return {
      rung: "install-global",
      usable: false,
      resolvedVersion: null,
      trace: steps.join("; "),
      reason: "registry up and global prefix writable -> global install",
    };
  }
  if (facts.registryUp && !facts.globalPrefixWritable) {
    steps.push(
      `install: npm install --prefix .deft/.cli/${facts.platform} @deftai/directive@${fmt(pinVersion)}`,
    );
    return {
      rung: "install-sandbox",
      usable: false,
      resolvedVersion: null,
      trace: steps.join("; "),
      reason: "registry up but global prefix not writable (sandbox) -> --prefix install",
    };
  }
  if (!facts.registryUp && facts.stagedTarballAvailable) {
    steps.push("install: staged tarball / vendored payload");
    return {
      rung: "install-staged",
      usable: false,
      resolvedVersion: null,
      trace: steps.join("; "),
      reason: "registry down but staged tarball available -> offline install",
    };
  }
  steps.push("hard-fail: registry down and no staged tarball");
  return {
    rung: "hard-fail",
    usable: false,
    resolvedVersion: null,
    trace: steps.join("; "),
    reason: "registry down and no staged tarball -- stage a payload to proceed",
  };
}

/** Outcome of a side-effecting engine install. */
export interface EngineInstallOutcome {
  readonly installed: boolean;
  /** Version the install produced, or null on failure. */
  readonly version: string | null;
  readonly detail: string;
}

/** Injected side-effecting install runner (npm i -g / --prefix / staged). */
export type EngineInstallRunner = (context: {
  readonly rung: Extract<LadderRung, "install-global" | "install-sandbox" | "install-staged">;
  readonly pinVersion: string | null;
  readonly platform: string;
}) => EngineInstallOutcome;

/** Injected content re-projection (`update`) run after a fresh install. */
export type ReprojectRunner = (version: string | null) => void;

export interface ResolveEngineOptions {
  readonly installRunner?: EngineInstallRunner;
  readonly reproject?: ReprojectRunner;
}

export interface EngineResolution {
  readonly decision: LadderDecision;
  /** The install outcome when a rung required an install, else null. */
  readonly installOutcome: EngineInstallOutcome | null;
  /** The engine version resolved after any install, or null when unresolved. */
  readonly resolvedVersion: string | null;
  /** True when the ladder healed a mismatch (installed) with zero manual steps. */
  readonly selfHealed: boolean;
  /** Full structured trace including any install + re-projection. */
  readonly trace: string;
}

const INSTALL_RUNGS: ReadonlySet<LadderRung> = new Set([
  "install-global",
  "install-sandbox",
  "install-staged",
]);

/**
 * Resolve the engine by composing the pure ladder decision with an injected
 * install runner. When a rung requires an install, the runner performs it and
 * (on success) the re-projection runner forward-migrates content — yielding the
 * "self-heals with zero manual npm/PATH steps" behavior with a structured trace.
 */
export function resolveEngine(
  facts: LadderFacts,
  options: ResolveEngineOptions = {},
): EngineResolution {
  const decision = decideEngineLadder(facts);
  const steps = [decision.trace];

  if (decision.usable) {
    return {
      decision,
      installOutcome: null,
      resolvedVersion: decision.resolvedVersion,
      selfHealed: false,
      trace: steps.join("; "),
    };
  }

  if (decision.rung === "hard-fail" || !INSTALL_RUNGS.has(decision.rung)) {
    return {
      decision,
      installOutcome: null,
      resolvedVersion: null,
      selfHealed: false,
      trace: steps.join("; "),
    };
  }

  const runner = options.installRunner;
  if (!runner) {
    steps.push("install: deferred (no install runner supplied)");
    return {
      decision,
      installOutcome: null,
      resolvedVersion: null,
      selfHealed: false,
      trace: steps.join("; "),
    };
  }

  const outcome = runner({
    rung: decision.rung as "install-global" | "install-sandbox" | "install-staged",
    pinVersion: facts.pinVersion,
    platform: facts.platform,
  });

  if (!outcome.installed) {
    steps.push(`install failed: ${outcome.detail}`);
    return {
      decision,
      installOutcome: outcome,
      resolvedVersion: null,
      selfHealed: false,
      trace: steps.join("; "),
    };
  }

  steps.push(`installed ${decision.rung} -> ${fmt(outcome.version)}`);
  if (options.reproject) {
    options.reproject(outcome.version);
    steps.push(`re-projected content ${fmt(outcome.version)}`);
  }

  return {
    decision,
    installOutcome: outcome,
    resolvedVersion: outcome.version,
    selfHealed: true,
    trace: steps.join("; "),
  };
}
