import { describe, expect, it } from "vitest";
import {
  classifyMcpTool,
  classifyShellCommand,
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityPath,
  evaluateRuntimeAuthorityShellOp,
  inspectRuntimeAuthority,
  listShellOps,
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
    // Quoted / fragmented tokens: shell strips quotes and concatenates (#2711).
    expect(classifyShellCommand("git 'push' origin HEAD")).toBe("push");
    expect(classifyShellCommand('git "push" --force-with-lease')).toBe("push");
    expect(classifyShellCommand("gh pr 'merge' 12")).toBe("merge");
    expect(classifyShellCommand(`'git' push origin HEAD`)).toBe("push");
    expect(classifyShellCommand("g''it push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git p''ush origin HEAD")).toBe("push");
    expect(classifyShellCommand("gh pr m''erge 12")).toBe("merge");
    expect(classifyShellCommand("g\\it push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git p\\ush origin HEAD")).toBe("push");
    expect(classifyShellCommand("git --git-dir /repo push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git --git-dir=/repo push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git --work-tree /wt -C /repo push")).toBe("push");
    // Compound / multi-line: list every op so enforcement can deny any out-of-scope step.
    expect(listShellOps("gh pr merge 1 --squash && git push")).toEqual(["push", "merge"]);
    expect(listShellOps("ls\ngit push origin HEAD")).toEqual(["push"]);
    expect(listShellOps("git status && echo ok")).toEqual([]);
    // Quoted / escaped separators must not invent executable segments (false-deny).
    expect(listShellOps("printf '%s' ';' 'git push'")).toEqual([]);
    expect(classifyShellCommand("printf '%s' ';' 'git push'")).toBeNull();
    expect(listShellOps("printf '%s\\n' hello\\; git push")).toEqual([]);
  });

  it("classifies MCP merge/push tool names", () => {
    expect(classifyMcpTool("mcp__github__merge_pull_request")).toBe("merge");
    expect(classifyMcpTool("merge_pull_request")).toBe("merge");
    expect(classifyMcpTool("mcp__git__git_push")).toBe("push");
    expect(classifyMcpTool("server__push_to_remote")).toBe("push");
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
    // Disabled policy with null op still reports unclassifiable for callers.
    expect(evaluateRuntimeAuthorityShellOp({ policy: disabled, op: null }).unclassifiable).toBe(
      true,
    );
  });

  it("covers shell classify edge branches (wrappers, ||, glued opts, gh flags) (#2952)", () => {
    // sudo / env / command wrappers + further env assigns after the wrapper.
    expect(classifyShellCommand("sudo git push origin HEAD")).toBe("push");
    expect(classifyShellCommand("env FOO=1 git push")).toBe("push");
    expect(classifyShellCommand("command gh pr merge 9")).toBe("merge");
    // || pipeline separator (&& already covered).
    expect(classifyShellCommand("false || git push origin HEAD")).toBe("push");
    expect(listShellOps("false || gh pr merge 1")).toEqual(["merge"]);
    // Git global value opts and glued short forms.
    expect(classifyShellCommand("git -c user.name=x push")).toBe("push");
    expect(classifyShellCommand("git --namespace=ns push")).toBe("push");
    expect(classifyShellCommand("git -C/repo push origin HEAD")).toBe("push");
    expect(classifyShellCommand("git -cname=value push")).toBe("push");
    expect(classifyShellCommand("git --bare push")).toBe("push");
    // git with only global flags (no subcommand) fails open.
    expect(classifyShellCommand("git -C /repo --bare")).toBeNull();
    // gh boolean / equals-form flags before the pr verb (value-taking spaced flags stay fail-open).
    expect(classifyShellCommand("gh --repo=o/r pr merge 3")).toBe("merge");
    expect(classifyShellCommand("gh --json pr merge 3")).toBe("merge");
    expect(classifyShellCommand("gh -R o/r pr merge 3")).toBeNull();
    expect(classifyShellCommand("gh pr view 3")).toBeNull();
    // Env-assign false positive: token without valid name rejects env skip path.
    expect(classifyShellCommand("1=bad git push")).toBeNull();
    // Carriage-return as segment delimiter.
    expect(listShellOps("ls\rgit push origin HEAD")).toEqual(["push"]);
  });

  it("covers MCP classify edge patterns and args-blob paths (#2952)", () => {
    expect(classifyMcpTool("")).toBeNull();
    expect(classifyMcpTool("   ")).toBeNull();
    expect(classifyMcpTool("pull_request_merge")).toBe("merge");
    expect(classifyMcpTool("host__merge_pr__extra")).toBe("merge");
    expect(classifyMcpTool("tools_pr-merge")).toBe("merge");
    expect(classifyMcpTool("push_branch")).toBe("push");
    expect(classifyMcpTool("push-branch")).toBe("push");
    // push + (git|branch|remote|ref) conjunction.
    expect(classifyMcpTool("remote_push_refs")).toBe("push");
    // Args blob: only consulted when the tool name itself is not a known op.
    expect(classifyMcpTool("run_shell", "git push origin main")).toBe("push");
    expect(classifyMcpTool("run_shell", "gh pr merge 12 --squash")).toBe("merge");
    expect(classifyMcpTool("run_shell", "git.exe push --force")).toBe("push");
    expect(classifyMcpTool("run_shell", "gh.exe pr merge 1")).toBe("merge");
    expect(classifyMcpTool("run_shell", null)).toBeNull();
    expect(classifyMcpTool("run_shell", "")).toBeNull();
  });

  it("covers quote-aware segment split and evaluate allow-all path (#2952)", () => {
    // Double-quoted separators must not invent segments.
    expect(listShellOps('echo "git push" && true')).toEqual([]);
    expect(listShellOps("git push origin HEAD | cat")).toEqual(["push"]);
    expect(listShellOps("git push ; gh pr merge 1")).toEqual(["push", "merge"]);
    // Both scopes granted evaluates to allow (unclassifiable false).
    const full = resolveRuntimeAuthorityPolicy({
      enabled: true,
      scopes: { edits: true, push: true, merge: true },
    });
    const allowPush = evaluateRuntimeAuthorityShellOp({ policy: full, op: "push" });
    expect(allowPush).toMatchObject({
      allowed: true,
      code: null,
      unclassifiable: false,
    });
    const allowMerge = evaluateRuntimeAuthorityShellOp({ policy: full, op: "merge" });
    expect(allowMerge.allowed).toBe(true);
    // git --work-tree=/wt form (equals, not separate value token).
    expect(classifyShellCommand("git --work-tree=/wt push")).toBe("push");
    expect(classifyShellCommand("git --namespace ns push")).toBe("push");
    // Only one wrapper layer is consumed (sudo|env|command); chained wrappers stay fail-open.
    expect(classifyShellCommand("sudo env FOO=1 command git push")).toBeNull();
    expect(classifyShellCommand("sudo FOO=1 git push")).toBe("push");
  });
});

describe("shellDestForms (#3438 / #3594)", () => {
  it("defaults to off so landing the dest-form gate denies nothing", () => {
    expect(DEFAULT_RUNTIME_AUTHORITY_POLICY.shellDestForms).toBe("off");
    expect(resolveRuntimeAuthorityPolicy(null).shellDestForms).toBe("off");
    expect(resolveRuntimeAuthorityPolicy({}).shellDestForms).toBe("off");
    expect(resolveRuntimeAuthorityPolicy({ enabled: true }).shellDestForms).toBe("off");
  });

  it("reads enforce, and is independent of enabled in both directions", () => {
    expect(resolveRuntimeAuthorityPolicy({ shellDestForms: "enforce" }).shellDestForms).toBe(
      "enforce",
    );
    // Opting into the dest-form gate does not require the grant ladder, and
    // enabling the ladder does not silently opt into the gate.
    expect(
      resolveRuntimeAuthorityPolicy({ enabled: false, shellDestForms: "enforce" }).shellDestForms,
    ).toBe("enforce");
    expect(resolveRuntimeAuthorityPolicy({ enabled: true }).shellDestForms).toBe("off");
  });

  it("resolves an unknown value to off but reports it rather than failing silently", () => {
    // A typo must not read as enforcement, and must not be invisible either.
    for (const bad of ["warn", "ENFORCE", "on", true, 1, null]) {
      expect(resolveRuntimeAuthorityPolicy({ shellDestForms: bad }).shellDestForms).toBe("off");
    }
    expect(validateRuntimeAuthority({ shellDestForms: "warn" })).toEqual([
      "plan.policy.runtimeAuthority.shellDestForms must be one of off | enforce",
    ]);
    expect(validateRuntimeAuthority({ shellDestForms: "off" })).toEqual([]);
    expect(validateRuntimeAuthority({ shellDestForms: "enforce" })).toEqual([]);
  });
});
