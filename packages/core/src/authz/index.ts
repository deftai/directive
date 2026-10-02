/**
 * Human-origin approval grants + UAT mutation lease (#2944 Wave 1)
 * + closed-verb release gates / AFK templates (#1095 Wave 4)
 * + structural scope:decompose apply digest gate (#3239).
 */

export * from "./actions.js";
export * from "./classify.js";
export * from "./closed-verb.js";
export * from "./decompose-apply.js";
export * from "./evaluate.js";
export * from "./origin.js";
export * from "./paths.js";
export * from "./store.js";
export * from "./templates.js";
export * from "./types.js";
// Campaign-end seal factory is CLI-only (`./campaign-end-seal` subpath) — not here (#4233).
export {
  type AuthzStateWriteIntentClass,
  type AuthzUatWriteDecision,
  type AuthzUatWriteRefuseCode,
  classifyAuthzStateWriteIntent,
  classifyGrantWriteIntent,
  type EvaluateAuthzStateWriteOptions,
  evaluateAuthzStateWriteUnderUat,
  evaluateGrantWriteUnderUat,
  type GrantWriteIntentClass,
  isUatCampaignEndSeal,
  type UatCampaignEndSeal,
} from "./uat-write-guard.js";
export * from "./verb-classification.js";
