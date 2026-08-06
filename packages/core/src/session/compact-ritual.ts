/**
 * Soft post-compact / post-amnesia AGENTS re-bind (#3171 / epic #2769 pass-3).
 *
 * Single in-repo source of truth for the soft checklist. File-host compact and
 * SessionStart hooks, Codex best-effort SessionStart, and the OpenClaw durable
 * skill adapter all derive from this module — no divergent host-only rule text.
 *
 * Soft complements hard Tier-1 compact re-arm (#2113). Soft never replaces,
 * weakens, or short-circuits PreToolUse deny / mutation ritual.
 */

/** Epic + implement child anchors for docs and wire markers. */
export const SOFT_AGENTS_REBIND_EPIC = 2769;
export const SOFT_AGENTS_REBIND_ISSUE = 3171;
export const SOFT_AGENTS_REBIND_EVIDENCE_ISSUE = 3161;

/** Stable marker substring present in every host-facing soft deposit. */
export const SOFT_AGENTS_REBIND_MARKER =
  "Directive soft post-compact AGENTS re-bind (#3171 / #2769)";

/** Managed OpenClaw skill directory name (doctor/init deposit). */
export const OPENCLAW_SOFT_REBIND_SKILL_ID = "deft-directive-post-compact-rebind";

/** Sentinel inside managed OpenClaw skill bodies for rewrite detection. */
export const OPENCLAW_SOFT_REBIND_MANAGED_MARKER = "<!-- deft:managed soft-agents-rebind #3171 -->";

/**
 * Pass-3 §2 checklist obligations — one ordered list, all hosts consume.
 * Host adapters may wrap packaging; they must not invent alternate rule text.
 */
export const SOFT_AGENTS_REBIND_CHECKLIST = [
  {
    id: "reread-agents",
    text:
      "Re-read managed AGENTS.md session routing (#2176). Do not treat the " +
      "compaction summary or host runbook as SoT.",
  },
  {
    id: "confirm-learned",
    text:
      "Confirm-what-you-learned in the user-visible reply (brief): alignment " +
      "posture; addressing-name when USER.md applies; product SoT is not the " +
      "compaction/summary.",
  },
  {
    id: "deposit-integrity",
    text:
      "Deposit integrity: if .deft/core/main.md (or managed deposit) is missing " +
      "or broken while deft may still be on PATH, fail closed to doctor / " +
      "QUICK-START before product shell. (deft on PATH ≠ healthy deposit.)",
  },
  {
    id: "summary-not-sot",
    text:
      "Summary ≠ SoT: compaction/session runbooks (demo DBs, demo apps, ports, " +
      '"start the frontend") are hypotheses. Re-verify against PROJECT-DEFINITION ' +
      "/ USER.md / real local config before starting services or inventing demo " +
      "stacks. (#3161 G)",
  },
  {
    id: "operational-ask-trap",
    text:
      'Operational-ask trap: "open / start / run the app", "bring it up locally", ' +
      '"open the browser" are still session-routed. They are not an escape hatch ' +
      "from AGENTS.md, USER.md, or PROJECT-DEFINITION. (#3161 F)",
  },
  {
    id: "mutation-vs-readonly",
    text:
      "Mutation vs read-only: read-only / advisory / pure orientation → soft " +
      "checklist only (do not force full cold session:start). Mutation intent " +
      "(writes, implement, start-of-story) → soft checklist plus hard re-arm " +
      "where the host supports it (session:ready / session:start --rearm or cold) " +
      "before gated tools. Soft never authorizes skipping the mutation ritual for writes.",
  },
] as const;

export type SoftAgentsRebindChecklistId = (typeof SOFT_AGENTS_REBIND_CHECKLIST)[number]["id"];

/** Per-host soft deposit posture for docs + tests (#3171 matrix). */
export type SoftRebindHost = "cursor" | "claude" | "grok" | "codex" | "openclaw";

export interface SoftRebindHostRow {
  readonly host: SoftRebindHost;
  readonly family: string;
  readonly hardCompact: "deposited" | "unsupported";
  readonly softRebind: "required" | "docs-best-effort";
  readonly wire: string;
}

/**
 * Five-row host matrix (Cursor / Claude / Grok / Codex / OpenClaw).
 * Docs and deposit tests must stay aligned with this table.
 */
export const SOFT_REBIND_HOST_MATRIX: readonly SoftRebindHostRow[] = [
  {
    host: "cursor",
    family: "file-host hooks",
    hardCompact: "deposited",
    softRebind: "required",
    wire: "session.compact (preCompact) + session.start additional_context",
  },
  {
    host: "claude",
    family: "file-host hooks",
    hardCompact: "deposited",
    softRebind: "required",
    wire: "PreCompact/PostCompact + SessionStart additionalContext",
  },
  {
    host: "grok",
    family: "file-host hooks",
    hardCompact: "deposited",
    softRebind: "required",
    wire: "PreCompact/PostCompact + SessionStart soft cue (#3161 dogfood host)",
  },
  {
    host: "codex",
    family: "file-host (limited)",
    hardCompact: "unsupported",
    softRebind: "docs-best-effort",
    wire: "SessionStart soft cue only — no native compact hook",
  },
  {
    host: "openclaw",
    family: "Family-2 session host",
    hardCompact: "unsupported",
    softRebind: "required",
    wire: "durable workspace skill via doctor/init; not file-host hooks alone",
  },
] as const;

/** Forbidden soft wording — soft must never invite skipping mutation ritual. */
export const SOFT_REBIND_FORBIDDEN_PHRASES = [
  "skip session:start for writes",
  "skip the mutation ritual",
  "you may skip session:start",
  "ritual not required for writes",
  "soft replaces hard",
] as const;

/**
 * Format the shared soft checklist for host injection / skill bodies.
 */
export function formatSoftAgentsRebindChecklist(
  options: { readonly includeHeader?: boolean } = {},
): string {
  const includeHeader = options.includeHeader !== false;
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(SOFT_AGENTS_REBIND_MARKER);
    lines.push(
      "After compaction, resume, or long-session amnesia: restore AGENTS rule " +
        "memory before product action. Soft complements hard compact re-arm; " +
        "it does not complete or replace the gated mutation ritual.",
    );
    lines.push("");
  }
  lines.push("Soft AGENTS re-bind checklist:");
  SOFT_AGENTS_REBIND_CHECKLIST.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.text}`);
  });
  return lines.join("\n");
}

/**
 * Append soft checklist to a hard compact re-arm (or SessionStart) message.
 * Hard text stays first so existing recoveries remain discoverable.
 */
export function appendSoftAgentsRebindToMessage(hardMessage: string): string {
  const hard = hardMessage.trim();
  const soft = formatSoftAgentsRebindChecklist();
  if (hard.length === 0) return soft;
  if (hard.includes(SOFT_AGENTS_REBIND_MARKER)) return hard;
  return `${hard}\n\n${soft}`;
}

/** True when text carries the soft re-bind deposit (tests + doctor). */
export function isSoftAgentsRebindText(text: string): boolean {
  return text.includes(SOFT_AGENTS_REBIND_MARKER);
}

/** Soft cue events that should inject checklist without requiring a write tool. */
export function isSoftAgentsRebindEvent(
  event: string,
): event is "session.start" | "session.compact" {
  return event === "session.start" || event === "session.compact";
}

/**
 * Whether this decision should carry soft injection on the host wire.
 * Disabled / opt-out codes stay hard-message only.
 */
export function decisionCarriesSoftAgentsRebind(input: {
  readonly event: string;
  readonly code: string;
}): boolean {
  if (!isSoftAgentsRebindEvent(input.event)) return false;
  if (input.code === "session-start-disabled") return false;
  if (input.code === "directive-disabled") return false;
  return (
    input.code === "session-start" ||
    input.code === "session-start-degraded" ||
    input.code === "session-compact-rearm" ||
    input.code === "session-compact-rearm-degraded" ||
    input.code === "session-compact-noop"
  );
}

/**
 * Managed OpenClaw skill body generated from the same SoT checklist.
 * Skill-shaped packaging; obligations identical to file-host soft text.
 */
export function formatOpenClawSoftRebindSkillMarkdown(): string {
  const checklist = formatSoftAgentsRebindChecklist({ includeHeader: false });
  return [
    "---",
    `name: ${OPENCLAW_SOFT_REBIND_SKILL_ID}`,
    "description: >-",
    "  Soft post-compact / post-amnesia AGENTS re-bind for OpenClaw (#3171 / #2769).",
    "  Load after session start, gateway restart, or long-session amnesia.",
    "  Complements hard file-host compact re-arm; does not replace mutation ritual.",
    "---",
    OPENCLAW_SOFT_REBIND_MANAGED_MARKER,
    "",
    "# Soft post-compact AGENTS re-bind (OpenClaw)",
    "",
    SOFT_AGENTS_REBIND_MARKER,
    "",
    "OpenClaw is a **Family-2** session host. It does **not** claim file-host",
    "`PreCompact` / `PreToolUse` hard compact re-arm alone. This skill is the",
    "**required** durable soft surface: same checklist obligations as Cursor,",
    "Claude Code, and Grok Build.",
    "",
    "## When to load",
    "",
    "- Session start / resume after amnesia boundary",
    "- Gateway restart or new OpenClaw session context",
    "- Long-running session where AGENTS.md session routing may have dropped",
    "- Operational asks after summary resume (start/open app, demo stack)",
    "",
    "## Checklist (shared SoT — do not invent host-only rules)",
    "",
    checklist,
    "",
    "## Hard path honesty",
    "",
    "- Soft **never** authorizes skipping `session:start` / `session:ready` /",
    "  gated ritual for mutation (writes, implement, story start).",
    "- Where OpenClaw lacks file-host compact PreToolUse, operators still run",
    "  the mutation ritual via skills / CLI before gated writes.",
    "- Pins present ≠ session ritual completed.",
    "",
    "## Operator recovery",
    "",
    "- Deposit / refresh: `deft doctor --fix` (OpenClaw detected) or",
    "  `deft update` / `directive init` when OpenClaw signals are present.",
    "- After deposit: restart the OpenClaw gateway or start a new session so",
    "  skills reload.",
    "- Docs: `docs/openclaw-agent-host.md` § Soft post-compact AGENTS re-bind.",
    "",
  ].join("\n");
}

/** True when skill body is the managed #3171 soft re-bind deposit. */
export function isManagedOpenClawSoftRebindSkill(body: string): boolean {
  return body.includes(OPENCLAW_SOFT_REBIND_MANAGED_MARKER);
}

/**
 * Assert soft text never invites skipping mutation ritual (unit + deposit tests).
 * Returns empty array when clean.
 */
export function softAgentsRebindForbiddenHits(text: string): string[] {
  const lower = text.toLowerCase();
  return SOFT_REBIND_FORBIDDEN_PHRASES.filter((phrase) => lower.includes(phrase.toLowerCase()));
}
