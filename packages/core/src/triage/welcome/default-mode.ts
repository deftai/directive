import { resolve } from "node:path";
import { maybeSelfHealCache } from "../../cache/fetch.js";
import { FIRST_TIME_NUDGE, INCOMPLETE_NUDGE_TEMPLATE } from "./constants.js";
import { classifyOnboarding, detectPriorState } from "./prior-state.js";
import { emitOneliner } from "./summary.js";

export interface WelcomeOutcome {
  phasesRun: number[];
  phasesSkipped: number[];
  subscriptionChoice: string | null;
  wipCapChoice: number | null;
  reliefOffered: boolean;
  reliefConfirmed: boolean;
  discussedAtPhase: number | null;
  exitCode: number;
  bootstrapAction: string | null;
}

export function normalizeTaskPrefix(taskPrefix?: string | null): string {
  const prefix = (taskPrefix ?? "").trim();
  if (prefix && !prefix.endsWith(":")) return `${prefix}:`;
  return prefix;
}

export function formatWelcomeCommand(args: string[], taskPrefix?: string | null): string {
  const prefix = normalizeTaskPrefix(taskPrefix);
  const canonical = `deft ${args.join(" ")}`;
  if (!prefix) return canonical;
  return `task ${prefix}${args[0] ?? ""}${args.length > 1 ? ` ${args.slice(1).join(" ")}` : ""}`;
}

export interface DefaultModeOptions {
  readonly output?: (line: string) => void;
  readonly writeHistory?: boolean;
  readonly taskPrefix?: string | null;
  readonly selfHealFn?: (projectRoot: string) => void;
}

/** Non-interactive default mode (#1309). */
export function runDefaultMode(
  projectRoot: string,
  options: DefaultModeOptions = {},
): WelcomeOutcome {
  const out = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const outcome: WelcomeOutcome = {
    phasesRun: [0],
    phasesSkipped: [],
    subscriptionChoice: null,
    wipCapChoice: null,
    reliefOffered: false,
    reliefConfirmed: false,
    discussedAtPhase: null,
    exitCode: 0,
    bootstrapAction: null,
  };

  const heal =
    options.selfHealFn ??
    ((root: string) => {
      maybeSelfHealCache(resolve(root));
    });
  heal(projectRoot);

  emitOneliner(projectRoot, {
    writeHistory: options.writeHistory !== false,
    output: out,
  });

  const state = detectPriorState(projectRoot);
  const [label, missing] = classifyOnboarding(state);
  const canonicalOnboard = "deft triage:welcome --onboard";
  const onboardCommand = formatWelcomeCommand(["triage:welcome", "--onboard"], options.taskPrefix);

  if (label === "first-time") {
    out(FIRST_TIME_NUDGE.replace(canonicalOnboard, onboardCommand));
  } else if (label === "incomplete") {
    out(
      INCOMPLETE_NUDGE_TEMPLATE.replace("{missing}", missing.join(" + ")).replace(
        canonicalOnboard,
        onboardCommand,
      ),
    );
  }

  return outcome;
}
