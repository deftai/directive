/**
 * The single ordered precedence table for the resolution spine (#2264 / epic #2203).
 *
 * `plan()` takes the orthogonal fact-set from `classify()` and collapses it into
 * exactly ONE recommended action, emitting the versioned public
 * {@link ResolutionPlan} schema. This is the single source of truth every
 * consumption context (init / update / doctor / headless) derives from — there
 * is no second classifier downstream (closes the #537 split-source drift risk).
 *
 * SCOPE (keystone): this delivers the decision spine. It does NOT rewire the
 * user-facing behavior of init / update / doctor / headless (children B–E,
 * #2265–#2268), which consume `plan()`. The `files` array is therefore empty in
 * the spine; downstream children populate it.
 *
 * AC12.6: no engine ladder, skew windows, or accept-engine escape hatches.
 */

import type {
  PlanPolicy,
  ResolutionFacts,
  ResolutionFile,
  ResolutionPlan,
} from "@deftai/directive-types";
import { RESOLUTION_PLAN_SCHEMA_VERSION } from "@deftai/directive-types";
import {
  contentMatchesEngine,
  evaluateEnginePin,
  type EnginePinResult,
} from "./engine-pin.js";
import type { EngineDecision } from "./engine-resolve.js";
import { type PackageManager, renderEphemeral } from "./package-manager.js";
import { reconcileVersions } from "./pin.js";

export interface PlanOptions {
  /**
   * Pre-computed engine availability decision when the in-process engine is
   * unreachable. When omitted, `plan()` uses the in-process reachable engine facts.
   */
  readonly engineResolution?: EngineDecision | null;
  /** Pre-computed engine/pin result; when omitted `plan()` computes it. */
  readonly enginePin?: EnginePinResult | null;
  /** Platform id (trace only). */
  readonly platform?: string;
  /**
   * Files a downstream consumer has already materialised for the plan to carry
   * in {@link ResolutionPlan.files}. The keystone spine leaves `files` empty;
   * children (the #2268 headless emitter) collect the file set out-of-band and
   * thread it here so the emitted manifest is single-sourced from `plan()`
   * rather than a separate "what would init produce" reimplementation. When
   * omitted, `files` stays empty exactly as before.
   */
  readonly files?: readonly ResolutionFile[];
  /**
   * Active package manager for rendering install/upgrade command strings
   * (#2197). Defaults to npm so existing behaviour and tests are unchanged;
   * callers detect the manager via `detectPackageManager()` and thread it here.
   */
  readonly packageManager?: PackageManager;
  /** #4443: linked worktree missing hybrid payload uses local update, not init. */
  readonly linkedWorktree?: boolean;
}

function makePlan(
  mode: ResolutionPlan["mode"],
  nextAction: ResolutionPlan["nextAction"],
  warnings: readonly string[],
): ResolutionPlan {
  return {
    schemaVersion: RESOLUTION_PLAN_SCHEMA_VERSION,
    mode,
    files: [],
    nextAction,
    warnings,
  };
}

function legacyVbriefWarning(facts: ResolutionFacts): string | null {
  if (facts.hasVbrief && !facts.hasXbrief) {
    return "legacy vbrief/ tree present without xbrief/; run `directive migrate:xbrief`";
  }
  return null;
}

/** Resolve the effective engine version from either a decision or in-process facts. */
function effectiveEngineVersion(
  facts: ResolutionFacts,
  engineResolution: EngineDecision | null | undefined,
): string | null {
  if (engineResolution?.usable) return engineResolution.resolvedVersion;
  if (facts.engineReachable) return facts.engineVersion;
  return null;
}

function contentStale(facts: ResolutionFacts): boolean {
  const recon = reconcileVersions({
    pinVersion: facts.pinVersion,
    engineVersion: facts.engineVersion,
    contentVersion: facts.deftCorePayloadVersion,
    managedSectionSha: facts.managedSectionSha,
  });
  if (recon.contentBehindPin) return true;
  // A deposit that carries no readable managed-section sha is treated as stale.
  if (facts.hasManagedSection && facts.managedSectionSha === null) return true;
  return false;
}

/**
 * The single ordered precedence table. First matching row wins; each `plan()`
 * call returns exactly one recommended action.
 *
 * When `options.files` is supplied, the resolved plan carries that file set in
 * {@link ResolutionPlan.files} (the #2268 headless single-sourcing seam); the
 * precedence decision itself is unchanged. With no `files` option the array
 * stays empty exactly as the keystone spine emitted it.
 */
export function plan(
  facts: ResolutionFacts,
  policy: PlanPolicy = {},
  options: PlanOptions = {},
): ResolutionPlan {
  void policy;
  const resolved = resolvePlan(facts, options);
  const files = options.files ?? [];
  return files.length === 0 ? resolved : { ...resolved, files };
}

function resolvePlan(facts: ResolutionFacts, options: PlanOptions): ResolutionPlan {
  const warnings: string[] = [];
  const pm: PackageManager = options.packageManager ?? "npm";
  const legacyWarning = legacyVbriefWarning(facts);
  if (legacyWarning) warnings.push(legacyWarning);

  // Row 1: pre-cutover artifacts must migrate before anything else.
  if (facts.preCutoverArtifacts) {
    return makePlan(
      "migrate",
      {
        command: null,
        rootCause: "pre-v0.20 document-model artifacts detected",
        remediation:
          "Migrate with the frozen pre-v0.20 bridge before any gate runs. See UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).",
      },
      warnings,
    );
  }

  // Row 2: no usable deposit — deposit / reconstitute one.
  if (!facts.hasDeftCore) {
    if (options.linkedWorktree && facts.hasManagedSection) {
      return makePlan(
        "update",
        {
          command: "directive update",
          rootCause:
            "linked worktree is missing the .deft/core/ payload (hybrid deposit not reconstituted)",
          remediation:
            "Reconstitute .deft/core from the local content payload with `directive update` (no network init).",
        },
        warnings,
      );
    }
    const rootCause = facts.hasManagedSection
      ? "AGENTS.md carries a managed section but the .deft/core/ payload is absent (hybrid deposit not reconstituted)"
      : facts.hasAppCode || facts.hasGit
        ? "brownfield project without a Deft deposit"
        : "greenfield project without a Deft deposit";
    return makePlan(
      "init",
      {
        command: renderEphemeral(pm, "init"),
        rootCause,
        remediation: "Deposit (or reconstitute) the .deft/core/ payload with `directive init`.",
      },
      warnings,
    );
  }

  // Row 3+: deposit present — resolve the engine dimension.
  const engineResolution = options.engineResolution ?? null;

  // 3a: supplied decision says engine is not usable → AC9.7 (AC12.5/AC12.6).
  if (engineResolution && !engineResolution.usable) {
    const withTrace = [...warnings, `engine: ${engineResolution.trace}`];
    return makePlan(
      "blocked",
      {
        command: null,
        rootCause: engineResolution.reason,
        remediation: "npm i -g @deftai/directive, then directive install --repair",
      },
      withTrace,
    );
  }

  const effectiveEngine = effectiveEngineVersion(facts, engineResolution);

  // 3b: no engine reachable and no usable resolution supplied — cannot resolve.
  if (effectiveEngine === null) {
    return makePlan(
      "blocked",
      {
        command: null,
        rootCause: "no Directive engine is reachable in the execution environment",
        remediation: "npm i -g @deftai/directive, then directive install --repair",
      },
      warnings,
    );
  }

  // 3c: no committed pin — cannot reconcile; proceed but warn.
  if (facts.pinVersion === null) {
    warnings.push(
      "no committed package.json pin on @deftai/directive; skipping engine/pin reconciliation",
    );
    return makePlan(
      "proceed",
      {
        command: null,
        rootCause: `engine ${effectiveEngine} reachable; no pin to reconcile against`,
        remediation: "Run the requested gate. Consider committing an exact pin (unblocks #2269).",
      },
      warnings,
    );
  }

  // 3d: reconcile engine against the pin (no skew windows / escape hatches — AC12.6).
  const pinResult = options.enginePin ?? evaluateEnginePin(effectiveEngine, facts.pinVersion);
  if (pinResult.message) warnings.push(pinResult.message);

  switch (pinResult.decision) {
    case "reject-global":
      return makePlan(
        "blocked",
        {
          command: null,
          rootCause: `reachable engine ${effectiveEngine} is behind pin ${facts.pinVersion}`,
          remediation: "npm i -g @deftai/directive, then directive install --repair",
        },
        warnings,
      );
    case "fail-closed":
      return makePlan(
        "blocked",
        {
          command: null,
          rootCause: `engine ${effectiveEngine} differs from pin ${facts.pinVersion}`,
          remediation: "npm i -g @deftai/directive, then directive install --repair",
        },
        warnings,
      );
    default: {
      // proceed-silent | proceed-loud-update
      if (
        pinResult.requiresUpdateFirst &&
        contentMatchesEngine(facts.deftCorePayloadVersion, effectiveEngine)
      ) {
        return makePlan(
          "blocked",
          {
            command: null,
            rootCause: `engine ${effectiveEngine} is ahead of pin ${facts.pinVersion}`,
            remediation: "npm i -g @deftai/directive, then directive install --repair",
          },
          warnings,
        );
      }
      if (pinResult.requiresUpdateFirst || contentStale(facts)) {
        return makePlan(
          "update",
          {
            command: null,
            rootCause: pinResult.requiresUpdateFirst
              ? `engine ${effectiveEngine} is ahead of pin ${facts.pinVersion}`
              : `deposited content is behind pin ${facts.pinVersion}`,
            remediation:
              "Run `directive upgrade` for deliberate version/schema changes; for install/wiring faults use `npm i -g @deftai/directive`, then `directive install --repair`.",
          },
          warnings,
        );
      }
      return makePlan(
        "proceed",
        {
          command: null,
          rootCause: `engine ${effectiveEngine} matches pin ${facts.pinVersion} and content is current`,
          remediation: "Run the requested gate.",
        },
        warnings,
      );
    }
  }
}
