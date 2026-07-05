/** Canonical behavioral event names for the attribution ledger (#1709). */
export const ATTRIBUTION_EVENT_NAMES = {
  valueGateCatch: "value:gate-catch",
  valueWipCapProtect: "value:wip-cap-protect",
  bypassOffFlow: "bypass:off-flow",
  adoptionUnusedCapability: "adoption:unused-capability",
  frictionDirectiveGap: "friction:directive-gap",
} as const;

export type AttributionEventName =
  (typeof ATTRIBUTION_EVENT_NAMES)[keyof typeof ATTRIBUTION_EVENT_NAMES];

/** Required payload keys per attribution event (merged into lifecycle/events). */
export const ATTRIBUTION_REQUIRED_PAYLOAD: Readonly<Record<string, readonly string[]>> = {
  [ATTRIBUTION_EVENT_NAMES.valueGateCatch]: ["signal_class", "source"],
  [ATTRIBUTION_EVENT_NAMES.valueWipCapProtect]: ["signal_class", "source", "count", "cap"],
  [ATTRIBUTION_EVENT_NAMES.bypassOffFlow]: ["signal_class", "source"],
  [ATTRIBUTION_EVENT_NAMES.adoptionUnusedCapability]: ["signal_class", "source", "capability"],
  [ATTRIBUTION_EVENT_NAMES.frictionDirectiveGap]: ["signal_class", "source"],
};

export const ALL_ATTRIBUTION_EVENT_NAMES = Object.values(ATTRIBUTION_EVENT_NAMES);
