/**
 * The launcher's copy of the shared entry-guard message table (#6620).
 *
 * Source: `packages/core/src/install-health/constants.ts` (order, rows and
 * `projectInstallCommand`). The launcher may not import core (AC3.1), so the
 * table is copied here; `entry-guard-parity.test.ts` fails on any drift.
 * Node built-ins only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
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
    "Prep the linked worktree (`deft swarm-worktrees prep --path <dest>`), then open that worktree as the host project root so launchRoot matches payloadRoot. Primary `npm i -g @deftai/directive` / `directive install --repair` does not rebind a primary-rooted session. From this session only these exact commands run: `directive --version`, `deft --version`, `directive doctor`, and `directive policy:disable-host-hooks --host <this host> --confirm` (or its `deft` form); the disable takes effect in a new session.",
  "foreign-runtime-link":
    "Open a terminal outside this locked agent session. Remove the link at `<payloadRoot>/node_modules` or `<payloadRoot>/node_modules/@deftai/directive-runtime`, then install the runtime in `<payloadRoot>` (`pnpm install --frozen-lockfile` or `npm install`). This clears the foreign-runtime root mismatch; existing install and policy gates still apply.",
  "legacy-layout":
    "This project uses an older version of Directive that isn't installed. Run `npm install` (or `pnpm install`) to keep using it, or run `directive upgrade` to update.",
  "no-runtime-pin": "No Directive project here. Run `directive install`.",
  "pin-invalid":
    "package.json must pin @deftai/directive-runtime to one exact version (found `{spec}`). Fix package.json; Directive doesn't guess a version.",
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
  return ENTRY_GUARD_MESSAGES[situation]
    .replaceAll("{install}", () => install)
    .replaceAll("{pin}", () => pin)
    .replaceAll("{installed}", () => installed)
    .replaceAll("{spec}", () => spec);
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
    return pick("pin-invalid", { spec: state.pin.raw ?? "" });
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
 * Step 1 of the shared entry order for launcher entry points (AC9.12, #6620):
 * an untracked root `.deft-directive-disable` stops Directive quietly.
 *
 * Same eligibility as the committed hook file: a regular file (not a link)
 * that `git ls-files` successfully reports as untracked. Tracked, wrong kind
 * or an indeterminate Git answer never select the stop. Reads only.
 */

export const DISABLE_FLAG_NAME = ".deft-directive-disable";

/** One-line notice for passthrough commands (core `DEFT_DIRECTIVE_DISABLE_ONE_LINE`). */
export const DISABLE_ONE_LINE =
  "Directive disabled via `.deft-directive-disable` (test/local kill-switch; deposit OK)";

function isRegularFile(path: string): boolean {
  try {
    const lst = lstatSync(path);
    return !lst.isSymbolicLink() && lst.isFile();
  } catch {
    return false;
  }
}

/** True when the untracked disable flag is active at `projectRoot`. */
export function isDisableFlagActive(projectRoot: string): boolean {
  if (!isRegularFile(join(projectRoot, DISABLE_FLAG_NAME))) return false;
  const listing = spawnSync("git", ["-C", projectRoot, "ls-files", "--", DISABLE_FLAG_NAME], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (listing.error || listing.status !== 0 || typeof listing.stdout !== "string") return false;
  return listing.stdout.trim().length === 0;
}
