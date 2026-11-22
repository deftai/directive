import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMMIT_TARGET_ACCEPTED_FORMS, resolveCommitTarget } from "./commit-target.js";
import { decideHook, type HookDecision, type HookPolicySeams } from "./dispatcher.js";

// End to end: the commit gate in the real dispatcher denies a commit after a
// background `&`, inside a subshell or a `-c` string, behind a wrapper, and a
// non-literal `-c` / `eval` string, before it reads any index (#6362).

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

function seams(listStagedRelPaths: (root: string) => string[]): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    loadStoryWriteFence: () => ({ fileScope: ["src/**"], denyPaths: [] }),
    listStagedRelPaths,
  };
}

function decideBash(command: string, listStagedRelPaths: (root: string) => string[]): HookDecision {
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: "/project",
      payload: { tool_name: "Bash", tool_input: { command } },
    },
    seams(listStagedRelPaths),
  );
}

function expectUnresolvableDeny(decision: HookDecision, command: string): void {
  expect(decision, command).toMatchObject({
    verdict: "deny",
    code: "prospective-scope-cover-deny",
  });
  expect(decision.message, command).toMatch(/cannot be resolved to one checkout/);
  expect(decision.message, command).toContain(COMMIT_TARGET_ACCEPTED_FORMS);
}

describe("the commit gate denies commit signals outside the named shapes (#6362 clause 4)", () => {
  it.each([
    "cd /x & git commit -m x",
    "(cd /x && git commit -m x)",
    "cd /y && (cd /x && git commit -m x)",
    "bash -c 'git commit -m x'",
    'sh -c "$CMD commit"',
    "cd /y && bash -c 'git commit -m x'",
  ])("denies %j before reading any index", (command) => {
    // The hook root has nothing staged, so a hook-root reading would have admitted it.
    const listStagedRelPaths = vi.fn((_root: string): string[] => []);
    expectUnresolvableDeny(decideBash(command, listStagedRelPaths), command);
    expect(listStagedRelPaths).not.toHaveBeenCalled();
  });

  it.each([
    "declare -A M; M[$k]=v; echo ok",
    "$D verify:x",
    '$env:X="1"; deft foo',
    'bash -c "deft foo $X"',
  ])("returns no commit decision for %j, which shows no commit word (#6871)", (command) => {
    const listStagedRelPaths = vi.fn((_root: string): string[] => []);
    const decision = decideBash(command, listStagedRelPaths);
    expect(decision.code, command).not.toBe("prospective-scope-cover-deny");
    expect(decision.message ?? "", command).not.toMatch(/cannot be resolved to one checkout/);
    expect(listStagedRelPaths).not.toHaveBeenCalled();
  });

  it("denies the signal in both orders around a visible commit", () => {
    for (const command of [
      'sh -c "$CMD" && git commit -m x',
      'git commit -m x && sh -c "$CMD"',
      'eval "$X"; git -C /x commit -m x',
      'git -C /x commit -m x; eval "$X"',
    ]) {
      const listStagedRelPaths = vi.fn((_root: string): string[] => ["src/a.ts"]);
      expectUnresolvableDeny(decideBash(command, listStagedRelPaths), command);
      expect(listStagedRelPaths).not.toHaveBeenCalled();
    }
  });

  it("denies wrappers, unreadable command words and a nested -a commit", () => {
    for (const command of [
      "env git commit -m x",
      "timeout 60 git commit -m x",
      "xargs git commit -m x",
      "G=git; $G commit -m x",
      "git $SUB -m x",
      "(cd /x && git commit -am x)",
      "bash -c 'git commit -m x -- src/a.ts'",
    ]) {
      const listStagedRelPaths = vi.fn((_root: string): string[] => ["src/a.ts"]);
      const decision = decideBash(command, listStagedRelPaths);
      expectUnresolvableDeny(decision, command);
      expect(decision.message, command).not.toMatch(/-a\/--all\/-am/);
    }
  });

  it("keeps a closed subshell cd from moving a later commit (control)", () => {
    const command = "(cd /r/wt) && git commit -m x";
    expect(resolveCommitTarget(command)).toEqual({ kind: "hook-root" });
    const listStagedRelPaths = vi.fn((_root: string): string[] => ["src/a.ts"]);
    const decision = decideBash(command, listStagedRelPaths);
    expect(decision.verdict).toBe("allow");
    expect(listStagedRelPaths).toHaveBeenCalledWith(resolve("/project"));
  });

  it("still judges a hook-root commit against the hook root's index (control)", () => {
    const outside = decideBash("git commit -m x &", () => ["docs/out.md"]);
    expect(outside).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(outside.message).toMatch(/docs\/out\.md/);
    const inside = decideBash("git commit -m msg 2>&1 | tail -3", () => ["src/a.ts"]);
    expect(inside.verdict).toBe("allow");
  });

  it("does not treat commands that cannot commit as commits (control)", () => {
    for (const command of [
      "bash -lc 'npm test'",
      "nohup node server.js &",
      "echo 'git commit' && echo \"(x)\"",
      "cat <<'EOF'\n(cd /x && git commit -m x)\nEOF",
    ]) {
      const decision = decideBash(command, () => ["docs/out.md"]);
      expect(decision.code, command).not.toBe("prospective-scope-cover-deny");
    }
  });
});
