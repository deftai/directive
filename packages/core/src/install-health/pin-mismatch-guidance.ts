/**
 * Pin-mismatch-only refusal text (#6375).
 *
 * When pin ≠ installed is the only fault, the hook refuses every command but
 * the exact project install at a proven run directory (#6313). A host that
 * does not report the run directory (Codex) cannot run that install itself,
 * so the refusal tells a person what to run in their own terminal: the
 * checked project root on a labelled line, the install of the package manager
 * whose lockfile is at that root (one the hook lets through), and when to retry.
 *
 * Advice only: nothing here changes what the hook admits. The package manager
 * comes from which lockfile exists at the root; the runtime version the
 * lockfile reader extracts is ignored, because it does not prove that a
 * frozen install will work.
 */

import { type FsSeams, readLockfileRuntimeVersion } from "./readers.js";

/** Label of the refusal line that holds the checked project root. */
export const PIN_MISMATCH_ROOT_LABEL = "Project root:";

/** Where to run the install. */
export const PIN_MISMATCH_TERMINAL_LINE =
  "Open a terminal outside this blocked agent session, at that directory.";

/** Shown when no supported lockfile is at the root; names no command. */
export const PIN_MISMATCH_NO_LOCKFILE_LINE =
  "No lockfile (pnpm-lock.yaml or package-lock.json) was found at that directory. Run the project's own install from the directory that holds its lockfile.";

/** After the install. */
export const PIN_MISMATCH_RETRY_LINE =
  "After the install, retry the command once the installed runtime matches the pin. This pin-mismatch check needs no session restart; normal checks still apply.";

/**
 * Escape C0 and C1 control characters (and DEL) as `\uXXXX` so a root path
 * stays one line of data. Other characters, spaces included, are kept as is.
 */
export function escapeControlCharacters(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/**
 * The install command line by lockfile kind. It names only installs the hook
 * lets through (#6313, O-30): plain `pnpm install` is refused, so pnpm gets
 * the frozen form.
 */
function commandLines(kind: "npm" | "pnpm" | "absent"): string[] {
  if (kind === "pnpm") {
    return ["Run: `pnpm install --frozen-lockfile`"];
  }
  if (kind === "npm") {
    return [
      "Run: `npm install`",
      "You can try `npm ci` instead when the lockfile already records the pin.",
    ];
  }
  return [PIN_MISMATCH_NO_LOCKFILE_LINE];
}

/**
 * Recovery text for a pin-mismatch-only refusal, one instruction per line.
 * `projectRoot` is the root the hook resolved and passed to the install check;
 * the lockfile is looked for at that root only.
 */
export function renderPinMismatchRecoveryGuidance(
  projectRoot: string,
  seams: FsSeams = {},
): string {
  const { kind } = readLockfileRuntimeVersion(projectRoot, seams);
  return [
    `${PIN_MISMATCH_ROOT_LABEL} ${escapeControlCharacters(projectRoot)}`,
    PIN_MISMATCH_TERMINAL_LINE,
    ...commandLines(kind),
    PIN_MISMATCH_RETRY_LINE,
  ].join("\n");
}
