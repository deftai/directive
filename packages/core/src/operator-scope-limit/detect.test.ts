import { describe, expect, it } from "vitest";
import { detectScopeLimitPhrase, extractRequirementLines } from "./detect.js";

describe("detect (#4545)", () => {
  it("detects do-not-add and extracts preceding requirement lines", () => {
    const prompt = ["- add vehicle", "", "Do not add features beyond the requirements."].join("\n");
    const hit = detectScopeLimitPhrase(prompt);
    expect(hit?.phrase).toContain("do not add");
    expect(extractRequirementLines(prompt, { beforeIndex: hit?.index })).toEqual(["add vehicle"]);
  });

  it("keeps requirements after an early ceiling phrase", () => {
    const prompt = ["Initial version only:", "- add vehicle"].join("\n");
    const hit = detectScopeLimitPhrase(prompt);
    expect(hit?.phrase).toBe("initial version only");
    expect(extractRequirementLines(prompt, { beforeIndex: hit?.index })).toEqual(["add vehicle"]);
  });

  it("does not record Out of scope bullets as requirements", () => {
    const prompt = [
      "Initial version only.",
      "Requirements:",
      "- add vehicle",
      "",
      "Out of scope:",
      "- delete vehicle",
      "- update vehicle",
    ].join("\n");
    expect(extractRequirementLines(prompt)).toEqual(["add vehicle"]);
  });

  it("treats Features not included / Must not ship as exclusion headers", () => {
    const prompt = [
      "Requirements:",
      "- add vehicle",
      "",
      "Features not included:",
      "- delete vehicle",
      "",
      "Must not ship:",
      "- update vehicle",
    ].join("\n");
    expect(extractRequirementLines(prompt)).toEqual(["add vehicle"]);
  });

  it("does not let a Do not include sentence drop later requirements", () => {
    const prompt = [
      "Requirements:",
      "- add vehicle",
      "Do not include analytics dashboards.",
      "- update mileage",
    ].join("\n");
    expect(extractRequirementLines(prompt)).toEqual(["add vehicle", "update mileage"]);
  });
});
