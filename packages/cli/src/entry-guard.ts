/**
 * The launcher's copy of the shared entry-guard message table (#6620).
 *
 * Source: `packages/core/src/install-health/constants.ts` (order, rows and
 * `projectInstallCommand`). The launcher may not import core (AC3.1), so the
 * table is copied here; `entry-guard-parity.test.ts` fails on any drift.
 * Node built-ins only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInstallState } from "./pin.js";

export type EntrySituation =
  | "disabled"
  | "root-mismatch"
  | "foreign-runtime-link"
  | "legacy-layout"
  | "no-runtime-pin"
  | "pin-invalid"
  | "runtime-missing"
  | "pin-mismatch"
  | "overlay"
  | "contract-too-new"
  | "wiring-damaged"
  | "data-behind"
  | "launcher-missing"
  | "hook-failed";

export const ENTRY_GUARD_MESSAGES: Readonly<Record<EntrySituation, string>> = {
  disabled: "",
  "root-mismatch":
    "Prep the linked worktree (`deft swarm-worktrees prep --path <dest>`), then open that worktree as the host project root so launchRoot matches payloadRoot. Primary `npm i -g @deftai/directive` does not rebind a primary-rooted session. From this session only these exact commands run: `directive --version`, `deft --version`, `directive doctor`, and `directive policy:disable-host-hooks --host <this host> --confirm` (or its `deft` form). To clear live Directive host hooks, run that confirmed disable in the launch checkout (it strips registration). `directive install --repair` strips opted-out hosts only; with hostHooks still on, repair rewrites hooks. A new session alone is not enough.",
  "foreign-runtime-link":
    "Open a terminal outside this locked agent session. Remove the link at `<payloadRoot>/node_modules` or `<payloadRoot>/node_modules/@deftai/directive-runtime`, then install the runtime in `<payloadRoot>` (`pnpm install --frozen-lockfile` or `npm install`). This clears the foreign-runtime root mismatch; existing install and policy gates still apply.",
  "legacy-layout":
    "This project uses an older version of Directive that isn't installed. Run `npm install` (or `pnpm install`) to keep using it, or run `directive upgrade` to update.",
  "no-runtime-pin": "No Directive project here. Run `directive install`.",
  "pin-invalid":
    "package.json must name one exact Directive version{like}. It currently says `{spec}`. Change it to an exact version, then run {install}.",
  "runtime-missing":
    "Directive can't run: @deftai/directive-runtime is not installed in this project. Run {install} in a terminal in this project.",
  "pin-mismatch":
    "Directive can't run: the installed @deftai/directive-runtime {installed} is not the pinned {pin}. Run {install} in a terminal in this project.",
  overlay:
    "Overlay present at .deft-scratch/materialize-runtime-overlay.json. Outside the blocked hook, run `pnpm install --frozen-lockfile` (or equivalent exact restore) to restore the published pin, then retire that overlay before identity may pass.",
  "contract-too-new":
    "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.",
  "wiring-damaged": "Directive's wiring is damaged. Run `directive install --repair`.",
  "data-behind": "Project data schema is behind the runtime; run `directive upgrade`.",
  "launcher-missing": "Install the Directive launcher: `npm i -g @deftai/directive`.",
  "hook-failed":
    "Directive hooks: the hook could not reach a decision. Run directive doctor in this project to see the fix.",
};

export const ENTRY_GUARD_PERSON_RUNS_INSTALL =
  "Agent tool calls stay blocked until a person runs it.";

export function projectInstallCommand(projectRoot: string): string {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "`pnpm install --frozen-lockfile`";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "`npm install`";
  return "`npm install` (or `pnpm install --frozen-lockfile`)";
}

export interface EntryGuardMessageValues {
  readonly install?: string;
  readonly pin?: string;
  readonly installed?: string;
  readonly spec?: string;
  /** `, like \`"@deftai/directive-runtime": "<version>"\`` or empty (pin-invalid, D-042). */
  readonly like?: string;
}

export function formatEntryGuardMessage(
  situation: EntrySituation,
  values: EntryGuardMessageValues = {},
): string {
  // Function replacers: values are inserted literally (no `$&`-style patterns).
  const install = values.install ?? "`npm install` (or `pnpm install --frozen-lockfile`)";
  const pin = values.pin ?? "?";
  const installed = values.installed ?? "?";
  const spec = values.spec ?? "";
  const like = values.like ?? "";
  return ENTRY_GUARD_MESSAGES[situation]
    .replaceAll("{install}", () => install)
    .replaceAll("{pin}", () => pin)
    .replaceAll("{installed}", () => installed)
    .replaceAll("{spec}", () => spec)
    .replaceAll("{like}", () => like);
}

/**
 * Values for the `pin-invalid` row (D-042): the declared spec, an example
 * exact pin built from the version the spec names (`^0.129.0` → `0.129.0`;
 * left out when none can be read), and the install from the lockfile (with no
 * lockfile: \`npm install\` (or \`pnpm install\`)).
 */
export function pinInvalidValues(projectRoot: string, spec: string): EntryGuardMessageValues {
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(spec)?.[0];
  const like = version === undefined ? "" : `, like \`"@deftai/directive-runtime": "${version}"\``;
  const install =
    existsSync(join(projectRoot, "pnpm-lock.yaml")) ||
    existsSync(join(projectRoot, "package-lock.json"))
      ? projectInstallCommand(projectRoot)
      : "`npm install` (or `pnpm install`)";
  return { spec, like, install };
}

/** What stops a command that would start the pinned runtime, and its message. */
export interface LauncherSituation {
  readonly situation: EntrySituation;
  readonly message: string;
}

/**
 * Launcher-only part of the shared order, after the disable flag and the old
 * layout (AC9.12, AC3.12, §A5.6): no runtime pin → invalid pin → runtime
 * missing → pin mismatch → contract too new. Null when the pinned runtime can
 * start. One row per situation; the pin is shown only when there is one.
 */
export function classifyLauncherSituation(
  projectRoot: string,
  state: ProjectInstallState,
): LauncherSituation | null {
  const pick = (situation: EntrySituation, values: EntryGuardMessageValues = {}) => ({
    situation,
    message: formatEntryGuardMessage(situation, values),
  });
  if (state.oldStyle) return pick("legacy-layout");
  if (state.pin.kind === "none") return pick("no-runtime-pin");
  if (state.pin.kind !== "exact" || state.pin.version === null) {
    return pick("pin-invalid", pinInvalidValues(projectRoot, state.pin.raw ?? ""));
  }
  const install = projectInstallCommand(projectRoot);
  if (state.installed === null) return pick("runtime-missing", { install });
  if (!state.pinMatchesInstalled) {
    return pick("pin-mismatch", {
      install,
      pin: state.pin.version,
      installed: state.installed.version,
    });
  }
  if (!state.contractSupported) return pick("contract-too-new");
  return null;
}

/**
 * Step 1 of the shared entry order for launcher entry points (AC9.12, #6620 /
 * #6740): a valid kill record stops Directive quietly. A bare root
 * `.deft-directive-disable` file turns nothing off.
 *
 * Same contract as every other reader (core `policy/kill-switch-record.ts`):
 * `.deft/authz/kill-switch.disable` is a regular file (not a link) with the
 * exact whole lines `schema=deft.kill-switch.v1` and `gitDir=` plus
 * `git rev-parse --absolute-git-dir` (trailing newlines removed). Lines split
 * on LF after every CR is removed. Reads only.
 */

export const DISABLE_FLAG_NAME = ".deft-directive-disable";

/** Kill record path and lines (core `kill-switch-record.ts`, kept equal by the parity test). */
export const KILL_RECORD_REL = ".deft/authz/kill-switch.disable";
export const KILL_RECORD_SCHEMA_LINE = "schema=deft.kill-switch.v1";
export const KILL_RECORD_GIT_DIR_PREFIX = "gitDir=";

/**
 * Kill record verbs (#6740) pass the step-1 stop, so `deft kill-switch:off`
 * (or the namespace form `deft kill-switch off`) can remove a valid record.
 */
export const KILL_SWITCH_LAUNCHER_COMMANDS: ReadonlySet<string> = new Set([
  "kill-switch:on",
  "kill-switch:off",
  "kill-switch",
]);

/** One-line notice for passthrough commands (core `DEFT_DIRECTIVE_DISABLE_ONE_LINE`). */
export const DISABLE_ONE_LINE =
  "Directive disabled via kill record `.deft/authz/kill-switch.disable` (test/local kill-switch; deposit OK)";

function isRegularFile(path: string): boolean {
  try {
    const lst = lstatSync(path);
    return !lst.isSymbolicLink() && lst.isFile();
  } catch {
    return false;
  }
}

/** True when the kill record at `projectRoot` is valid for this checkout (#6740). */
export function isDisableFlagActive(projectRoot: string): boolean {
  const recordPath = join(projectRoot, KILL_RECORD_REL);
  if (!isRegularFile(recordPath)) return false;
  let text: string;
  try {
    text = readFileSync(recordPath, "utf8");
  } catch {
    return false;
  }
  const lines = text.replace(/\r/g, "").split("\n");
  if (!lines.includes(KILL_RECORD_SCHEMA_LINE)) return false;
  const gitDir = spawnSync("git", ["-C", projectRoot, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (gitDir.error || gitDir.status !== 0 || typeof gitDir.stdout !== "string") return false;
  const dir = gitDir.stdout.replace(/\n+$/, "");
  return dir.length > 0 && lines.includes(`${KILL_RECORD_GIT_DIR_PREFIX}${dir}`);
}
