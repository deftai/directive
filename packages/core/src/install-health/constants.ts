/**
 * Shared constants for the in-sync / install-health module (R2, AC9.7).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * What an entry point found when Directive can't run normally (#6620, AC9.7,
 * AC9.12). Every entry point checks in this order and stops at the first match:
 *
 * 1. `disabled` — untracked root `.deft-directive-disable` (regular file that
 *    `git ls-files` does not list). Stop quietly: allow / exit 0.
 * 2. `root-mismatch` / `foreign-runtime-link` — hook paths only: the payload
 *    root is not this checkout.
 * 3. `legacy-layout` — launcher entry points only, and only when the root
 *    `package.json` has no `@deftai/directive-runtime` dependency (AC9.12,
 *    §A6.7). The committed hook file never makes this check.
 * 4. `no-runtime-pin` / `pin-invalid` — launcher only.
 * 5. `runtime-missing` — `node_modules/@deftai/directive-runtime` is absent.
 * 6. `pin-mismatch` (the hook lets the named install through, AC2.6) / `overlay`.
 * 7. `contract-too-new` — launcher only.
 * 8. `wiring-damaged` — hooks complete wiring themselves (AC8.6); only doctor
 *    and the launcher name repair.
 * 9. `data-behind` — a notice only (AC8.9).
 *
 * `hook-failed` is the committed hook file's message when the runtime ran but
 * gave no decision; `launcher-missing` is for committed text. The launcher
 * keeps a copy of this table in `packages/cli/src/entry-guard.ts` (it may not
 * import core, AC3.1); `entry-guard-parity.test.ts` keeps the two equal.
 */
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

/**
 * One message per situation. Placeholders: `{install}` (see
 * {@link projectInstallCommand}), `{pin}`, `{installed}`, `{spec}`, `{like}`.
 */
export const ENTRY_GUARD_MESSAGES: Readonly<Record<EntrySituation, string>> = {
  disabled: "",
  "root-mismatch":
    "Prep the linked worktree (`deft swarm-worktrees prep --path <dest>`), then open that worktree as the host project root so launchRoot matches payloadRoot. Primary `npm i -g @deftai/directive` does not rebind a primary-rooted session. From this session only these exact commands run: `directive --version`, `deft --version`, `directive doctor`, and `directive policy:disable-host-hooks --host <this host> --confirm` (or its `deft` form). To clear live Directive host hooks, run `directive install --repair` or that disable verb (when it strips) in the launch checkout — a new session alone is not enough.",
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

/**
 * Added after the `runtime-missing` and `pin-mismatch` rows where the agent's
 * own shell is blocked and nothing is let through (D-013).
 */
export const ENTRY_GUARD_PERSON_RUNS_INSTALL =
  "Agent tool calls stay blocked until a person runs it.";

/**
 * The project install to name, from the lockfile at `projectRoot` (AC9.12).
 * Every command it names is one the hook lets through on a pin mismatch
 * (`recovery-admit.ts`). Yarn is not supported, so it is never named.
 */
export function projectInstallCommand(projectRoot: string): string {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "`pnpm install --frozen-lockfile`";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "`npm install`";
  return "`npm install` (or `pnpm install --frozen-lockfile`)";
}

/** Values for the placeholders in {@link ENTRY_GUARD_MESSAGES}. */
export interface EntryGuardMessageValues {
  readonly install?: string;
  readonly pin?: string;
  readonly installed?: string;
  readonly spec?: string;
  /** `, like \`"@deftai/directive-runtime": "<version>"\`` or empty (pin-invalid, D-042). */
  readonly like?: string;
}

/** The row for `situation` with its placeholders filled in. */
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

/** Exact pin package name under the target architecture (UNIFIED Part A). */
export const RUNTIME_PIN_PACKAGE = "@deftai/directive-runtime";

/**
 * Path prefix every managed wiring target must use (version-free).
 * Absolute under the project root once the runtime is installed.
 */
export const RUNTIME_PACKAGE_PATH_PREFIX = "node_modules/@deftai/directive-runtime/";

/**
 * Standard installation/wiring recovery guidance (AC9.7).
 * Global launcher install, then repair — for deposits/wiring after the pin
 * packages already match. Not the pin≠installed project-skew message (#6013).
 */
export const INSTALLATION_RECOVERY_GUIDANCE =
  "npm i -g @deftai/directive, then directive install --repair";

/**
 * Pin≠installed recovery when only project node_modules lags the pin (#6013 / #5893).
 * The `pin-mismatch` row's next step for callers with no project root to read
 * a lockfile from (the cheap check's `recoveryGuidance`). Names only installs
 * the hook lets through (#6313, `recovery-admit.ts`).
 */
export const PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE =
  "Run `npm install` (or `pnpm install --frozen-lockfile`) in a terminal in this project.";

/**
 * Recovery when payload project root does not match launching checkout
 * (SEC-WT / #6100 / #7349 Prefer-A Bound P2): the `root-mismatch` row.
 */
export const HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE = ENTRY_GUARD_MESSAGES["root-mismatch"];

/**
 * Recovery when the runtime that launched the hook is linked in from another
 * checkout (#6185): the `foreign-runtime-link` row.
 */
export const FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE = ENTRY_GUARD_MESSAGES["foreign-runtime-link"];

/** Relative path of the committed setup record. */
export const GENERATION_REL = ".deft/GENERATION.json";

/** Directory holding per-checkout readiness markers. */
export const READINESS_DIR_REL = ".deft/directive";

/** Filename pattern for readiness: wiring-ready.<runtime-version>.json (AC8.6). */
export function readinessFileName(runtimeVersion: string): string {
  return `wiring-ready.${runtimeVersion}.json`;
}

/**
 * Doctor and every diagnostic hook/helper set this env so self-completing
 * setup and readiness/Git writes are suppressed (AC8.6 / AC9.10).
 * Non-empty values other than "0"/"false"/"no" suppress writes.
 */
export const DEFT_DOCTOR_HOOK_DIAGNOSTIC = "DEFT_DOCTOR_HOOK_DIAGNOSTIC";
