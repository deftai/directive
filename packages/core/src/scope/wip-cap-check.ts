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
  const capResult = resolveWipCap(projectRoot);
  const cap = capResult.cap;
  const count = countVbriefWip(projectRoot);
  const overCap = count >= cap;
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
    "  task scope:promote <file> --force                          # override (logged)"
  );
}
