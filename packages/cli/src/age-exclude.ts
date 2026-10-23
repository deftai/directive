/**
 * Prior-entry gated replace-not-append of the runtime minimumReleaseAgeExclude
 * row in pnpm-workspace.yaml (#5854 Prefer-A Recut-1).
 *
 * Scope: only the block-list items directly under `minimumReleaseAgeExclude:`.
 * Gate: at least one exact `@deftai/directive-runtime@<version>` item already
 * exists there. When the gate is true, those runtime exact items collapse to
 * exactly one quoted `'@deftai/directive-runtime@<target>'` item at the position
 * of the first one. Other keys (allowBuilds, ...), unrelated exclude rows,
 * comments and line endings are untouched; no YAML round-trip and no
 * create-if-absent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager, PmAddResult } from "./pm.js";

export const RUNTIME_AGE_EXCLUDE_PACKAGE = "@deftai/directive-runtime";
export const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

const KEY_RE = /^(\s*)minimumReleaseAgeExclude:\s*(#.*)?$/;
const ITEM_RE = /^(\s*)-\s+(.*)$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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

function isRuntimeExact(value: string): boolean {
  const prefix = `${RUNTIME_AGE_EXCLUDE_PACKAGE}@`;
  return value.startsWith(prefix) && EXACT_VERSION_RE.test(value.slice(prefix.length));
}

export interface AgeExcludeUpsert {
  readonly changed: boolean;
  readonly text: string;
  /** Runtime exact items seen before the edit (gate evidence). */
  readonly priorRuntimeItems: readonly string[];
}

/** Pure text transform; returns the input unchanged when the gate is false. */
export function upsertRuntimeAgeExcludeText(text: string, targetVersion: string): AgeExcludeUpsert {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const keyIdx = lines.findIndex((l) => KEY_RE.test(l));
  if (keyIdx < 0) return { changed: false, text, priorRuntimeItems: [] };
  const keyIndent = indentOf(lines[keyIdx] as string);
  const runtimeIdx: number[] = [];
  const prior: string[] = [];
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = ITEM_RE.exec(line);
    if (m === null || indentOf(line) < keyIndent) break;
    const value = itemValue(m[2] as string);
    if (isRuntimeExact(value)) {
      runtimeIdx.push(i);
      prior.push(value);
    }
  }
  if (runtimeIdx.length === 0) return { changed: false, text, priorRuntimeItems: [] };
  const first = runtimeIdx[0] as number;
  const itemIndent = (ITEM_RE.exec(lines[first] as string)?.[1] ?? "") as string;
  const replacement = `${itemIndent}- '${RUNTIME_AGE_EXCLUDE_PACKAGE}@${targetVersion}'`;
  const drop = new Set(runtimeIdx.slice(1));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    out.push(i === first ? replacement : (lines[i] as string));
  }
  const next = out.join(eol);
  return { changed: next !== text, text: next, priorRuntimeItems: prior };
}

/** Would {@link healRuntimeAgeExclude} edit the workspace file? (plan/dry-run disclosure) */
export function previewRuntimeAgeExcludeHeal(
  projectRoot: string,
  targetVersion: string,
): AgeExcludeUpsert | null {
  const abs = join(projectRoot, PNPM_WORKSPACE_FILE);
  if (!existsSync(abs)) return null;
  const r = upsertRuntimeAgeExcludeText(readFileSync(abs, "utf8"), targetVersion);
  return r.changed ? r : null;
}

/** Apply the prior-entry gated upsert to pnpm-workspace.yaml; true when written. */
export function healRuntimeAgeExclude(projectRoot: string, targetVersion: string): boolean {
  const r = previewRuntimeAgeExcludeHeal(projectRoot, targetVersion);
  if (r === null) return false;
  writeFileSync(join(projectRoot, PNPM_WORKSPACE_FILE), r.text, "utf8");
  return true;
}

/** Human plan line when the heal will fire (#5854). */
export function formatAgeExcludeHealLine(r: AgeExcludeUpsert, targetVersion: string): string {
  return (
    `pnpm-workspace.yaml: replace minimumReleaseAgeExclude ${r.priorRuntimeItems.join(", ")} ` +
    `with one '${RUNTIME_AGE_EXCLUDE_PACKAGE}@${targetVersion}' entry (#5854)\n`
  );
}

/**
 * Shared seam for every exact runtime add (#5854 P2): upsert before the add (so
 * pnpm sees the target already excluded) and again after a successful add (so a
 * row pnpm appended collapses), before setup/migrate. Non-pnpm managers pass through.
 */
export function addWithRuntimeAgeExcludeHeal(
  projectRoot: string,
  pm: PackageManager,
  targetVersion: string,
  add: () => PmAddResult,
): PmAddResult {
  if (pm !== "pnpm") return add();
  healRuntimeAgeExclude(projectRoot, targetVersion);
  const result = add();
  if (result.ok) healRuntimeAgeExclude(projectRoot, targetVersion);
  return result;
}
