import { describe, expect, it } from "vitest";
import { bodyDigestIsAuthority, parseIntentPreimageRaw } from "./intent-evaluate.js";

describe("intent-evaluate file (#3385)", () => {
  it("never treats xbriefBodyDigest as authority and rejects bad preimages", () => {
    expect(bodyDigestIsAuthority({ xbriefBodyDigest: "dead" } as never)).toBe(false);
    expect(parseIntentPreimageRaw("not-json")).toBeNull();
    expect(parseIntentPreimageRaw("{}")).toBeNull();
  });
});
