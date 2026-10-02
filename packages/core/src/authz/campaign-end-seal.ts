/**
 * CLI-only campaign-end seal accessor (#4233).
 *
 * Not re-exported from `@deftai/directive-core/authz`. Import this subpath
 * only from the human-presence CLI after gateConfirm — not from agent code.
 */
export { type UatCampaignEndSeal, uatCampaignEndSeal } from "./uat-write-guard.js";
