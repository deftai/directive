import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const HYGIENE = "coding/hygiene.md";
const CODING = "coding/coding.md";
const BUILD = "skills/deft-directive-build/SKILL.md";
const REVIEW = "skills/deft-directive-review-cycle/SKILL.md";
const SURFACE_HEADING = "## Surface Conflicts: Pick One, Explain, Flag the Other (#1005)";
const FAIL_HEADING = "## Fail Loud: Completion Claims Require Outcome Verification (#1006)";
const TESTING = "coding/testing.md";
const TEST_INTEGRITY_HEADING = "## Test integrity";
const MOCK_BOUNDARY_HEADING = "## Mock boundary";

function surfaceBody(text: string): string {
  const m = text.match(
    /## Surface Conflicts: Pick One, Explain, Flag the Other \(#1005\)\s*(.*?)(?=^---|^## |Z)/ms,
  );
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

function failBody(text: string): string {
  const m = text.match(
    /## Fail Loud: Completion Claims Require Outcome Verification \(#1006\)\s*(.*?)(?=^## |Z)/ms,
  );
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

function testingSectionBody(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`${escaped}\\s*(.*?)(?=^---|^## |Z)`, "ms"));
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

function unitTestsBody(text: string): string {
  const m = text.match(/### Unit Tests\s*(.*?)(?=^### |^## |Z)/ms);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

describe("test_coding_rules.py", () => {
  describe("TestSurfaceConflictsRule1005", () => {
    it("test_rule_heading_present_in_hygiene_md", () => {
      expect(readText(HYGIENE)).toContain(SURFACE_HEADING);
    });
    it("test_rule_body_carries_must_token", () => {
      expect(/^- ! /m.test(surfaceBody(readText(HYGIENE)))).toBe(true);
    });
    it("test_rule_body_carries_must_not_anti_pattern", () => {
      expect(surfaceBody(readText(HYGIENE))).toContain("⊗");
    });
    it("test_rule_body_mentions_pick_one", () => {
      expect(surfaceBody(readText(HYGIENE)).toLowerCase()).toContain("pick one");
    });
    it("test_rule_body_forbids_blending", () => {
      const body = surfaceBody(readText(HYGIENE)).toLowerCase();
      expect(
        body.includes("blend") || body.includes("satisfy both") || body.includes("average"),
      ).toBe(true);
    });
    it("test_coding_md_anti_pattern_cross_reference", () => {
      expect(/#1005/.test(readText(CODING))).toBe(true);
    });
    it("test_build_skill_step1_enforces_rule", () => {
      const text = readText(BUILD);
      expect(text).toContain("#1005");
      expect(
        /- ! .*Surface Conflicts.*#1005/i.test(text) ||
          /- ! .*contradicting patterns.*#1005/i.test(text),
      ).toBe(true);
    });
  });
  describe("TestFailLoudRule1006", () => {
    it("test_rule_heading_present_in_coding_md", () => {
      expect(readText(CODING)).toContain(FAIL_HEADING);
    });
    it("test_rule_body_carries_must_token", () => {
      expect(/^- ! /m.test(failBody(readText(CODING)))).toBe(true);
    });
    it("test_rule_body_carries_must_not_anti_pattern", () => {
      expect(failBody(readText(CODING))).toContain("⊗");
    });
    it("test_rule_body_mentions_outcome_verification", () => {
      expect(failBody(readText(CODING)).toLowerCase()).toContain("outcome");
    });
    it("test_rule_body_covers_three_canonical_examples", () => {
      const body = failBody(readText(CODING)).toLowerCase();
      expect(body).toContain("migration");
      expect(body).toContain("tests pass");
      expect(body).toContain("feature works");
    });
    it("test_coding_md_anti_pattern_cross_reference", () => {
      expect(/#1006/.test(readText(CODING))).toBe(true);
    });
    it("test_review_cycle_skill_step3_enforces_rule", () => {
      const text = readText(REVIEW);
      expect(text).toContain("#1006");
      expect(/- ! .*Fail-loud.*#1006/i.test(text) || /- ! .*#1006/.test(text)).toBe(true);
    });
    it("test_fail_loud_requires_open_graduation_disclosure", () => {
      const body = failBody(readText(CODING));
      expect(body).toContain("graduationRef");
      expect(body).toContain("#2899");
      expect(body.toLowerCase()).toContain("production-ready");
      expect(body.toLowerCase()).toMatch(/open graduation|open graduations/);
    });
    it("test_fail_loud_allows_explicit_graduation_skip", () => {
      const body = failBody(readText(CODING)).toLowerCase();
      expect(body.includes("skipped") || body.includes("skip")).toBe(true);
    });
    it("test_coding_md_anti_pattern_mentions_graduation", () => {
      expect(readText(CODING)).toMatch(/open graduations.*#2899|#2899.*open graduations/s);
    });
  });
  describe("TestIntegrityAndMockBoundary1164", () => {
    it("test_test_integrity_heading_present", () => {
      expect(readText(TESTING)).toContain(TEST_INTEGRITY_HEADING);
    });
    it("test_mock_boundary_heading_present", () => {
      expect(readText(TESTING)).toContain(MOCK_BOUNDARY_HEADING);
    });
    it("test_integrity_body_carries_must_and_must_not", () => {
      const body = testingSectionBody(readText(TESTING), TEST_INTEGRITY_HEADING);
      expect(/^- ! /m.test(body)).toBe(true);
      expect(body).toContain("⊗");
    });
    it("test_mock_body_carries_must_and_must_not", () => {
      const body = testingSectionBody(readText(TESTING), MOCK_BOUNDARY_HEADING);
      expect(/^- ! /m.test(body)).toBe(true);
      expect(body).toContain("⊗");
    });
    it("test_integrity_body_matches_anti_gaming_tokens", () => {
      const body = testingSectionBody(readText(TESTING), TEST_INTEGRITY_HEADING).toLowerCase();
      expect(body).toMatch(/delete|skip|xfail|comment-out/);
      expect(body).toMatch(/tolerance|snapshot|matcher/);
    });
    it("test_mock_body_names_data_layer_and_authz", () => {
      const body = testingSectionBody(readText(TESTING), MOCK_BOUNDARY_HEADING).toLowerCase();
      expect(body).toContain("data layer");
      expect(body.includes("permission") || body.includes("authorization")).toBe(true);
    });
    it("test_unit_tests_no_longer_bare_use_mocks_stubs", () => {
      const body = unitTestsBody(readText(TESTING));
      expect(body).not.toMatch(/No external dependencies \(use mocks\/stubs\)/);
      expect(body.toLowerCase()).toContain("mock boundary");
    });
  });
  describe("TestLessonsCrossReference", () => {
    for (const issueTag of ["#1005", "#1006", "#1164"]) {
      it(`test_lessons_md_has_short_cross_reference ${issueTag}`, () => {
        expect(readText("meta/lessons.md")).toContain(issueTag);
      });
    }
  });
});
