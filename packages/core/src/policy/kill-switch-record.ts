/**
 * Kill record: the temporary off switch for Directive enforcement (#6740).
 *
 * A bare root disable flag file turns nothing off. Directive stands down only
 * when this record is present and valid:
 *
 * - path: `<payload root>/.deft/authz/kill-switch.disable` (the checkout's own
 *   grant store; a linked worktree uses its own root, never the main clone's);
 * - a regular file, not a link;
 * - it contains the exact whole line `schema=deft.kill-switch.v1`;
 * - it contains the exact whole line `gitDir=` followed by what
 *   `git rev-parse --absolute-git-dir` prints at check time.
 *
 * Other lines (`mintedAt=`, `mintedVia=`) are display only. Whole-line exact
 * matching needs no escaping, so the Node readers and the shell reader
 * (`tr -d '\r' | grep -qxF`) agree. Every CR is removed before matching, so a
 * CRLF record matches on every platform (Git for Windows grep strips CR on its
 * own; GNU grep elsewhere does not). Git output loses its trailing newlines
 * only, as `$(...)` does in sh.
 *
 * `kill-switch:on` writes the record after the kept terminal mint;
 * `kill-switch:off --confirm` removes it with no mint (#5980).
 *
 * Honest limits: the record is as strong as the grant store and the kept mint,
 * no stronger. Store-guard holes (#6292, #6981, #7034, #7036, paths built at
 * run time, programmatic writes) let a process write a record. The gitDir
 * binding isolates checkouts against copies; it does not prove freshness or
 * who wrote it. Restoring saved record bytes after off, and one checkout used
 * from both Git for Windows and WSL git, are named limits.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Record schema line (exact whole line). */
export const KILL_SWITCH_RECORD_SCHEMA = "deft.kill-switch.v1";
export const KILL_SWITCH_RECORD_SCHEMA_LINE = `schema=${KILL_SWITCH_RECORD_SCHEMA}`;
/** Prefix of the binding line; the rest is the absolute git dir. */
export const KILL_SWITCH_RECORD_GIT_DIR_PREFIX = "gitDir=";

/** Record path relative to the payload root. */
export const KILL_SWITCH_RECORD_REL = ".deft/authz/kill-switch.disable";

/** Verbs that write and remove the record. */
export const KILL_SWITCH_ON_VERB = "kill-switch:on";
export const KILL_SWITCH_OFF_VERB = "kill-switch:off";

/** Root flag file name that no longer turns anything off (#3039 → #6740). */
export const KILL_SWITCH_BARE_FLAG_NAME = ".deft-directive-disable";

/** Reader flag the outer hook passes to the runtime hook binary (#6740). */
export const KILL_SWITCH_READER_FLAG = "--kill-switch-reader";
export const KILL_SWITCH_READER_VERSION = "v1";

/** Marker line the git-hook helper carries (#6740). */
export const KILL_SWITCH_GITHOOK_MARKER = "# directive-kill-switch-reader: v1";

export type KillSwitchRecordInvalidReason =
  | "not-a-regular-file"
  | "unreadable"
  | "missing-schema-line"
  | "git-dir-unresolved"
  | "git-dir-mismatch";

export type KillSwitchRecordVerdict =
  | { readonly kind: "absent" }
  | {
      readonly kind: "invalid";
      readonly reason: KillSwitchRecordInvalidReason;
    }
  | {
      readonly kind: "valid";
      readonly mintedAt: string | null;
      readonly mintedVia: string | null;
    };

/** Absolute git dir for the checkout, or null when git cannot answer. */
export type AbsoluteGitDirResolver = (projectRoot: string) => string | null;

/** Absolute path of the record for a payload root. */
export function killSwitchRecordPath(projectRoot: string): string {
  return resolve(projectRoot, KILL_SWITCH_RECORD_REL);
}

/** Strip trailing newlines only, as sh `$(...)` does. */
export function trimGitOutput(text: string): string {
  return text.replace(/\n+$/, "");
}

function displayValue(lines: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/**
 * Pure verdict for record text against the checkout's git dir. Every CR is
 * removed, then lines split on LF; every comparison is an exact whole line.
 * The shell reader does the same (`tr -d '\r' | grep -qxF`), because Git for
 * Windows grep strips CR on its own and GNU grep elsewhere does not.
 */
export function evaluateKillSwitchRecordText(
  text: string,
  gitDir: string | null,
): KillSwitchRecordVerdict {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!lines.includes(KILL_SWITCH_RECORD_SCHEMA_LINE)) {
    return { kind: "invalid", reason: "missing-schema-line" };
  }
  if (gitDir === null || gitDir.length === 0) {
    return { kind: "invalid", reason: "git-dir-unresolved" };
  }
  if (!lines.includes(`${KILL_SWITCH_RECORD_GIT_DIR_PREFIX}${gitDir}`)) {
    return { kind: "invalid", reason: "git-dir-mismatch" };
  }
  return {
    kind: "valid",
    mintedAt: displayValue(lines, "mintedAt"),
    mintedVia: displayValue(lines, "mintedVia"),
  };
}

/** Read and judge the record at the payload root. Never throws. */
export function readKillSwitchRecord(
  projectRoot: string,
  absoluteGitDir: AbsoluteGitDirResolver,
): KillSwitchRecordVerdict {
  const path = killSwitchRecordPath(projectRoot);
  let isRegular = false;
  try {
    const lst = lstatSync(path);
    isRegular = !lst.isSymbolicLink() && lst.isFile();
  } catch {
    return { kind: "absent" };
  }
  if (!isRegular) return { kind: "invalid", reason: "not-a-regular-file" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "invalid", reason: "unreadable" };
  }
  const gitDir = absoluteGitDir(projectRoot);
  return evaluateKillSwitchRecordText(text, gitDir);
}

export interface KillSwitchRecordFields {
  readonly gitDir: string;
  readonly mintedAt: string;
  readonly mintedVia: string;
}

/** Plain-line record body (LF endings). */
export function formatKillSwitchRecord(fields: KillSwitchRecordFields): string {
  return [
    KILL_SWITCH_RECORD_SCHEMA_LINE,
    `${KILL_SWITCH_RECORD_GIT_DIR_PREFIX}${fields.gitDir}`,
    `mintedAt=${fields.mintedAt}`,
    `mintedVia=${fields.mintedVia}`,
    "",
  ].join("\n");
}

/** Outcome of a record write or removal (I/O failure is returned, not thrown). */
export type KillSwitchRecordIoResult =
  | { readonly ok: true; readonly path: string; readonly changed: boolean }
  | { readonly ok: false; readonly path: string; readonly error: string };

/**
 * Atomically publish the record: write a temp file beside it, then rename it
 * over the record path.
 */
export function writeKillSwitchRecord(
  projectRoot: string,
  fields: KillSwitchRecordFields,
): KillSwitchRecordIoResult {
  const path = killSwitchRecordPath(projectRoot);
  const temp = join(
    dirname(path),
    `.kill-switch.disable.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, formatKillSwitchRecord(fields), { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
    return { ok: true, path, changed: true };
  } catch (err) {
    rmSync(temp, { force: true });
    return { ok: false, path, error: String(err) };
  }
}

/** Remove only the record file; `changed` is false when there was none. */
export function removeKillSwitchRecord(projectRoot: string): KillSwitchRecordIoResult {
  const path = killSwitchRecordPath(projectRoot);
  try {
    lstatSync(path);
  } catch {
    return { ok: true, path, changed: false };
  }
  try {
    unlinkSync(path);
    return { ok: true, path, changed: true };
  } catch (err) {
    return { ok: false, path, error: String(err) };
  }
}

/** True when a regular (non-link) bare flag file sits at the root. */
export function isBareKillSwitchFlagPresent(projectRoot: string): boolean {
  try {
    const lst = lstatSync(resolve(projectRoot, KILL_SWITCH_BARE_FLAG_NAME));
    return !lst.isSymbolicLink() && lst.isFile();
  } catch {
    return false;
  }
}

/** Warning for a bare flag with no valid record (names the file and the on verb). */
export const KILL_SWITCH_BARE_FLAG_WARNING =
  `Directive warning: root \`${KILL_SWITCH_BARE_FLAG_NAME}\` is present, but a bare flag file turns nothing off (#6740). ` +
  `Enforcement stays on. To turn Directive off for this checkout, a person runs \`deft ${KILL_SWITCH_ON_VERB} --confirm\` at a terminal.`;

/** Warning for a record that is present but not valid for this checkout. */
export function formatInvalidKillRecordWarning(
  reason: KillSwitchRecordInvalidReason,
  bareFlagPresent: boolean,
): string {
  const flag = bareFlagPresent
    ? ` The root \`${KILL_SWITCH_BARE_FLAG_NAME}\` flag also turns nothing off.`
    : "";
  return (
    `Directive warning: \`${KILL_SWITCH_RECORD_REL}\` is not a valid kill record for this checkout (${reason}). ` +
    `Enforcement stays on.${flag} A person runs \`deft ${KILL_SWITCH_ON_VERB} --confirm\` at a terminal to write a new one, ` +
    `or \`deft ${KILL_SWITCH_OFF_VERB} --confirm\` to remove it.`
  );
}

/**
 * The one warning a reader prints for this checkout, or null when there is
 * nothing to warn about (no flag and no record, or a valid record).
 */
export function killSwitchWarning(
  verdict: KillSwitchRecordVerdict,
  bareFlagPresent: boolean,
): string | null {
  if (verdict.kind === "valid") return null;
  if (verdict.kind === "invalid") {
    return formatInvalidKillRecordWarning(verdict.reason, bareFlagPresent);
  }
  return bareFlagPresent ? KILL_SWITCH_BARE_FLAG_WARNING : null;
}

/** Display line for an existing valid record (doctor / session:start). */
export function formatKillRecordProvenance(
  verdict: Extract<KillSwitchRecordVerdict, { kind: "valid" }>,
): string {
  return (
    `Kill record: \`${KILL_SWITCH_RECORD_REL}\` (mintedVia=${verdict.mintedVia ?? "unknown"}, ` +
    `mintedAt=${verdict.mintedAt ?? "unknown"}).`
  );
}
