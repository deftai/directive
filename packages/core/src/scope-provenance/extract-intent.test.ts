import { describe, expect, it } from "vitest";
import { extractIntentFromPayload, slugFromGithubIssueUri } from "./extract-intent.js";

describe("extract-intent file (#3385)", () => {
  it("parses github issue slugs and extracts title", () => {
    expect(slugFromGithubIssueUri("https://github.com/deftai/directive/issues/3385")).toBe(
      "deftai/directive",
    );
    const r = extractIntentFromPayload({ plan: { id: "x", title: "Hello" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preimage.plan.title).toBe("Hello");
  });
});
