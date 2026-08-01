import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureTriageCacheHydrated } from "../../cache/empty-populate.js";
import { maybeSelfHealCache } from "../../cache/fetch.js";
import { resolveProjectDefinitionPath } from "../../layout/resolve.js";
import { DEFAULT_WIP_CAP, SUBSCRIPTION_PRESETS, TRIAGE_SKILL_PATH } from "./constants.js";
import { formatWelcomeCommand } from "./default-mode.js";
import { detectPriorState } from "./prior-state.js";
import { emitOneliner } from "./summary.js";
import {
  previewWipRelief,
  subscriptionPreset,
  writeTriageScope,
  writeWipCap,
  writeWipCapDecision,
} from "./writers.js";

/** Default triage-scope preset applied when `--onboard` is run without `--preset`. */
export const DEFAULT_ONBOARD_PRESET = "small";

export interface OnboardOptions {
  /** Triage-scope preset key; defaults to {@link DEFAULT_ONBOARD_PRESET}. */
  readonly preset?: string | null;
  /** Explicit WIP cap to persist; omitted keeps the current/default cap. */
  readonly wipCap?: number | null;
  readonly output?: (line: string) => void;
  readonly writeHistory?: boolean;
  readonly taskPrefix?: string | null;
  readonly selfHealFn?: (projectRoot: string) => void;
  readonly now?: Date;
}

export interface OnboardOutcome {
  readonly exitCode: number;
  readonly presetApplied: string | null;
  readonly triageScopeChanged: boolean;
  readonly wipCapApplied: number | null;
  readonly wipCapChanged: boolean;
  readonly reliefOffered: boolean;
}

function failure(exitCode: number): OnboardOutcome {
  return {
    exitCode,
    presetApplied: null,
    triageScopeChanged: false,
    wipCapApplied: null,
    wipCapChanged: false,
    reliefOffered: false,
  };
}

/**
 * Non-interactive onboarding for `deft triage:welcome --onboard` (#2295).
 *
 * The welcome nudges point every fresh consumer at `--onboard`; this wires that
 * command to the already-tested core writers instead of the old "not
 * implemented" stub. It writes the chosen triage-scope preset and (optionally)
 * a WIP cap via {@link writeTriageScope} / {@link writeWipCap} -- which already
 * target the canonical `x-directive/policy` key and migrate any legacy bare
 * block -- previews WIP relief when at/over cap, then prints a completion
 * summary and the next-step guidance. Flag-driven by design: agents/CI pass
 * `--preset` / `--wip-cap`; sensible defaults apply otherwise.
 */
export function runOnboardMode(projectRoot: string, options: OnboardOptions = {}): OnboardOutcome {
  const out = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));

  const preset = (options.preset ?? DEFAULT_ONBOARD_PRESET).trim() || DEFAULT_ONBOARD_PRESET;
  if (!Object.hasOwn(SUBSCRIPTION_PRESETS, preset)) {
    out(
      `[welcome] Unknown --preset '${preset}'. Choose one of: ${Object.keys(SUBSCRIPTION_PRESETS).join(", ")}.`,
    );
    return failure(2);
  }

  const wipCap = options.wipCap ?? null;
  if (wipCap !== null && (!Number.isInteger(wipCap) || wipCap < 1)) {
    out(`[welcome] --wip-cap must be a positive integer, got ${JSON.stringify(options.wipCap)}.`);
    return failure(2);
  }

  let pdPath: string;
  try {
    pdPath = resolveProjectDefinitionPath(projectRoot);
  } catch {
    out(
      `[welcome] No xbrief/ layout found at ${projectRoot}. Run \`deft migrate:xbrief\` to convert your project from the legacy vbrief/ layout, or run project setup first (deft-directive-setup).`,
    );
    return failure(2);
  }
  if (!existsSync(pdPath)) {
    out(
      `[welcome] No project definition found at ${pdPath}. Run project setup first (deft-directive-setup) before onboarding triage.`,
    );
    return failure(2);
  }

  const heal =
    options.selfHealFn ??
    ((root: string) => {
      ensureTriageCacheHydrated(resolve(root));
      maybeSelfHealCache(resolve(root));
    });
  heal(projectRoot);

  const rules = subscriptionPreset(preset);
  const [triageScopeChanged] = writeTriageScope(projectRoot, rules, { presetLabel: preset });

  let wipCapChanged = false;
  if (wipCap !== null) {
    // writeWipCap also records out-of-band decision-provenance (#1694).
    [wipCapChanged] = writeWipCap(projectRoot, wipCap);
  } else {
    // Accepting the framework default is a real onboarding decision: record it
    // without materializing plan.policy.wipCap (#1694 / #1186 D1 / #1250).
    writeWipCapDecision(projectRoot, { acceptedDefault: true });
  }

  emitOneliner(projectRoot, {
    writeHistory: options.writeHistory !== false,
    now: options.now,
    output: out,
    applyD2Suppression: false,
  });

  const state = detectPriorState(projectRoot);
  let reliefOffered = false;
  if (state.wipCount >= state.wipCap) {
    const relief = previewWipRelief(projectRoot);
    if (relief.eligibleCount > 0) {
      reliefOffered = true;
      const demote = formatWelcomeCommand(
        ["scope:demote", "--batch", "--older-than-days", String(relief.olderThanDays)],
        options.taskPrefix,
      ).replace(/\r?\n/g, " ");
      const eligibleCount = String(relief.eligibleCount).replace(/\r?\n/g, " ");
      out(
        `[welcome] WIP ${state.wipCount}/${state.wipCap} at/over cap -- ${eligibleCount} pending scope(s) ` +
          `older than ${relief.olderThanDays}d are demote-eligible. Relieve with \`${demote}\`.`,
      );
    }
  }

  const capNote = wipCap !== null ? `, wipCap ${wipCap}` : ` (wipCap default ${DEFAULT_WIP_CAP})`;
  out(`[welcome] Onboarding applied: triage scope preset '${preset}'${capNote}.`);
  const bootstrap = formatWelcomeCommand(["triage:bootstrap"], options.taskPrefix);
  const queue = formatWelcomeCommand(["triage:queue", "--limit=10"], options.taskPrefix);
  out(
    `[welcome] Next: run \`${bootstrap}\` to populate the triage cache, then \`${queue}\` to pick work. See ${TRIAGE_SKILL_PATH}.`,
  );

  return {
    exitCode: 0,
    presetApplied: preset,
    triageScopeChanged,
    wipCapApplied: wipCap,
    wipCapChanged,
    reliefOffered,
  };
}
