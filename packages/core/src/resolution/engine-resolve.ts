/**
 * Engine reachability resolution (AC12.6).
 *
 * Replaces the retired global-first engine ladder. Never auto-installs
 * (AC12.5); missing/unusable engines point at AC9.7 recovery.
 */

import type { IntegrityResult } from "./integrity.js";
import { semverGte } from "./pin.js";

export interface LocalEngineFacts {
  readonly version: string | null;
  readonly integrity: IntegrityResult;
}

export interface EngineFacts {
  readonly pinVersion: string | null;
  readonly globalEngineVersion: string | null;
  readonly localEngine: LocalEngineFacts | null;
  readonly platform: string;
}

export interface EngineDecision {
  /** True when a reachable engine already satisfies the pin. */
  readonly usable: boolean;
  readonly resolvedVersion: string | null;
  readonly trace: string;
  readonly reason: string;
}

function fmt(version: string | null): string {
  return version ?? "absent";
}

/**
 * Pure decision: use global or local engine when it satisfies the pin;
 * otherwise report unusable (caller prints AC9.7 — never auto-installs).
 */
export function decideEngineAvailability(facts: EngineFacts): EngineDecision {
  const { pinVersion } = facts;
  const steps: string[] = [];

  if (facts.globalEngineVersion !== null && semverGte(facts.globalEngineVersion, pinVersion)) {
    steps.push(`global: ${fmt(facts.globalEngineVersion)} >= pin ${fmt(pinVersion)} -> use`);
    return {
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

  const local = facts.localEngine;
  if (local !== null) {
    if (!local.integrity.usable) {
      steps.push(
        local.integrity.partial
          ? "local: partial install -> not-usable"
          : `local: ${local.integrity.reason}`,
      );
    } else if (!semverGte(local.version, pinVersion)) {
      steps.push(`local: ${fmt(local.version)} < pin ${fmt(pinVersion)}`);
    } else {
      steps.push(`local: ${fmt(local.version)} >= pin ${fmt(pinVersion)} -> use`);
      return {
        usable: true,
        resolvedVersion: local.version,
        trace: steps.join("; "),
        reason: `local engine ${local.version} satisfies pin ${fmt(pinVersion)}`,
      };
    }
  } else {
    steps.push("local: absent");
  }

  steps.push("unresolved: recover with npm i -g @deftai/directive, then directive install --repair");
  return {
    usable: false,
    resolvedVersion: null,
    trace: steps.join("; "),
    reason:
      "no usable engine for pin; recover with npm i -g @deftai/directive, then directive install --repair",
  };
}

/** Legacy install-runner seam retained as a no-op type for refresh callers. */
export type EngineInstallRunner = (context: {
  readonly pinVersion: string | null;
  readonly platform: string;
}) => { installed: boolean; version: string | null; detail: string };

export type ReprojectRunner = (version: string | null) => void;

export interface ResolveEngineOptions {
  readonly installRunner?: EngineInstallRunner;
  readonly reproject?: ReprojectRunner;
}

export interface EngineResolution {
  readonly decision: EngineDecision;
  readonly installOutcome: null;
  readonly resolvedVersion: string | null;
  readonly selfHealed: false;
  readonly trace: string;
}

/**
 * Resolve engine availability. Never installs (AC12.5 / AC12.6).
 */
export function resolveEngine(
  facts: EngineFacts,
  options: ResolveEngineOptions = {},
): EngineResolution {
  void options.installRunner;
  void options.reproject;
  const decision = decideEngineAvailability(facts);
  return {
    decision,
    installOutcome: null,
    resolvedVersion: decision.resolvedVersion,
    selfHealed: false,
    trace: decision.trace,
  };
}
