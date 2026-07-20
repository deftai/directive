import { spawnSync } from "node:child_process";
import { loadProjectDefinition } from "../policy/resolve.js";
import { loadStalenessTicklerPolicy } from "../policy/staleness-tickler.js";
import { runXbriefMigration } from "../xbrief-migrate/migrate-project.js";
import {
  holdTierOnUnverified,
  isSnoozeActive,
  mergeHeldXbriefDistance,
  resolveTier,
  scoreDrift,
  shouldPromptDespiteSnooze,
  snoozeWindowMs,
} from "./escalation.js";
import {
  type IdleGateOptions,
  isInteractiveSession,
  isSafeIdlePoint,
  shouldSkipTicklerEntirely,
} from "./idle.js";
import { type ProbeDirectiveOptions, probeDirectiveStaleness } from "./probe-directive.js";
import { type ProbeXbriefOptions, probeXbriefStaleness } from "./probe-xbrief.js";
import { loadStalenessTicklerState, saveStalenessTicklerState } from "./state.js";
import type {
  DriftInputs,
  StalenessProbeResult,
  StalenessTicklerRunResult,
  StalenessTicklerState,
  StalenessTicklerTier,
} from "./types.js";

export const DIRECTIVE_UPGRADE_COMMAND = "npm i -g @deftai/directive@latest";
export const XBRIEF_MIGRATE_COMMAND = "deft migrate:xbrief";

export interface StalenessTicklerOptions {
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly idle?: IdleGateOptions;
  readonly probeDirective?: ProbeDirectiveOptions;
  readonly probeXbrief?: ProbeXbriefOptions;
  readonly askConsent?: (prompt: string) => "yes" | "no" | "snooze" | "remind";
  readonly isInteractive?: boolean;
  readonly executeUpgrade?: boolean;
  readonly runUpgrade?: () => { ok: boolean; message: string };
  readonly runMigrate?: (projectRoot: string) => { ok: boolean; message: string };
}

const TIER_TONE: Record<StalenessTicklerTier, string> = {
  quiet: "note",
  notice: "recommend",
  strong: "strongly recommend",
  assert: "assert",
};

function defaultAskConsent(_prompt: string): "yes" | "no" | "snooze" | "remind" {
  return "snooze";
}

function defaultRunUpgrade(): { ok: boolean; message: string } {
  const result = spawnSync("npm", ["i", "-g", "@deftai/directive@latest"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status === 0) {
    return { ok: true, message: "Directive upgrade completed." };
  }
  const stderr = (result.stderr ?? "").trim();
  return {
    ok: false,
    message: stderr.length > 0 ? stderr : `npm exited with status ${result.status ?? "unknown"}`,
  };
}

function defaultRunMigrate(projectRoot: string): { ok: boolean; message: string } {
  const io = { writeOut: () => {}, writeErr: () => {} };
  const outcome = runXbriefMigration({ projectRoot }, io);
  if (outcome.kind === "migrated") {
    return {
      ok: true,
      message: `xBRIEF migration completed (${outcome.files} files; backup ${outcome.backupDir}).`,
    };
  }
  if (outcome.kind === "converged" || outcome.kind === "noop") {
    return { ok: true, message: outcome.message };
  }
  return { ok: false, message: outcome.message };
}

export function probeStalenessDimensions(
  projectRoot: string,
  options: StalenessTicklerOptions = {},
): StalenessProbeResult {
  const directiveProbe = probeDirectiveStaleness(projectRoot, {
    env: options.env,
    ...options.probeDirective,
  });
  const xbrief = probeXbriefStaleness(projectRoot, options.probeXbrief);
  const directive = directiveProbe
    ? {
        availability: directiveProbe.availability,
        majorBehind: directiveProbe.majorBehind,
        minorDistance: directiveProbe.minorDistance,
        patchDistance: directiveProbe.patchDistance,
        stale: directiveProbe.stale,
      }
    : {
        availability: {
          status: "unverified" as const,
          installedVersion: "0.0.0",
          latestVersion: null,
          resolver: "npm-view" as const,
        },
        majorBehind: false,
        minorDistance: 0,
        patchDistance: 0,
        stale: false,
      };
  const anyStale = directive.stale || xbrief.stale;
  return {
    directive,
    xbrief,
    anyStale,
    directiveRegistryDisclosure: directiveProbe?.registryDisclosure,
  };
}

function formatDimensionLines(probe: StalenessProbeResult): string[] {
  const lines: string[] = [];
  if (probe.directive.stale && probe.directive.availability.status === "available") {
    lines.push(
      `[deft staleness] Directive payload behind: installed v${probe.directive.availability.installedVersion}, ` +
        `latest v${probe.directive.availability.latestVersion}. Run \`${DIRECTIVE_UPGRADE_COMMAND}\`.`,
    );
  }
  if (probe.xbrief.stale) {
    lines.push(
      `[deft staleness] xBRIEF schema ${probe.xbrief.distance}: declared ${probe.xbrief.declaredVersion ?? "unknown"}, ` +
        `framework ${probe.xbrief.targetVersion}. Run \`${XBRIEF_MIGRATE_COMMAND}\`.`,
    );
  }
  return lines;
}

function buildPromptLine(tier: StalenessTicklerTier, probe: StalenessProbeResult): string {
  const tone = TIER_TONE[tier];
  const actions: string[] = [];
  if (probe.directive.stale) {
    actions.push("upgrade Directive");
  }
  if (probe.xbrief.stale) {
    actions.push("migrate xBRIEF");
  }
  const actionText = actions.join(" and ");
  if (tier === "assert") {
    return (
      `[deft staleness:${tone}] Version drift is compounding (${actionText}). ` +
      "Plain snooze is unavailable — choose yes, opt-out via plan.policy.stalenessTickler.optOut, " +
      "or remind after next release."
    );
  }
  return `[deft staleness:${tone}] ${actionText} now? [y/n/s]`;
}

function nextStateAfterPrompt(
  previous: StalenessTicklerState,
  tier: StalenessTicklerTier,
  score: number,
  now: Date,
  choice: "yes" | "no" | "snooze" | "remind" | "headless-advisory",
  policy: ReturnType<typeof loadStalenessTicklerPolicy>,
  probe: StalenessProbeResult,
): StalenessTicklerState {
  const deferralCount =
    choice === "snooze" || choice === "no" || choice === "headless-advisory"
      ? (previous.deferralCount ?? 0) + 1
      : (previous.deferralCount ?? 0);
  const windowMs =
    choice === "remind" ? policy.snooze.quietMs : snoozeWindowMs(tier, deferralCount, policy);
  const snoozedUntil = new Date(now.getTime() + windowMs).toISOString();
  return {
    firstDetectedAt: previous.firstDetectedAt ?? now.toISOString(),
    lastTier: tier,
    lastScore: score,
    lastPromptAt: now.toISOString(),
    deferralCount,
    snoozedUntil,
    heldDirectiveLatest:
      probe.directive.availability.status === "available" ||
      probe.directive.availability.status === "current"
        ? probe.directive.availability.latestVersion
        : (previous.heldDirectiveLatest ?? null),
    heldXbriefDistance: mergeHeldXbriefDistance(probe.xbrief.distance, previous.heldXbriefDistance),
    remindAfterNextRelease: choice === "remind" ? true : previous.remindAfterNextRelease,
  };
}

/**
 * Maybe run the staleness tickler at a safe idle point (#2488 + #2489).
 * Best-effort and non-fatal — callers should wrap in try/catch.
 */
export function maybeRunStalenessTickler(
  projectRoot: string,
  options: StalenessTicklerOptions = {},
): StalenessTicklerRunResult {
  const env = options.env ?? process.env;
  if (shouldSkipTicklerEntirely(env)) {
    return { lines: [], prompted: false, skippedReason: "ritual-skip" };
  }

  const [data] = loadProjectDefinition(projectRoot);
  const policy = loadStalenessTicklerPolicy(data);
  const idle = isSafeIdlePoint(projectRoot, policy, { env, ...options.idle });
  if (!idle.ok) {
    return { lines: [], prompted: false, skippedReason: idle.reason };
  }

  const now = options.now ?? new Date();
  const state = loadStalenessTicklerState(projectRoot);
  const probe = probeStalenessDimensions(projectRoot, options);
  if (!probe.anyStale) {
    if (
      state.firstDetectedAt !== undefined ||
      state.lastTier !== undefined ||
      state.snoozedUntil !== undefined
    ) {
      saveStalenessTicklerState(projectRoot, {});
    }
    return { lines: [], prompted: false, skippedReason: "current" };
  }

  const directiveUnverified = probe.directive.availability.status === "unverified";
  const xbriefDistance =
    directiveUnverified && state.heldXbriefDistance !== undefined
      ? mergeHeldXbriefDistance(probe.xbrief.distance, state.heldXbriefDistance)
      : probe.xbrief.distance;
  const ageMs =
    state.firstDetectedAt !== undefined
      ? Math.max(0, now.getTime() - Date.parse(state.firstDetectedAt))
      : 0;
  const inputs: DriftInputs = {
    directive: probe.directive,
    xbrief: {
      ...probe.xbrief,
      distance: xbriefDistance,
      stale: xbriefDistance !== "current",
    },
    ageMs,
    deferralCount: state.deferralCount ?? 0,
  };
  const computedScore = scoreDrift(inputs, policy);
  const computedTier = resolveTier(inputs, policy);
  const { score, tier } = holdTierOnUnverified(
    computedTier,
    computedScore,
    state,
    directiveUnverified,
  );

  if (isSnoozeActive(state, now) && !shouldPromptDespiteSnooze(tier, state)) {
    return { lines: [], prompted: false, skippedReason: "snoozed" };
  }

  const lines: string[] = [];
  if (probe.directiveRegistryDisclosure) {
    lines.push(probe.directiveRegistryDisclosure);
  }
  lines.push(...formatDimensionLines(probe));
  lines.push(buildPromptLine(tier, probe));

  const interactive = options.isInteractive ?? isInteractiveSession(env);
  let choice: "yes" | "no" | "snooze" | "remind" | "headless-advisory";
  if (!interactive) {
    lines.push(
      "[deft staleness] Non-interactive session — recommendation recorded; " +
        "decline with plan.policy.stalenessTickler.optOut or wait for snooze window.",
    );
    choice = "headless-advisory";
  } else {
    const ask = options.askConsent ?? defaultAskConsent;
    const response = ask(lines.join("\n"));
    if (tier === "assert" && response === "snooze") {
      choice = "remind";
      lines.push("[deft staleness] Assert tier: treating snooze as remind-after-next-release.");
    } else {
      choice = response;
    }
  }

  if (choice === "yes") {
    const runUpgrade = options.runUpgrade ?? defaultRunUpgrade;
    const runMigrate = options.runMigrate ?? defaultRunMigrate;
    if (probe.directive.stale) {
      lines.push(`[deft staleness] Running \`${DIRECTIVE_UPGRADE_COMMAND}\`…`);
      const upgrade = runUpgrade();
      lines.push(
        upgrade.ok
          ? `[deft staleness] ${upgrade.message}`
          : `[deft staleness] Upgrade failed (non-fatal): ${upgrade.message}`,
      );
    }
    if (probe.xbrief.stale) {
      lines.push(`[deft staleness] Running xBRIEF migration…`);
      const migrate = runMigrate(projectRoot);
      lines.push(
        migrate.ok
          ? `[deft staleness] ${migrate.message}`
          : `[deft staleness] Migration failed (non-fatal): ${migrate.message}`,
      );
    }
  }

  saveStalenessTicklerState(
    projectRoot,
    nextStateAfterPrompt(state, tier, score, now, choice, policy, probe),
  );
  return { lines, prompted: true };
}
