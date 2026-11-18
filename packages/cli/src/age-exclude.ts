/**
 * Read-only release-step gate for the runtime minimumReleaseAgeExclude row in
 * pnpm-workspace.yaml (#6164 / #6181), used by this repo's release:local-update.
 *
 * pnpm-workspace.yaml is owned by pnpm and the project (ledger Problem 13 /
 * #5797). Directive's install, upgrade and repair never write it (#5854,
 * Outcome B): the #5860 replace-not-append heal was removed. Nothing in this
 * module writes files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_AGE_EXCLUDE_PACKAGE = "@deftai/directive-runtime";
export const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

const KEY_RE = /^(\s*)minimumReleaseAgeExclude:\s*(#.*)?$/;
const ITEM_RE = /^(\s*)-\s+(.*)$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function itemValue(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("'") || v.startsWith('"')) {
    const q = v[0] as string;
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v;
  }
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/**
 * Pre-install AgeExclude gate for release:local-update (#6164).
 * Exact list-item equality under minimumReleaseAgeExclude only; no mutate.
 */
export type PreInstallAgeExcludeGate =
  | { readonly ok: true; readonly reason: "key-absent" | "exact-row-present" }
  | {
      readonly ok: false;
      readonly reason: "missing-exact-row" | "read-error";
      readonly message: string;
    };

/** Pure text gate: key absent → continue; key present → exact runtime@version item. */
export function evaluatePreInstallAgeExcludeText(
  text: string,
  targetVersion: string,
): PreInstallAgeExcludeGate {
  const want = `${RUNTIME_AGE_EXCLUDE_PACKAGE}@${targetVersion}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const keyIdx = lines.findIndex((l) => KEY_RE.test(l));
  if (keyIdx < 0) return { ok: true, reason: "key-absent" };
  const keyIndent = indentOf(lines[keyIdx] as string);
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = ITEM_RE.exec(line);
    if (m === null || indentOf(line) < keyIndent) break;
    if (itemValue(m[2] as string) === want) {
      return { ok: true, reason: "exact-row-present" };
    }
  }
  return {
    ok: false,
    reason: "missing-exact-row",
    message: `AgeExclude missing ${want} before frozen install (#5953 footnote / #6164)`,
  };
}

/** File gate: absent/unreadable workspace yaml fails closed before install. */
export function evaluatePreInstallAgeExcludeFile(
  projectRoot: string,
  targetVersion: string,
): PreInstallAgeExcludeGate {
  const abs = join(projectRoot, PNPM_WORKSPACE_FILE);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "read-error",
      message: `AgeExclude cannot read ${PNPM_WORKSPACE_FILE} before frozen install (#6164): ${detail}`,
    };
  }
  return evaluatePreInstallAgeExcludeText(text, targetVersion);
}

/**
 * Extracted release:local-update pre-install control flow (#6164 proof).
 * Gate failure must not reach install (mocked side effects in tests).
 */
export function runReleaseLocalUpdatePreInstallGate(args: {
  readonly projectRoot: string;
  readonly version: string;
  readonly install: () => void;
}): PreInstallAgeExcludeGate {
  const gate = evaluatePreInstallAgeExcludeFile(args.projectRoot, args.version);
  if (!gate.ok) return gate;
  args.install();
  return gate;
}
