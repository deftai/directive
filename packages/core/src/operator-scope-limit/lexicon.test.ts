import { describe, expect, it } from "vitest";
import { SCOPE_LIMIT_PHRASES } from "./lexicon.js";

describe("lexicon (#4545)", () => {
  it("keeps longest variants ahead of shorter stems", () => {
    expect(SCOPE_LIMIT_PHRASES[0]!.length).toBeGreaterThan(SCOPE_LIMIT_PHRASES.at(-1)!.length);
    expect(SCOPE_LIMIT_PHRASES).toContain("initial version only");
  });
});
