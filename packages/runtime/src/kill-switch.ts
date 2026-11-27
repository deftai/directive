#!/usr/bin/env node
/**
 * CLI for `kill-switch:on` / `kill-switch:off` (#6740).
 *
 * `kill-switch:on` turns Directive enforcement off for this checkout. It refuses
 * under an active UAT lease, runs the kept terminal mint
 * (`refuseNonInteractiveMint`: no agent or CI markers, interactive TTY,
 * controlling terminal, `--confirm` and the typed phrase), then atomically
 * publishes the plain-line kill record `.deft/authz/kill-switch.disable` in the
 * payload root's store, bound to `git rev-parse --absolute-git-dir`.
 *
 * `kill-switch:off --confirm` removes only that file, with no mint: turning
 * enforcement back on tightens (#5980).
 *
 * The off switch is as strong as the grant store and the kept mint, no
 * stronger. It is hardening, not human-only authority.
 */
import { resolve } from "node:path";
import { endDelegation } from "@deftai/directive-core/authz";
import { resolveAbsoluteGitDir } from "@deftai/directive-core/dist/policy/deft-directive-disable.js";
import {
  type AbsoluteGitDirResolver,
  KILL_SWITCH_OFF_VERB,
  KILL_SWITCH_ON_VERB,
  KILL_SWITCH_RECORD_REL,
  removeKillSwitchRecord,
  writeKillSwitchRecord,
} from "@deftai/directive-core/dist/policy/kill-switch-record.js";
import { worktreePathOrNull } from "@deftai/directive-core/dist/session/git.js";
import { isDirectEntrypoint } from "./entrypoint.js";
import {
  type HumanPresenceMintSeams,
  mintArgsAfterVerb,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

export interface KillSwitchSeams extends HumanPresenceMintSeams {
  readonly absoluteGitDir?: AbsoluteGitDirResolver;
  /** Checkout root (`git rev-parse --show-toplevel`) for a folder, or null. */
  readonly checkoutRoot?: (dir: string) => string | null;
  readonly now?: () => Date;
  /** Delegation end on kill-switch:on (#7420). Injected in tests. */
  readonly endDelegation?: typeof endDelegation;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

interface ParsedArgs {
  readonly action: "on" | "off" | null;
  readonly confirm: boolean;
  readonly projectRoot: string;
  readonly help: boolean;
  readonly error?: string;
}

export function killSwitchUsage(): string {
  return (
    `usage: deft ${KILL_SWITCH_ON_VERB} --confirm [--project-root <dir>]\n` +
    `       deft ${KILL_SWITCH_OFF_VERB} --confirm [--project-root <dir>]\n` +
    `  ${KILL_SWITCH_ON_VERB}: turn Directive enforcement off for this checkout. A person runs it at a terminal:\n` +
    "    it refuses agent or CI shells, non-interactive callers and an active UAT lease, and asks for\n" +
    `    the typed phrase. It writes ${KILL_SWITCH_RECORD_REL}, bound to this checkout's git dir.\n` +
    `  ${KILL_SWITCH_OFF_VERB}: remove that record (no mint). Then start a new agent session.\n` +
    "  A bare root flag file turns nothing off. The off switch is as strong as the grant store and\n" +
    "  the terminal mint, no stronger: store-guard holes (#6292, #6981, #7034, #7036) let a process\n" +
    "  write a record. It is hardening, not human-only authority (#6740)."
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let action: "on" | "off" | null = null;
  let confirm = false;
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { action, confirm, projectRoot, help: true };
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          action,
          confirm,
          projectRoot,
          help: false,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if ((arg === "on" || arg === "off") && action === null) {
      action = arg;
    } else {
      return {
        action,
        confirm,
        projectRoot,
        help: false,
        error: `unrecognized argument: ${arg}`,
      };
    }
  }
  if (action === null) {
    return { action, confirm, projectRoot, help: false, error: "missing action: on or off" };
  }
  return { action, confirm, projectRoot, help: false };
}

/**
 * The record lives at the checkout root, where every reader looks, so a run
 * from a subfolder resolves to that root (a linked worktree keeps its own).
 */
function recordRoot(projectRoot: string, seams: KillSwitchSeams): string {
  const dir = resolve(projectRoot);
  return (seams.checkoutRoot ?? ((d: string) => worktreePathOrNull(d)))(dir) ?? dir;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runOn(
  argv: readonly string[],
  args: ParsedArgs,
  seams: KillSwitchSeams,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): number {
  const projectRoot = recordRoot(args.projectRoot, seams);
  const uatBlocked = refuseMintWhileUatActive(KILL_SWITCH_ON_VERB, projectRoot);
  if (uatBlocked !== null) return uatBlocked;
  const resolved = resolveHumanPresenceMintSeams(seams);
  const mintBlocked = refuseNonInteractiveMint({
    verb: KILL_SWITCH_ON_VERB,
    confirm: args.confirm,
    isTty: resolved.isTty,
    environ: resolved.environ,
    hasControllingTerminal: resolved.hasControllingTerminal,
    readInteractiveConfirm: resolved.readInteractiveConfirm,
    operatorStop: {
      projectRoot,
      args: mintArgsAfterVerb(argv, "on"),
      record: resolved.recordOperatorStop,
    },
  });
  if (mintBlocked !== null) return mintBlocked;
  const gitDir = (seams.absoluteGitDir ?? resolveAbsoluteGitDir)(projectRoot);
  if (gitDir === null) {
    writeErr(
      `${KILL_SWITCH_ON_VERB}: \`git rev-parse --absolute-git-dir\` gave no answer for ${projectRoot}; ` +
        "the record binds to that git dir, so nothing was written.\n",
    );
    return 2;
  }
  const result = writeKillSwitchRecord(projectRoot, {
    gitDir,
    mintedAt: isoSeconds((seams.now ?? (() => new Date()))()),
    mintedVia: KILL_SWITCH_ON_VERB,
  });
  if (!result.ok) {
    writeErr(`${KILL_SWITCH_ON_VERB}: could not write ${result.path}: ${result.error}\n`);
    return 1;
  }
  // #7420: a live delegation ends at once; the record alone already stops it admitting.
  try {
    (seams.endDelegation ?? endDelegation)(projectRoot, "kill-switch");
  } catch {
    /* best effort: the kill record already blocks every delegated consumer */
  }
  writeOut(
    `Wrote ${result.path} (bound to ${gitDir}).\n` +
      "Directive enforcement is off for this checkout on current readers. Start a new agent session.\n" +
      `Turn it back on with \`deft ${KILL_SWITCH_OFF_VERB} --confirm\`, then start a new agent session.\n`,
  );
  return 0;
}

function runOff(
  args: ParsedArgs,
  seams: KillSwitchSeams,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): number {
  if (!args.confirm) {
    writeErr(
      `${KILL_SWITCH_OFF_VERB}: pass --confirm to remove the kill record.\n${killSwitchUsage()}\n`,
    );
    return 2;
  }
  const projectRoot = recordRoot(args.projectRoot, seams);
  const result = removeKillSwitchRecord(projectRoot);
  if (!result.ok) {
    writeErr(`${KILL_SWITCH_OFF_VERB}: could not remove ${result.path}: ${result.error}\n`);
    return 1;
  }
  if (!result.changed) {
    writeOut(`No kill record at ${result.path}; nothing to remove.\n`);
    return 0;
  }
  writeOut(
    `Removed ${result.path}. Directive enforcement is back on for this checkout.\n` +
      "Start a NEW agent session to reload AGENTS, host skills and hooks.\n",
  );
  return 0;
}

export function run(argv: string[], seams: KillSwitchSeams = {}): number {
  const writeOut = seams.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = seams.writeErr ?? ((text: string) => process.stderr.write(text));
  const args = parseArgs(argv);
  if (args.help) {
    writeOut(`${killSwitchUsage()}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    writeErr(`kill-switch: ${args.error}\n${killSwitchUsage()}\n`);
    return 2;
  }
  return args.action === "on"
    ? runOn(argv, args, seams, writeOut, writeErr)
    : runOff(args, seams, writeOut, writeErr);
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
