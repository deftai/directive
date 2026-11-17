import { describe, expect, it } from "vitest";
import { computeRefusalCensus, type RefusalCensus } from "../refusal-declarations/census.js";
import { loadRefusalDeclarations } from "../refusal-declarations/table.js";
import { formatConsumerReadinessDisclosure } from "./consumer-readiness-disclosure.js";

const EMPTY_CENSUS: RefusalCensus = { baseline: "v0.0.0", baselineRead: true, rows: [] };

describe("formatConsumerReadinessDisclosure (#3900 checks 5-6)", () => {
  it("never sets blocking true", () => {
    const result = formatConsumerReadinessDisclosure(
      "## [Unreleased]\n\n### Added\n- fail-closed deposit closure verifier.\n",
      { census: EMPTY_CENSUS },
    );
    expect(result.blocking).toBe(false);
    expect(result.text).toContain("does not block the tag");
    expect(result.text).toContain("operator judgment");
    expect(result.text).toContain("The operator decides");
    expect(result.newRefusalHints.length).toBeGreaterThan(0);
  });

  it("does not treat an empty Unreleased as a computed all-clear verdict", () => {
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n\n### Added\n\n", {
      census: EMPTY_CENSUS,
    });
    expect(result.blocking).toBe(false);
    expect(result.newRefusalHints).toEqual([]);
    expect(result.text).toContain("No Unreleased lines matched");
  });
});

describe("Check 5 declared-refusal census (#6281)", () => {
  const enforceRows = (n: number) =>
    loadRefusalDeclarations(
      Array.from({ length: n }, (_, i) => ({
        id: `gate-${i}`,
        gate: "g",
        mode: "enforce",
        remedy: ["x"],
      })),
    );

  it("prints the baseline it compared against", () => {
    const census = computeRefusalCensus(enforceRows(1), { label: "v0.129.13", rows: [] });
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n", { census });
    expect(result.text).toContain("Declared refusals: baseline v0.129.13.");
    expect(result.refusalCensus).toBe(census);
  });

  it("lists a new enforce row with no warn release and does not block", () => {
    const census = computeRefusalCensus(enforceRows(1), { label: "v1", rows: [] });
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n", { census });
    expect(result.text).toContain("gate-0 (enforce): new in this release with no warn release");
    expect(result.blocking).toBe(false);
  });

  it("lists every row as unknown when the baseline is not read, and does not block", () => {
    const census = computeRefusalCensus(enforceRows(2), { label: "tag not found", rows: null });
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n", { census });
    expect(result.text).toContain("gate-0 (enforce): unknown (baseline not read)");
    expect(result.text).toContain("gate-1 (enforce): unknown (baseline not read)");
    expect(result.blocking).toBe(false);
  });

  it("prints every changed row when more than 20 changed", () => {
    const census = computeRefusalCensus(enforceRows(25), { label: "v1", rows: [] });
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n", { census });
    for (let i = 0; i < 25; i += 1) {
      expect(result.text).toContain(`  - gate-${i} (enforce)`);
    }
  });

  it("returns blocking false for any Unreleased content", () => {
    const census = computeRefusalCensus(enforceRows(3), { label: "v1", rows: [] });
    for (const text of [
      "",
      "no unreleased heading",
      "## [Unreleased]\n- New gate MUST NOT pass; refuses to tag; blocks the release.\n",
      `## [Unreleased]\n${"- fail-closed refusal\n".repeat(40)}## [1.0.0]\n`,
    ]) {
      expect(formatConsumerReadinessDisclosure(text, { census }).blocking).toBe(false);
    }
  });

  it("computes the census against a project root when none is passed", () => {
    const result = formatConsumerReadinessDisclosure("## [Unreleased]\n", {
      projectRoot: "Z:/no-such-root-6281",
    });
    expect(result.refusalCensus.baselineRead).toBe(false);
    expect(result.text).toContain("Declared refusals: baseline");
    expect(result.blocking).toBe(false);
  });
});
