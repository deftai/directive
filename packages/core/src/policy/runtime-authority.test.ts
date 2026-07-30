import { describe, expect, it } from "vitest";
import {
  classifyMcpTool,
  classifyShellCommand,
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  evaluateRuntimeAuthorityShellOp,
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

describe("runtimeAuthority shell/MCP push/merge (#2711)", () => {
  it("classifies git push and gh pr merge shell commands", () => {
    expect(classifyShellCommand("git push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git.exe push --force-with-lease")).toBe("push");
    expect(classifyShellCommand("cd pkg && git push")).toBe("push");
    expect(classifyShellCommand("git -C /project push origin HEAD")).toBe("push");
    expect(classifyShellCommand("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1 git push")).toBe("push");
    expect(classifyShellCommand("FOO=1 BAR=2 git -C repo push")).toBe("push");
    expect(classifyShellCommand("gh pr merge 12 --squash")).toBe("merge");
    expect(classifyShellCommand("gh.exe pr merge 12")).toBe("merge");
    expect(classifyShellCommand("git status")).toBeNull();
    expect(classifyShellCommand("echo git push is cool")).toBeNull();
    expect(classifyShellCommand("")).toBeNull();
  });

  it("classifies MCP merge/push tool names", () => {
    expect(classifyMcpTool("mcp__github__merge_pull_request")).toBe("merge");
    expect(classifyMcpTool("merge_pull_request")).toBe("merge");
    expect(classifyMcpTool("mcp__git__git_push")).toBe("push");
    expect(classifyMcpTool("list_issues")).toBeNull();
    expect(classifyMcpTool("mcp__github__create_issue", '{"title":"x"}')).toBeNull();
  });

  it("denies push when scopes.push is false and enabled", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: true, push: false, merge: true },
    });
    const denied = evaluateRuntimeAuthorityShellOp({ policy, op: "push" });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("runtime-policy-deny-scope");
    expect(denied.reason).toMatch(/scopes\.push is false/);
  });

  it("denies merge when scopes.merge is false and enabled", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: true, push: true, merge: false },
    });
    const denied = evaluateRuntimeAuthorityShellOp({ policy, op: "merge" });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("runtime-policy-deny-scope");
  });

  it("allows push/merge when scopes grant them", () => {
    const policy = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: true, push: true, merge: true },
    });
    expect(evaluateRuntimeAuthorityShellOp({ policy, op: "push" }).allowed).toBe(true);
    expect(evaluateRuntimeAuthorityShellOp({ policy, op: "merge" }).allowed).toBe(true);
  });

  it("fails open when unclassifiable or policy disabled", () => {
    const enabled = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: true, push: false, merge: false },
    });
    const open = evaluateRuntimeAuthorityShellOp({ policy: enabled, op: null });
    expect(open.allowed).toBe(true);
    expect(open.unclassifiable).toBe(true);

    const disabled = resolveRuntimeAuthorityPolicy({
      enabled: false,
      scopes: { edits: true, push: false, merge: false },
    });
    expect(evaluateRuntimeAuthorityShellOp({ policy: disabled, op: "push" }).allowed).toBe(true);
  });
});
