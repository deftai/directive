/**
 * CLI campaign-end seal subpath (#4233).
 */
import { describe, expect, it } from "vitest";
import { uatCampaignEndSeal } from "./campaign-end-seal.js";
import { isUatCampaignEndSeal } from "./uat-write-guard.js";

describe("authz/campaign-end-seal", () => {
  it("returns the opaque seal accepted by isUatCampaignEndSeal", () => {
    const seal = uatCampaignEndSeal();
    expect(isUatCampaignEndSeal(seal)).toBe(true);
    expect(isUatCampaignEndSeal(Symbol("forged"))).toBe(false);
    expect(isUatCampaignEndSeal("seal")).toBe(false);
  });
});
