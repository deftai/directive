import { describe, expect, it } from "vitest";
import { compareExtractedIntent } from "./compare-intent.js";
import { extractIntentFromPayload } from "./extract-intent.js";

describe("compareExtractedIntent file (#3385)", () => {
  it("returns ok when preimages match", () => {
    const payload = {
      plan: { id: "a", title: "T", narratives: { Description: "d" } },
    };
    const a = extractIntentFromPayload(payload);
    const b = extractIntentFromPayload(payload);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(compareExtractedIntent(a.preimage, b.preimage).ok).toBe(true);
  });
});
