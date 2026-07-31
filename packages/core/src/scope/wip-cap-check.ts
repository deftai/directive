import { countVbriefWip, resolveWipCap } from "../policy/wip.js";

export interface WipCapCheck {
  readonly allowed: boolean;
  readonly cap: number;
  readonly count: number;
  readonly source: string;
  readonly forceOverride: boolean;
}

/** Resolve WIP cap and decide if promotion is allowed (#1124). */
export function checkWipCap(projectRoot: string, force = false): WipCapCheck {
  return checkWipCapForAdditional(projectRoot, 1, force);
}

/**
 * WIP check for promoting `additional` scopes in one batch (#3011).
 * Single promote is `additional = 1` (same as historic count >= cap refuse).
 * Batch of N refuses when `count + N > cap` unless `--force`.
 */
export function checkWipCapForAdditional(
  projectRoot: string,
  additional: number,
  force = false,
): WipCapCheck {
  const capResult = resolveWipCap(projectRoot);
  const cap = capResult.cap;
  const count = countVbriefWip(projectRoot);
  const add = Math.max(0, Math.floor(additional));
  // Single-promote parity: refuse when already at/over cap before adding one.
  // Batch: refuse when current + additional would exceed the cap.
  const overCap = add <= 1 ? count >= cap : count + add > cap;
  if (!overCap) {
    return { allowed: true, cap, count, source: capResult.source, forceOverride: false };
  }
  if (force) {
    return { allowed: true, cap, count, source: capResult.source, forceOverride: true };
  }
  return { allowed: false, cap, count, source: capResult.source, forceOverride: false };
}

export function formatWipCapRefusal(check: WipCapCheck): string {
  return (
    `ERROR: WIP cap reached (${check.count}/${check.cap} in pending/+active/). ` +
    "Either:\n" +
    "  task scope:demote <existing>                              # return one to proposed/\n" +
    "  task scope:demote --batch --older-than-days 30            # bulk relief (D9 folded into D1)\n" +
    "  task scope:promote <file> --force                          # override (logged)\n" +
    "  task scope:promote --batch --force                         # batch override (#3011)"
  );
}
