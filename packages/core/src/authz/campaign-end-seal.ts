/**
 * CLI-only campaign-end seal accessor (#4233).
 *
 * Not re-exported from `@deftai/directive-core/authz`. Import this subpath
 * only from the human-presence CLI after gateConfirm — not from agent code.
 * The factory is not on `uat-write-guard` so the public authz barrel cannot
 * reach it even via transitive re-exports of write-guard predicates.
 */
export { type UatCampaignEndSeal, uatCampaignEndSeal } from "./seal-symbol.js";
