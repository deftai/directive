import { describe, expect, it } from "vitest";
import { sanitizeSessionDirName, suiteTeeRelativePath } from "./suite-gate-supervisor-lib.js";

describe("suite-gate-supervisor-lib", () => {
  it("keeps sessionId as a directory prefix", () => {
    expect(sanitizeSessionDirName("host:grok:v1:abc")).toBe("host_grok_v1_abc");
    expect(suiteTeeRelativePath("sess", "1-abcd").startsWith(".deft/check-tees/sess/")).toBe(true);
  });
});
