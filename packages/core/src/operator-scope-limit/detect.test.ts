import { describe, expect, it } from "vitest";
import { detectScopeLimitPhrase, extractRequirementLines } from "./detect.js";

describe("detect (#4545)", () => {
  it("detects do-not-add and extracts preceding requirement lines", () => {
    const prompt = ["- add vehicle", "", "Do not add features beyond the requirements."].join(
      "\n",
    );
    const hit = detectScopeLimitPhrase(prompt);
    expect(hit?.phrase).toContain("do not add");
    expect(extractRequirementLines(prompt, { beforeIndex: hit!.index })).toEqual(["add vehicle"]);
  });
});
