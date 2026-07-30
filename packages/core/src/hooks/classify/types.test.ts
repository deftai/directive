import { describe, expect, it } from "vitest";
import { CLASSIFY_HOOK_HOSTS } from "./types.js";

describe("classify types (#2950)", () => {
  it("enumerates known hosts", () => {
    expect(CLASSIFY_HOOK_HOSTS).toContain("cursor");
    expect(CLASSIFY_HOOK_HOSTS).toContain("claude");
  });
});
