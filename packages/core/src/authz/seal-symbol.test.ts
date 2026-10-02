/**
 * Opaque campaign-end seal identity (#4233).
 */
import { describe, expect, it } from "vitest";
import { isUatCampaignEndSeal, uatCampaignEndSeal } from "./seal-symbol.js";

describe("authz/seal-symbol", () => {
  it("factory returns the opaque seal accepted by the type guard", () => {
    const seal = uatCampaignEndSeal();
    expect(isUatCampaignEndSeal(seal)).toBe(true);
    expect(isUatCampaignEndSeal(Symbol("forged"))).toBe(false);
    expect(isUatCampaignEndSeal("seal")).toBe(false);
    expect(isUatCampaignEndSeal(null)).toBe(false);
  });
});
