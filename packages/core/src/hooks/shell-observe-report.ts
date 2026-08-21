/**
 * Summarize `.deft/shell-observations.jsonl` (#3438 follow-up).
 *
 * The observation log answers one question the dest-form debate could not:
 * which Shell commands actually reach the gate, and how many of them land in a
 * fail-OPEN class. Without this, #3594's default state and #3595's false-positive
 * budget are both guesses.
 *
 * Read-only and tolerant: a partially-written or hand-edited log must summarize
 * what it can rather than throw.
 */

import { readFileSync } from "node:fs";
import type { ShellObservation } from "./shell-observe.js";
import { shellObservationPath } from "./shell-observe.js";

export interface ShellObservationSummary {
  readonly total: number;
  readonly malformed: number;
  readonly allowed: number;
  readonly denied: number;
  /** Allowed with no recognized dest-form — the fail-OPEN surface. */
  readonly allowedUnrecognized: number;
  /** Denied because no target could be resolved — the fail-CLOSED surface. */
  readonly deniedUnresolved: number;
  /** Share of allows that were unrecognized, 0-1. The headline number. */
  readonly unrecognizedAllowRate: number;
  /** Decision code → count, descending. */
  readonly byCode: readonly (readonly [string, number])[];
  /** First token of allowed+unrecognized commands → count, descending. */
  readonly unrecognizedVerbs: readonly (readonly [string, number])[];
}

/** First whitespace-delimited token, minus a leading env-assignment run. */
export function observedVerb(command: string): string {
  for (const raw of command.trim().split(/\s+/)) {
    if (raw.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    return raw;
  }
  return "";
}

function descending(counts: Map<string, number>): (readonly [string, number])[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function summarizeShellObservations(lines: readonly string[]): ShellObservationSummary {
  let malformed = 0;
  let allowed = 0;
  let denied = 0;
  let allowedUnrecognized = 0;
  let deniedUnresolved = 0;
  const byCode = new Map<string, number>();
  const verbs = new Map<string, number>();

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: ShellObservation;
    try {
      parsed = JSON.parse(line) as ShellObservation;
    } catch {
      malformed++;
      continue;
    }
    if (typeof parsed?.verdict !== "string" || typeof parsed?.command !== "string") {
      malformed++;
      continue;
    }
    byCode.set(parsed.code, (byCode.get(parsed.code) ?? 0) + 1);
    if (parsed.verdict === "deny") {
      denied++;
      if (parsed.unresolvedDest === true) deniedUnresolved++;
      continue;
    }
    allowed++;
    if (parsed.unrecognized === true) {
      allowedUnrecognized++;
      const verb = observedVerb(parsed.command);
      if (verb.length > 0) verbs.set(verb, (verbs.get(verb) ?? 0) + 1);
    }
  }

  return {
    total: allowed + denied,
    malformed,
    allowed,
    denied,
    allowedUnrecognized,
    deniedUnresolved,
    unrecognizedAllowRate: allowed === 0 ? 0 : allowedUnrecognized / allowed,
    byCode: descending(byCode),
    unrecognizedVerbs: descending(verbs),
  };
}

/** Summarize the log under `projectRoot`. A missing log summarizes as empty. */
export function summarizeShellObservationsAt(projectRoot: string): ShellObservationSummary {
  let raw = "";
  try {
    raw = readFileSync(shellObservationPath(projectRoot), "utf8");
  } catch {
    raw = "";
  }
  return summarizeShellObservations(raw.split("\n"));
}

export function formatShellObservationSummary(
  summary: ShellObservationSummary,
  options: { readonly topVerbs?: number } = {},
): string {
  const top = options.topVerbs ?? 15;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const out: string[] = [];
  out.push(`Shell observations: ${summary.total} decision(s)`);
  out.push(`  allowed: ${summary.allowed}  denied: ${summary.denied}`);
  out.push(
    `  fail-OPEN (allowed, no dest-form recognized): ${summary.allowedUnrecognized}` +
      ` (${pct(summary.unrecognizedAllowRate)} of allows)`,
  );
  out.push(`  fail-CLOSED (denied, target unresolvable): ${summary.deniedUnresolved}`);
  if (summary.malformed > 0) out.push(`  malformed lines skipped: ${summary.malformed}`);
  if (summary.byCode.length > 0) {
    out.push("  by code:");
    for (const [code, count] of summary.byCode) out.push(`    ${count}  ${code}`);
  }
  if (summary.unrecognizedVerbs.length > 0) {
    out.push(`  top unrecognized verbs (fail-open candidates for #3595):`);
    for (const [verb, count] of summary.unrecognizedVerbs.slice(0, top)) {
      out.push(`    ${count}  ${verb}`);
    }
  }
  return out.join("\n");
}
