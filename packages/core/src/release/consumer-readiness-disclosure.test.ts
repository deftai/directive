import { describe, expect, it } from "vitest";
import { formatConsumerReadinessDisclosure } from "./consumer-readiness-disclosure.js";

describe("formatConsumerReadinessDisclosure (#3900 checks 5-6)", () => {
  it("never sets blocking true", () => {
    const result = formatConsumerReadinessDisclosure(
      "## [Unreleased]\n\n### Added\n- fail-closed deposit closure verifier.\n",
    );
    expect(result.blocking).toBe(false);
    expect(result.text).toContain("does not block the tag");
    expect(result.text).toContain("operator judgment");
    expect(result.text).toContain("The operator decides");
    expect(result.newRefusalHints.length).toBeGreaterThan(0);
  });

  it("does not treat an empty Unreleased as a computed all-clear verdict", () => {
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n\n### Added\n\n");
    expect(result.blocking).toBe(false);
    expect(result.newRefusalHints).toEqual([]);
    expect(result.text).toContain("No Unreleased lines matched");
  });
});
