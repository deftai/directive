import { describe, expect, it } from "vitest";
import { classifyHookAuthzOps, classifyShellAuthzOps, runtimeOpToAuthz } from "./classify.js";

describe("classifyShellAuthzOps (#2944)", () => {
  it("classifies push/merge via #2711 reuse", () => {
    expect(classifyShellAuthzOps("git push origin HEAD")).toContain("push");
    expect(classifyShellAuthzOps("gh pr merge 1 --squash")).toContain("merge");
  });

  it("classifies PR create/ready/edit without nested-quantifier regex", () => {
    expect(classifyShellAuthzOps("gh pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("gh pr ready 12")).toContain("pr");
    expect(classifyShellAuthzOps("gh.exe pr edit 3")).toContain("pr");
  });

  it("classifies issue create and test runners", () => {
    expect(classifyShellAuthzOps("gh issue create --title d")).toContain("issue_mutation");
    expect(classifyShellAuthzOps("pnpm test")).toContain("test");
    expect(classifyShellAuthzOps("vitest run")).toContain("test");
    expect(classifyShellAuthzOps("go test ./...")).toContain("test");
  });

  it("classifies settings and deploy heuristics", () => {
    expect(classifyShellAuthzOps("gh repo edit --visibility private")).toContain("settings");
    expect(classifyShellAuthzOps("terraform apply -auto-approve")).toContain("deployment");
    expect(classifyShellAuthzOps("fly deploy")).toContain("deployment");
  });

  it("returns empty for unclassifiable non-product shell", () => {
    expect(classifyShellAuthzOps("git status")).toEqual([]);
    expect(classifyShellAuthzOps("")).toEqual([]);
    expect(classifyShellAuthzOps("   ")).toEqual([]);
  });

  it("maps hook tools", () => {
    expect(
      classifyHookAuthzOps({
        toolName: "Write",
        shellCommand: null,
        isDirectWrite: true,
      }),
    ).toEqual(["edit"]);
    expect(
      classifyHookAuthzOps({
        toolName: "Bash",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual([]);
    expect(
      classifyHookAuthzOps({
        toolName: "Bash",
        shellCommand: "git push",
        isDirectWrite: false,
      }),
    ).toContain("push");
    expect(
      classifyHookAuthzOps({
        toolName: "create_pull_request",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["pr"]);
    expect(
      classifyHookAuthzOps({
        toolName: "create_issue",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["issue_mutation"]);
    expect(
      classifyHookAuthzOps({
        toolName: "Read",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual([]);
  });

  it("runtimeOpToAuthz is identity for push/merge", () => {
    expect(runtimeOpToAuthz("push")).toBe("push");
    expect(runtimeOpToAuthz("merge")).toBe("merge");
  });
});
