import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOENABLE_ORGS_ENV,
  clearOriginOrgCache,
  DEFAULT_AUTOENABLE_ORGS,
  detectOriginOrg,
  isTrustedOrgAutoEnable,
  resolveTrustedOrgs,
} from "./value-feedback-autoenable.js";

afterEach(() => {
  clearOriginOrgCache();
});

describe("resolveTrustedOrgs", () => {
  it("includes the built-in deftai org by default", () => {
    const orgs = resolveTrustedOrgs({});
    expect(orgs.has("deftai")).toBe(true);
    for (const org of DEFAULT_AUTOENABLE_ORGS) {
      expect(orgs.has(org.toLowerCase())).toBe(true);
    }
  });

  it("extends (never replaces) the set from the env override, normalized", () => {
    const orgs = resolveTrustedOrgs({ [AUTOENABLE_ORGS_ENV]: " Acme , Globex ,, " });
    expect(orgs.has("deftai")).toBe(true);
    expect(orgs.has("acme")).toBe(true);
    expect(orgs.has("globex")).toBe(true);
  });
});

describe("detectOriginOrg", () => {
  it("lowercases the owner segment of the resolved slug", () => {
    const org = detectOriginOrg("/tmp/x", { repoResolver: () => "DeftAI/statusreport" });
    expect(org).toBe("deftai");
  });

  it("returns null when there is no origin remote", () => {
    expect(detectOriginOrg("/tmp/x", { repoResolver: () => null })).toBeNull();
  });

  it("returns null (never throws) when the resolver throws", () => {
    expect(
      detectOriginOrg("/tmp/x", {
        repoResolver: () => {
          throw new Error("git absent");
        },
      }),
    ).toBeNull();
  });
});

describe("isTrustedOrgAutoEnable", () => {
  it("is true for a deftai-owned origin", () => {
    expect(isTrustedOrgAutoEnable("/tmp/x", { repoResolver: () => "deftai/cartograph" })).toBe(
      true,
    );
  });

  it("is false for a non-trusted org", () => {
    expect(isTrustedOrgAutoEnable("/tmp/x", { repoResolver: () => "someone-else/proj" })).toBe(
      false,
    );
  });

  it("is false when no origin remote resolves (fail-safe)", () => {
    expect(isTrustedOrgAutoEnable("/tmp/x", { repoResolver: () => null })).toBe(false);
  });

  it("honours an env-extended org", () => {
    expect(
      isTrustedOrgAutoEnable("/tmp/x", {
        repoResolver: () => "acme/widget",
        env: { [AUTOENABLE_ORGS_ENV]: "acme" },
      }),
    ).toBe(true);
  });
});
