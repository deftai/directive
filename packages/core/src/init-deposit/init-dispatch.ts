/**
 * Universal adoption dispatcher for `directive init` (#2265 / epic #2203).
 *
 * `directive init` is the ONE entrypoint a first-time adopter runs regardless of
 * their directory state. This module classifies the directory via the shared
 * keystone `classify()`/`plan()` fact-set (#2264, consumed read-only) and
 * dispatches to exactly one of four paths, always printing a concise state
 * summary plus exactly one recommended next action:
 *
 *   - `scaffold`           — empty greenfield dir; deposit Directive.
 *   - `brownfield-install` — app code but no Directive deposit; install support
 *                            beside the app code without disturbing it.
 *   - `delegate-update`    — already initialized; DELEGATE to `update` with an
 *                            explicit disclosure line. init never silently
 *                            refreshes under its own name (the #2199 anti-pattern)
 *                            and never re-scaffolds an existing install.
 *   - `route-migrate`      — legacy / pre-cutover layout; route to `migrate`.
 *
 * Logic is single-sourced: each delegate branch CALLS the existing narrow verb
 * (`runInitDepositCli` / `runRefreshDepositCli` / `runMigrateCli`) — the
 * dispatcher never re-implements deposit, refresh, or migrate behavior.
 */

import { resolve } from "node:path";
import type { ResolutionFacts, ResolutionPlan } from "@deftai/directive-types";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
} from "../policy/no-deft-directive.js";
import { type ClassifySeams, classify, plan } from "../resolution/index.js";
import { type RunInitDepositCliOptions, runInitDepositCli } from "./init-deposit.js";
import { type RunMigrateCliOptions, runMigrateCli } from "./migrate.js";
import { type RunRefreshDepositCliOptions, runRefreshDepositCli } from "./refresh.js";
import type { InitDepositIo } from "./scaffold.js";

/** The four adoption paths `directive init` dispatches into. */
export type InitDispatchDecision =
  | "scaffold"
  | "brownfield-install"
  | "delegate-update"
  | "route-migrate";

/** Human-readable state label per decision, used in the printed summary. */
export const INIT_DISPATCH_STATE_LABEL: Record<InitDispatchDecision, string> = {
  scaffold: "empty directory (greenfield)",
  "brownfield-install": "brownfield project (app code, no Directive deposit)",
  "delegate-update": "already initialized",
  "route-migrate": "legacy / pre-cutover layout",
};

/**
 * Explicit disclosure printed BEFORE delegating an already-initialized project
 * to `update`. Its presence is what keeps `init` from silently masquerading as
 * `update` (the #2199 anti-pattern): the user always sees that init delegated.
 */
export const UPDATE_DELEGATION_DISCLOSURE =
  "Existing install detected — refreshing via `update` (init delegates to update; it does not re-scaffold).";

/**
 * Collapse the shared resolution {@link ResolutionPlan} + fact-set onto one of
 * the four init dispatch decisions. There is no second classifier: `plan.mode`
 * is the single source of truth, and the empty-vs-brownfield split reads the
 * `hasAppCode`/`hasGit` facts already produced by `classify()`.
 */
export function decideInitDispatch(
  facts: ResolutionFacts,
  resolutionPlan: ResolutionPlan,
): InitDispatchDecision {
  if (resolutionPlan.mode === "migrate") return "route-migrate";
  if (resolutionPlan.mode === "init") {
    return facts.hasAppCode || facts.hasGit ? "brownfield-install" : "scaffold";
  }
  // Deposit present (proceed | update | install-* | blocked): the install exists,
  // so `update` owns the engine/content dimension. init delegates.
  return "delegate-update";
}

export interface InitDispatchClassification {
  readonly decision: InitDispatchDecision;
  readonly plan: ResolutionPlan;
  readonly facts: ResolutionFacts;
}

/**
 * Run the up-front dispatch classifier. Reuses the keystone `classify()`
 * fact-set + `plan()` precedence table — no second classifier lives here.
 */
export function classifyInitDispatch(
  projectDir: string,
  classifySeams: ClassifySeams = {},
): InitDispatchClassification {
  const facts = classify(projectDir, classifySeams);
  const resolutionPlan = plan(facts, {});
  return { decision: decideInitDispatch(facts, resolutionPlan), plan: resolutionPlan, facts };
}

/** The single recommended next-action line for a decision. */
export function initDispatchNextAction(
  decision: InitDispatchDecision,
  resolutionPlan: ResolutionPlan,
): string {
  switch (decision) {
    case "scaffold":
      return "Next: scaffolding a fresh Directive deposit (.deft/core, AGENTS.md managed section, xbrief/ layout).";
    case "brownfield-install":
      return "Next: installing Directive support beside your app code (app source is left untouched); then extract a brownfield spec and set up xbrief/.";
    case "delegate-update":
      return "Next: refreshing the existing install via `update`.";
    case "route-migrate":
      return `Next: routing to \`migrate\`. ${resolutionPlan.nextAction.remediation}`;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled init dispatch decision: ${String(exhaustive)}`);
    }
  }
}

/** Print the concise state summary + exactly one recommended next action. */
export function printInitDispatchSummary(
  io: InitDepositIo,
  decision: InitDispatchDecision,
  resolutionPlan: ResolutionPlan,
): void {
  io.printf(`\n[directive init] State: ${INIT_DISPATCH_STATE_LABEL[decision]}\n`);
  io.printf(`[directive init] ${initDispatchNextAction(decision, resolutionPlan)}\n`);
  for (const warning of resolutionPlan.warnings) {
    io.printf(`[directive init] Note: ${warning}\n`);
  }
}

/** Machine-readable payload emitted for `--dry-run`/`--plan` (no execution). */
export function buildInitDispatchDryRunJson(
  projectDir: string,
  classification: InitDispatchClassification,
): Record<string, unknown> {
  return {
    success: true,
    action: "init",
    dry_run: true,
    dispatch: classification.decision,
    mode: classification.plan.mode,
    project_dir: projectDir,
    next_action: classification.plan.nextAction,
    warnings: classification.plan.warnings,
  };
}

/**
 * Injectable delegate seams. Defaults are the real narrow-verb CLIs; tests
 * inject fakes to assert single-sourced delegation without touching the fs.
 */
export interface InitDispatchSeams {
  readonly classifySeams?: ClassifySeams;
  readonly runScaffold?: (options: RunInitDepositCliOptions) => Promise<number>;
  readonly runRefresh?: (options: RunRefreshDepositCliOptions) => Promise<number>;
  readonly runMigrate?: (options: RunMigrateCliOptions) => number;
}

export interface RunInitDispatchCliOptions {
  readonly projectDir: string;
  readonly jsonOut: boolean;
  readonly nonInteractive: boolean;
  /** `--dry-run`/`--plan`: print the classified plan without executing. */
  readonly dryRun: boolean;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: InitDispatchSeams;
}

/**
 * CLI-facing entrypoint for `directive init`. Classifies, prints a state summary
 * + one next action, then either stops (`--dry-run`) or delegates to the narrow
 * verb for the resolved decision. The summary/disclosure use the `printf`
 * channel (stderr under `--json`) so that in JSON mode stdout stays a SINGLE
 * JSON object — the delegate's result, or the dry-run plan.
 */
export async function runInitDispatchCli(options: RunInitDispatchCliOptions): Promise<number> {
  const projectDir = resolve(options.projectDir);
  const seams = options.seams ?? {};
  const io: InitDepositIo = {
    printf: (text) => {
      if (options.jsonOut) options.writeErr(text);
      else options.writeOut(text);
    },
  };

  // #2926: root opt-out — do not scaffold/install/refresh when flag is present.
  const optOut = detectNoDeftDirective(projectDir);
  if (optOut.present) {
    io.printf(`\n[directive init] ${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE}\n`);
    if (optOut.inconsistent) {
      io.printf(`[directive init] ${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}\n`);
    }
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify(
          {
            success: false,
            action: "init",
            disabled: true,
            disabled_via: NO_DEFT_DIRECTIVE_FLAG_NAME,
            inconsistent: optOut.inconsistent,
            ...(optOut.inconsistent
              ? { inconsistent_policy: NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY }
              : {}),
            deposit_present: optOut.depositPresent,
            project_dir: projectDir,
            message: optOut.inconsistent
              ? NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE
              : NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
          },
          null,
          2,
        )}\n`,
      );
    }
    // Clean opt-out is a successful short-circuit; inconsistent state fails closed.
    return optOut.inconsistent ? 1 : 0;
  }

  const classification = classifyInitDispatch(projectDir, seams.classifySeams ?? {});
  const { decision, plan: resolutionPlan } = classification;

  printInitDispatchSummary(io, decision, resolutionPlan);

  if (options.dryRun) {
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify(buildInitDispatchDryRunJson(projectDir, classification), null, 2)}\n`,
      );
    }
    return 0;
  }

  switch (decision) {
    case "scaffold":
    case "brownfield-install": {
      const runScaffold = seams.runScaffold ?? runInitDepositCli;
      return runScaffold({
        projectDir,
        jsonOut: options.jsonOut,
        nonInteractive: options.nonInteractive,
        writeOut: options.writeOut,
        writeErr: options.writeErr,
      });
    }
    case "delegate-update": {
      io.printf(`\n[directive init] ${UPDATE_DELEGATION_DISCLOSURE}\n`);
      const runRefresh = seams.runRefresh ?? runRefreshDepositCli;
      return runRefresh({
        projectDir,
        jsonOut: options.jsonOut,
        nonInteractive: options.nonInteractive,
        upgrade: false,
        writeOut: options.writeOut,
        writeErr: options.writeErr,
      });
    }
    case "route-migrate": {
      const runMigrate = seams.runMigrate ?? runMigrateCli;
      return runMigrate({
        projectDir,
        jsonOut: options.jsonOut,
        writeOut: options.writeOut,
        writeErr: options.writeErr,
      });
    }
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled init dispatch decision: ${String(exhaustive)}`);
    }
  }
}
