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
 */

import type { PlanPolicy, ResolutionFacts, ResolutionPlan } from "@deftai/directive-types";
import { RESOLUTION_PLAN_SCHEMA_VERSION } from "@deftai/directive-types";
import type { LadderDecision, LadderRung } from "./engine-ladder.js";
import { reconcileVersions } from "./pin.js";
import { evaluateSkew, type SkewResult } from "./skew-policy.js";

export interface PlanOptions {
  /**
   * Pre-computed engine ladder decision, supplied when the global engine is
   * unreachable and the caller resolved it via `decideEngineLadder`/`resolveEngine`
   * (warm sandbox / cold sandbox / registry-down). When omitted, `plan()` uses the
   * in-process reachable engine facts.
   */
  readonly engineResolution?: LadderDecision | null;
  /** Pre-computed skew result; when omitted `plan()` computes it from facts + policy. */
  readonly skew?: SkewResult | null;
  /** Interactive session (a human can answer a skew prompt). */
  readonly interactive?: boolean;
  /** Environment map for the `DEFT_ACCEPT_ENGINE_SKEW` escape hatch. */
  readonly env?: NodeJS.ProcessEnv;
  /** The `--accept-engine-jump` flag was supplied. */
  readonly acceptEngineJump?: boolean;
  /** Platform id, used only to render the sandbox install command. */
  readonly platform?: string;
}

const RUNG_TO_MODE: Record<LadderRung, ResolutionPlan["mode"]> = {
  global: "proceed",
  local: "proceed",
  "install-global": "install-global",
  "install-sandbox": "install-sandbox",
  "install-staged": "install-staged",
  "hard-fail": "blocked",
};

function pinSuffix(pinVersion: string | null): string {
  return pinVersion ? `@${pinVersion}` : "@<pin>";
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

/** Resolve the effective engine version from either the ladder decision or in-process facts. */
function effectiveEngineVersion(
  facts: ResolutionFacts,
  engineResolution: LadderDecision | null | undefined,
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
 */
export function plan(
  facts: ResolutionFacts,
  policy: PlanPolicy = {},
  options: PlanOptions = {},
): ResolutionPlan {
  const warnings: string[] = [];
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
    const rootCause = facts.hasManagedSection
      ? "AGENTS.md carries a managed section but the .deft/core/ payload is absent (hybrid deposit not reconstituted)"
      : facts.hasAppCode || facts.hasGit
        ? "brownfield project without a Deft deposit"
        : "greenfield project without a Deft deposit";
    return makePlan(
      "init",
      {
        command: "npx @deftai/directive init",
        rootCause,
        remediation: "Deposit (or reconstitute) the .deft/core/ payload with `directive init`.",
      },
      warnings,
    );
  }

  // Row 3+: deposit present — resolve the engine dimension.
  const engineResolution = options.engineResolution ?? null;

  // 3a: a supplied ladder decision that requires an install (global engine
  // unreachable path: warm/cold sandbox, registry-down).
  if (engineResolution && !engineResolution.usable) {
    const mode = RUNG_TO_MODE[engineResolution.rung];
    return planForInstallRung(engineResolution, mode, facts, options, warnings);
  }

  const effectiveEngine = effectiveEngineVersion(facts, engineResolution);

  // 3b: no engine reachable and no ladder resolution supplied — cannot resolve.
  if (effectiveEngine === null) {
    return makePlan(
      "blocked",
      {
        command: null,
        rootCause: "no Directive engine is reachable in the execution environment",
        remediation:
          "Resolve the engine via the global-first ladder (resolveEngine) / bootstrap before running any gate.",
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

  // 3d: reconcile engine against the pin via the three-band skew policy.
  const skew =
    options.skew ??
    evaluateSkew(effectiveEngine, facts.pinVersion, {
      engineSkewWindow: policy.engineSkewWindow,
      acceptEngineJump: options.acceptEngineJump,
      interactive: options.interactive,
      env: options.env,
    });
  if (skew.message) warnings.push(skew.message);

  switch (skew.decision) {
    case "reject-global":
      return makePlan(
        "install-global",
        {
          command: `npm i -g @deftai/directive${pinSuffix(facts.pinVersion)}`,
          rootCause: `engine ${effectiveEngine} is behind pin ${facts.pinVersion}`,
          remediation: "Install the pinned engine (or fall through the ladder to a local install).",
        },
        warnings,
      );
    case "fail-closed":
      return makePlan(
        "blocked",
        {
          command: `directive <gate> --accept-engine-jump`,
          rootCause: `engine ${effectiveEngine} is a large jump ahead of pin ${facts.pinVersion}`,
          remediation:
            "Confirm the jump with --accept-engine-jump or DEFT_ACCEPT_ENGINE_SKEW=1 after reviewing the delta.",
        },
        warnings,
      );
    case "prompt":
      return makePlan(
        "blocked",
        {
          command: null,
          rootCause: `engine ${effectiveEngine} is a large jump ahead of pin ${facts.pinVersion} (interactive)`,
          remediation:
            "Prompt the operator to confirm the engine jump, or pass --accept-engine-jump.",
        },
        warnings,
      );
    default: {
      // proceed-silent | proceed-loud-update
      if (skew.requiresUpdateFirst || contentStale(facts)) {
        return makePlan(
          "update",
          {
            command: "npx @deftai/directive update",
            rootCause: skew.requiresUpdateFirst
              ? `engine ${effectiveEngine} is ahead of pin ${facts.pinVersion} within the skew window`
              : `deposited content is behind pin ${facts.pinVersion}`,
            remediation: "Forward-migrate content with `directive update`, then run the gate.",
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

function planForInstallRung(
  engineResolution: LadderDecision,
  mode: ResolutionPlan["mode"],
  facts: ResolutionFacts,
  options: PlanOptions,
  warnings: readonly string[],
): ResolutionPlan {
  const platform = options.platform ?? "<platform>";
  const pinnedSuffix = pinSuffix(facts.pinVersion);
  const withTrace = [...warnings, `ladder: ${engineResolution.trace}`];
  switch (mode) {
    case "install-global":
      return makePlan(
        "install-global",
        {
          command: `npm i -g @deftai/directive${pinnedSuffix}`,
          rootCause: engineResolution.reason,
          remediation: "Install the pinned engine into the global npm prefix.",
        },
        withTrace,
      );
    case "install-sandbox":
      return makePlan(
        "install-sandbox",
        {
          command: `npm install --prefix .deft/.cli/${platform} @deftai/directive${pinnedSuffix}`,
          rootCause: engineResolution.reason,
          remediation:
            "Install the pinned engine into the sandbox-local .deft/.cli/<platform> prefix.",
        },
        withTrace,
      );
    case "install-staged":
      return makePlan(
        "install-staged",
        {
          command: null,
          rootCause: engineResolution.reason,
          remediation: "Install from the pre-staged tarball / vendored payload (registry is down).",
        },
        withTrace,
      );
    default:
      return makePlan(
        "blocked",
        {
          command: null,
          rootCause: engineResolution.reason,
          remediation: "Stage a Directive payload (registry down and no staged tarball).",
        },
        withTrace,
      );
  }
}
