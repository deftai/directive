/** Canonical process-cost event names for ceremony observability (#2994). */
export const PROCESS_COST_EVENT_NAMES = {
  sessionStart: "session:start",
  sessionRitualBlocked: "session:ritual-blocked",
} as const;

export type ProcessCostEventName =
  (typeof PROCESS_COST_EVENT_NAMES)[keyof typeof PROCESS_COST_EVENT_NAMES];

/** Required payload keys per process-cost event (merged into lifecycle/events). */
export const PROCESS_COST_REQUIRED_PAYLOAD: Readonly<Record<string, readonly string[]>> = {
  [PROCESS_COST_EVENT_NAMES.sessionStart]: ["ceremony_tier", "duration_ms", "exit_code"],
  [PROCESS_COST_EVENT_NAMES.sessionRitualBlocked]: ["tool_name", "code"],
};
