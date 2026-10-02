/**
 * Opaque UAT campaign-end seal identity (#4233).
 *
 * Not in package.json exports. CLI obtains the factory only via
 * `./authz/campaign-end-seal`. Agents cannot plant this via argv/grant JSON.
 */

/** Opaque seal for `uat.active` true→false only. Not reconstructible from JSON/argv. */
const UAT_CAMPAIGN_END_SEAL: unique symbol = Symbol("deft.authz.uatCampaignEnd");

export type UatCampaignEndSeal = typeof UAT_CAMPAIGN_END_SEAL;

export function isUatCampaignEndSeal(value: unknown): value is UatCampaignEndSeal {
  return value === UAT_CAMPAIGN_END_SEAL;
}

/** Factory for the CLI campaign-end-seal subpath after gateConfirm. */
export function uatCampaignEndSeal(): UatCampaignEndSeal {
  return UAT_CAMPAIGN_END_SEAL;
}
