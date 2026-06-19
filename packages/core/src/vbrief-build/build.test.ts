import { describe, expect, it } from "vitest";
import {
  createScopeVbrief,
  referenceHasRequiredFields,
  referenceWithDefaultTrust,
  slugify,
} from "./build.js";
import { MIGRATOR_METADATA_KEY } from "./constants.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Add widget (v2)!")).toBe("add-widget-v2");
    expect(slugify("task_id_foo")).toBe("task-id-foo");
  });

  it("truncates at 60 chars", () => {
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("createScopeVbrief", () => {
  it("emits canonical reference with trust", () => {
    const result = createScopeVbrief(
      { number: "99", title: "Test feature", phase: "Phase 1" },
      "https://github.com/owner/repo",
    );
    expect(result.vBRIEFInfo).toEqual({
      version: "0.6",
      description: "Scope vBRIEF for #99: Test feature",
    });
    const refs = (result.plan as Record<string, unknown>).references as Record<string, unknown>[];
    expect(refs[0]?.TrustLevel).toBe("external");
  });

  it("omits references without repo url", () => {
    const result = createScopeVbrief({ number: "123", title: "Bug fix" }, "");
    expect((result.plan as Record<string, unknown>).references).toBeUndefined();
  });

  it("stores phase description in migrator metadata", () => {
    const result = createScopeVbrief(
      { number: "7", title: "Feature", phase: "Phase 1", tier: "1" },
      "https://github.com/o/r",
      "pending",
      "Deliver the foundation layer",
    );
    const plan = result.plan as Record<string, unknown>;
    const metadata = plan.metadata as Record<string, unknown>;
    const migrator = metadata[MIGRATOR_METADATA_KEY] as Record<string, unknown>;
    expect(migrator.PhaseDescription).toBe("Deliver the foundation layer");
  });

  it("normalizes github issue references", () => {
    const withHash = createScopeVbrief(
      { number: "##42", title: "Untitled" },
      "https://github.com/o/r/",
    );
    const refs = (withHash.plan as Record<string, unknown>).references as Record<string, unknown>[];
    expect(refs[0]?.title).toBe("Issue #42");
    expect(refs[0]?.uri).toBe("https://github.com/o/r/issues/42");
    const noNumber = createScopeVbrief(
      { number: "  ", title: "Only title" },
      "https://github.com/o/r",
    );
    expect((noNumber.plan as Record<string, unknown>).references).toBeUndefined();
  });

  it("validates reference required fields", () => {
    expect(referenceHasRequiredFields(null)).toBe(false);
    expect(referenceHasRequiredFields({ uri: "  ", type: "x-vbrief/plan" })).toBe(false);
    expect(referenceHasRequiredFields({ uri: "u", type: "t" })).toBe(true);
  });

  it("strips multiple trailing slashes from the repo url (rstrip parity)", () => {
    const refUri = (repoUrl: string): string => {
      const scope = createScopeVbrief({ number: "9", title: "T" }, repoUrl);
      const refs = (scope.plan as Record<string, unknown>).references as Record<string, unknown>[];
      return refs[0]?.uri as string;
    };
    expect(refUri("https://github.com/o/r/")).toBe("https://github.com/o/r/issues/9");
    expect(refUri("https://github.com/o/r///")).toBe("https://github.com/o/r/issues/9");
    expect(refUri("  https://github.com/o/r//  ")).toBe("https://github.com/o/r/issues/9");
  });
});

describe("referenceWithDefaultTrust", () => {
  it("fills internal and external defaults", () => {
    expect(
      referenceWithDefaultTrust({ type: "x-vbrief/plan", uri: "specification.vbrief.json" })
        .TrustLevel,
    ).toBe("internal");
    expect(
      referenceWithDefaultTrust({
        type: "x-vbrief/github-issue",
        uri: "https://github.com/o/r/issues/1",
        title: "Issue #1",
      }).TrustLevel,
    ).toBe("external");
  });
});
