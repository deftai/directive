import { describe, expect, it } from "vitest";
import { readCeilingFromBrief, seedOperatorScopeCeiling } from "./seed.js";

describe("seed (#4545)", () => {
  it("seeds a durable ceiling without a prior active brief", () => {
    const result = seedOperatorScopeCeiling(
      "add vehicle\n\nStart with this initial version only.",
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief).toBeNull();
    expect(result.artifact.matchedPhrase).toBe("initial version only");
    expect(readCeilingFromBrief(null)).toBeNull();
  });
});
