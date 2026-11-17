import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import type { GitRunner } from "../session/git.js";
import {
  createMergeGateSignal,
  MERGE_GATE_SIGNAL_READ_BUDGET_SECONDS,
  mergeGateWarningLine,
  readMergeGateContext,
  withMergeGateWarnings,
} from "./merge-gate-signal.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function definition(policy: Record<string, unknown>): Record<string, unknown> {
  return { xBRIEFInfo: { version: "0.8" }, plan: { policy } };
}

function project(policy: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-signal-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  if (policy !== null) {
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(definition(policy)),
      "utf8",
    );
  }
  return root;
}

const LOCAL_POLICY = { mergeGateContext: "Merge gate", deliveryBranch: "master" };

interface GhStubOptions {
  /** Policy of the project definition at the GitHub delivery-branch head. */
  readonly remotePolicy?: Record<string, unknown>;
  readonly contentsFails?: boolean;
  readonly required?: readonly string[];
  readonly rulesFails?: boolean;
}

function ghStub(options: GhStubOptions = {}): { run: RunGhFn; calls: string[] } {
  const calls: string[] = [];
  const run: RunGhFn = (cmd) => {
    const path = cmd[2] ?? "";
    calls.push(path);
    if (path.includes("/contents/")) {
      if (options.contentsFails === true) {
        return { returncode: 1, stdout: "", stderr: "HTTP 500" };
      }
      const body = definition(options.remotePolicy ?? LOCAL_POLICY);
      return {
        returncode: 0,
        stdout: JSON.stringify({
          encoding: "base64",
          content: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
        }),
        stderr: "",
      };
    }
    if (path.includes("/rules/branches/")) {
      if (options.rulesFails === true) return { returncode: 1, stdout: "", stderr: "HTTP 500" };
      const rules = [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: (options.required ?? ["Merge gate"]).map((context) => ({
              context,
            })),
          },
        },
      ];
      return { returncode: 0, stdout: JSON.stringify(rules), stderr: "" };
    }
    // Classic branch protection: no such source.
    return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
  };
  return { run, calls };
}

function gitStub(remote = "https://github.com/o/r.git"): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = (_root, args) => {
    calls.push([...args]);
    if (args[0] === "remote") return { code: 0, stdout: remote, stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("readMergeGateContext (#6535)", () => {
  it("reads a trimmed non-empty string and nothing else", () => {
    expect(readMergeGateContext(definition({ mergeGateContext: "  Merge gate " }))).toBe(
      "Merge gate",
    );
    expect(readMergeGateContext(definition({ mergeGateContext: "" }))).toBeNull();
    expect(readMergeGateContext(definition({ mergeGateContext: "   " }))).toBeNull();
    expect(readMergeGateContext(definition({ mergeGateContext: 3 }))).toBeNull();
    expect(readMergeGateContext(definition({}))).toBeNull();
    expect(readMergeGateContext({ plan: { policy: "nope" } })).toBeNull();
    expect(readMergeGateContext({ plan: "nope" })).toBeNull();
    expect(readMergeGateContext(null)).toBeNull();
  });
});

describe("merge-gate signal (#6535)", () => {
  it("owns one named read budget constant", () => {
    expect(MERGE_GATE_SIGNAL_READ_BUDGET_SECONDS).toBe(10);
  });

  it("is off and makes no GitHub call when the worktree copy names no check", () => {
    const gh = ghStub();
    const git = gitStub();
    for (const root of [project(null), project({ deliveryBranch: "master" })]) {
      const result = createMergeGateSignal({ root, runGit: git.run, runGh: gh.run }).evaluate();
      expect(result).toEqual({ live: false, check: null, branch: null });
    }
    expect(gh.calls).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it("is live when GitHub names the same check and lists it as required", () => {
    const root = project(LOCAL_POLICY);
    const gh = ghStub();
    const signal = createMergeGateSignal({ root, runGit: gitStub().run, runGh: gh.run });
    expect(signal.evaluate()).toEqual({ live: true, check: "Merge gate", branch: "master" });
    expect(gh.calls[0]).toBe("repos/o/r/contents/xbrief/PROJECT-DEFINITION.xbrief.json?ref=master");
    expect(gh.calls.some((call) => call.includes("/rules/branches/master"))).toBe(true);
    // Memoized for the rest of the hook call.
    const seen = gh.calls.length;
    expect(signal.evaluate().live).toBe(true);
    expect(gh.calls).toHaveLength(seen);
  });

  it("is off, with no required-context call, when GitHub's copy names none or another check", () => {
    for (const remotePolicy of [{ deliveryBranch: "master" }, { mergeGateContext: "Other" }]) {
      const gh = ghStub({ remotePolicy });
      const result = createMergeGateSignal({
        root: project(LOCAL_POLICY),
        runGit: gitStub().run,
        runGh: gh.run,
      }).evaluate();
      expect(result.live).toBe(false);
      expect(gh.calls).toHaveLength(1);
      expect(gh.calls[0]).toContain("/contents/");
    }
  });

  it("never reads a local ref as authority for the name", () => {
    const git = gitStub();
    const gh = ghStub({ remotePolicy: { deliveryBranch: "master" } });
    const result = createMergeGateSignal({
      root: project(LOCAL_POLICY),
      runGit: git.run,
      runGh: gh.run,
    }).evaluate();
    expect(result.live).toBe(false);
    // Only the remote URL is read from git; no ref, blob or object read decides the name.
    expect(git.calls.every((args) => args[0] === "remote")).toBe(true);
  });

  it("is off when the named check is not in the live required contexts", () => {
    const result = createMergeGateSignal({
      root: project(LOCAL_POLICY),
      runGit: gitStub().run,
      runGh: ghStub({ required: ["Other check"] }).run,
    }).evaluate();
    expect(result.live).toBe(false);
  });

  it("is off when a read fails, times out or the repository cannot be named", () => {
    const root = project(LOCAL_POLICY);
    const failing: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh read budget exhausted",
    });
    for (const gh of [
      failing,
      ghStub({ contentsFails: true }).run,
      ghStub({ rulesFails: true }).run,
    ]) {
      expect(
        createMergeGateSignal({ root, runGit: gitStub().run, runGh: gh }).evaluate().live,
      ).toBe(false);
    }
    const noRemote = createMergeGateSignal({
      root,
      runGit: () => ({ code: 128, stdout: "", stderr: "no remote" }),
      runGh: ghStub().run,
    });
    expect(noRemote.evaluate().live).toBe(false);
    const notGitHub = createMergeGateSignal({
      root,
      runGit: gitStub("https://example.com/o/r.git").run,
      runGh: ghStub().run,
    });
    expect(notGitHub.evaluate().live).toBe(false);
  });

  it("is off on an unreadable contents payload", () => {
    const root = project(LOCAL_POLICY);
    for (const stdout of ["not json", "[]", JSON.stringify({ encoding: "none", content: "" })]) {
      const gh: RunGhFn = () => ({ returncode: 0, stdout, stderr: "" });
      expect(
        createMergeGateSignal({ root, runGit: gitStub().run, runGh: gh }).evaluate().live,
      ).toBe(false);
    }
    const badInner: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        encoding: "base64",
        content: Buffer.from("[1]", "utf8").toString("base64"),
      }),
      stderr: "",
    });
    expect(
      createMergeGateSignal({ root, runGit: gitStub().run, runGh: badInner }).evaluate().live,
    ).toBe(false);
  });

  it("records nothing under .deft/", () => {
    const root = project(LOCAL_POLICY);
    createMergeGateSignal({ root, runGit: gitStub().run, runGh: ghStub().run }).evaluate();
    expect(existsSync(join(root, ".deft"))).toBe(false);
  });
});

describe("merge-gate warning text (#6535)", () => {
  const live = { live: true, check: "Merge gate", branch: "master" } as const;

  it("gives today's refusal text plus one advisory clause that claims no equivalence", () => {
    const line = mergeGateWarningLine("Directive denied Write: ritual stale. ", live);
    expect(line).toContain("Directive denied Write: ritual stale.");
    expect(line).toContain("Local enforcement is advisory here: Merge gate is required on master.");
    expect(line).not.toMatch(/enforces the same/i);
  });

  it("starts with Warning: and leaves a message with no warnings unchanged", () => {
    expect(withMergeGateWarnings("allowed.", [])).toBe("allowed.");
    expect(withMergeGateWarnings("allowed.", ["a", "b"])).toBe("Warning: a b allowed.");
  });
});
