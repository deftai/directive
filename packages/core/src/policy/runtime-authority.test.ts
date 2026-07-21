import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  inspectRuntimeAuthority,
  loadRuntimeAuthorityPolicy,
  resolveRuntimeAuthorityPolicy,
  validateRuntimeAuthority,
} from "./runtime-authority.js";

describe("runtimeAuthority policy (#1394)", () => {
  it("defaults to disabled with permissive path lists", () => {
    expect(DEFAULT_RUNTIME_AUTHORITY_POLICY).toMatchObject({
      enabled: false,
      allowPaths: [],
      denyPaths: [],
      scopes: { edits: true, push: false, merge: false },
    });
  });

  it("resolves typed blocks", () => {
    const resolved = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: ["src/**"],
      denyPaths: [".env"],
      scopes: { edits: true, push: true, merge: false },
    });
    expect(resolved).toMatchObject({
      enabled: true,
      allowPaths: ["src/**"],
      denyPaths: [".env"],
      scopes: { edits: true, push: true, merge: false },
    });
  });

  it("validates shape", () => {
    expect(validateRuntimeAuthority(null)).toEqual([]);
    expect(validateRuntimeAuthority({ enabled: "yes" })).toContain(
      "plan.policy.runtimeAuthority.enabled must be a boolean",
    );
    expect(validateRuntimeAuthority({ allowPaths: "src" })).toContain(
      "plan.policy.runtimeAuthority.allowPaths must be an array of path globs",
    );
  });

  it("inspects from PROJECT-DEFINITION data", () => {
    const field = inspectRuntimeAuthority({
      plan: {
        policy: {
          runtimeAuthority: { enabled: true, denyPaths: ["secrets/**"] },
        },
      },
    });
    expect(field.source).toBe("typed");
    expect(field.current.enabled).toBe(true);
    expect(field.current.denyPaths).toEqual(["secrets/**"]);
  });

  it("loads from plan block", () => {
    const policy = loadRuntimeAuthorityPolicy({
      plan: { policy: { runtimeAuthority: { enabled: true } } },
    });
    expect(policy.enabled).toBe(true);
  });

  it("allows paths inside allowlist when configured", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: ["src/**", "xbrief/**"],
    });
    expect(evaluateRuntimeAuthorityPath(policy, "src/index.ts")).toBe("allow");
    expect(evaluateRuntimeAuthorityPath(policy, "docs/readme.md")).toBe("deny-allowlist");
  });

  it("denyPaths win over allowPaths", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      allowPaths: ["**"],
      denyPaths: ["secrets/**"],
    });
    expect(evaluateRuntimeAuthorityPath(policy, "secrets/prod.env")).toBe("deny-denylist");
    expect(evaluateRuntimeAuthorityPath(policy, "src/a.ts")).toBe("allow");
  });

  it("skips evaluation when disabled", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: false,
      denyPaths: ["**"],
    });
    expect(evaluateRuntimeAuthorityPath(policy, "any/path")).toBe("allow");
    expect(
      evaluateRuntimeAuthorityDirectWrite({
        policy,
        relPathPosix: "blocked.ts",
      }).allowed,
    ).toBe(true);
  });

  it("denies direct writes when edits scope is off", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: false, push: false, merge: false },
    });
    const result = evaluateRuntimeAuthorityDirectWrite({
      policy,
      relPathPosix: "src/index.ts",
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("runtime-policy-deny-scope");
  });

  it("validates scopes shape", () => {
    expect(validateRuntimeAuthority({ scopes: "bad" })).toContain(
      "plan.policy.runtimeAuthority.scopes must be an object",
    );
    expect(validateRuntimeAuthority({ scopes: { edits: "yes" } })).toContain(
      "plan.policy.runtimeAuthority.scopes.edits must be a boolean",
    );
  });

  it("returns default field when runtimeAuthority key is absent", () => {
    const field = inspectRuntimeAuthority({ plan: { policy: {} } });
    expect(field.source).toBe("default");
  });

  it("resolves invalid raw to defaults", () => {
    expect(resolveRuntimeAuthorityPolicy("bad")).toEqual(DEFAULT_RUNTIME_AUTHORITY_POLICY);
  });
});
