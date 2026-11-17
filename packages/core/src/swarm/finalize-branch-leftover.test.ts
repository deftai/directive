import { describe, expect, it } from "vitest";
import { describeFinalizeBranchLeftover, finalizeBranchSetupError } from "./finalize-cohort.js";
import type { TextCaptureResult } from "./subprocess.js";

const BRANCH = "swarm/finalize/pr-6421";
const ROOT = "C:/repo";
const HOLDER = "C:/Temp/deft-finalize-lifecycle-abc/checkout";

interface FakeGitOptions {
  readonly localBranch?: boolean;
  readonly remoteHead?: boolean;
  readonly lsRemoteFails?: boolean;
  readonly porcelain?: string;
}

function fakeGit(opts: FakeGitOptions): {
  readonly calls: string[];
  readonly run: (command: readonly string[], options?: { cwd?: string }) => TextCaptureResult;
} {
  const calls: string[] = [];
  const run = (command: readonly string[], options?: { cwd?: string }): TextCaptureResult => {
    calls.push(`${options?.cwd ?? ""}|${command.join(" ")}`);
    if (command[1] === "rev-parse") {
      return opts.localBranch === true
        ? { returncode: 0, stdout: "abc123\n", stderr: "" }
        : { returncode: 1, stdout: "", stderr: "" };
    }
    if (command[1] === "ls-remote") {
      if (opts.lsRemoteFails === true) {
        return { returncode: 128, stdout: "", stderr: "could not read from remote" };
      }
      return {
        returncode: 0,
        stdout: opts.remoteHead === true ? `def456\trefs/heads/${BRANCH}\n` : "",
        stderr: "",
      };
    }
    if (command[1] === "worktree" && command[2] === "list") {
      return { returncode: 0, stdout: opts.porcelain ?? "", stderr: "" };
    }
    return { returncode: 99, stdout: "", stderr: "unexpected command" };
  };
  return { calls, run };
}

/** Main worktree first, then a linked worktree at `holder` on the finalize branch. */
function porcelainWith(holder: string): string {
  return [
    `worktree ${ROOT}`,
    "HEAD 1111111",
    "branch refs/heads/master",
    "",
    `worktree ${holder}`,
    "HEAD 2222222",
    `branch refs/heads/${BRANCH}`,
    "",
  ].join("\n");
}

describe("describeFinalizeBranchLeftover (#6421)", () => {
  it("names the leftover branch and worktree and prints the removal commands", () => {
    const git = fakeGit({ localBranch: true, porcelain: porcelainWith(HOLDER) });
    const text = describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(text).not.toBeNull();
    expect(text).toContain(`local branch ${BRANCH}`);
    expect(text).toContain(`checked out in worktree ${HOLDER}`);
    expect(text).toContain("If no other finalize run for this cohort is still running");
    expect(text).toContain(
      `git -C '${ROOT}' worktree remove --force '${HOLDER}' && git -C '${ROOT}' branch -D '${BRANCH}'`,
    );
    expect(text).not.toContain("\n");
  });

  it("never prints a repo-wide worktree prune (the holder folder may be gone)", () => {
    const git = fakeGit({ localBranch: true, porcelain: porcelainWith(HOLDER) });
    const text = describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(text).not.toContain("worktree prune");
  });

  it("keeps porcelain path bytes, including a trailing space", () => {
    const spaced = "C:/Temp/odd dir/checkout ";
    const git = fakeGit({ localBranch: true, porcelain: porcelainWith(spaced) });
    const text = describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(text).toContain(`worktree remove --force '${spaced}'`);
  });

  it("single-quotes paths so $, backticks and double quotes stay literal", () => {
    const root = "/work/$project/`x`";
    const holder = `/tmp/it's "here"`;
    const git = fakeGit({ localBranch: true, porcelain: porcelainWith(holder) });
    const text = describeFinalizeBranchLeftover(root, BRANCH, git.run);
    expect(text).toContain("git -C '/work/$project/`x`' worktree remove --force");
    expect(text).toContain(`'/tmp/it'\\''s "here"'`);
  });

  it("moves the main worktree off the branch instead of removing it", () => {
    const porcelain = [`worktree ${ROOT}`, "HEAD 1111111", `branch refs/heads/${BRANCH}`, ""].join(
      "\n",
    );
    const git = fakeGit({ localBranch: true, porcelain });
    const text = describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(text).toContain(`git -C '${ROOT}' switch --detach && git -C '${ROOT}' branch -D`);
    expect(text).not.toContain("worktree remove");
  });

  it("prints only the branch command when no worktree holds the branch", () => {
    const git = fakeGit({
      localBranch: true,
      porcelain: `worktree ${ROOT}\nHEAD 1\nbranch refs/heads/master\n`,
    });
    const text = describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(text).toContain(`then re-run: git -C '${ROOT}' branch -D '${BRANCH}'`);
    expect(text).not.toContain("checked out in worktree");
    expect(text).not.toContain("worktree remove");
  });

  it("keeps today's text when origin has the branch, even without a local tracking ref", () => {
    const git = fakeGit({ localBranch: true, remoteHead: true, porcelain: porcelainWith(HOLDER) });
    expect(describeFinalizeBranchLeftover(ROOT, BRANCH, git.run)).toBeNull();
    expect(git.calls.some((c) => c.includes(`ls-remote --heads origin refs/heads/${BRANCH}`))).toBe(
      true,
    );
  });

  it("keeps today's text when origin cannot be read", () => {
    const git = fakeGit({
      localBranch: true,
      lsRemoteFails: true,
      porcelain: porcelainWith(HOLDER),
    });
    expect(describeFinalizeBranchLeftover(ROOT, BRANCH, git.run)).toBeNull();
  });

  it("keeps today's text when there is no local branch", () => {
    const git = fakeGit({ localBranch: false });
    expect(describeFinalizeBranchLeftover(ROOT, BRANCH, git.run)).toBeNull();
    expect(git.calls).toHaveLength(1);
  });

  it("runs only read-only git commands in the project root", () => {
    const git = fakeGit({ localBranch: true, porcelain: porcelainWith(HOLDER) });
    describeFinalizeBranchLeftover(ROOT, BRANCH, git.run);
    expect(git.calls).toEqual([
      `${ROOT}|git rev-parse --verify --quiet refs/heads/${BRANCH}`,
      `${ROOT}|git ls-remote --heads origin refs/heads/${BRANCH}`,
      `${ROOT}|git worktree list --porcelain`,
    ]);
  });
});

describe("finalizeBranchSetupError (#6421)", () => {
  const SWITCH_ERROR = `git switch -c ${BRANCH} failed: fatal: a branch named '${BRANCH}' already exists`;

  it("appends the leftover report when branch creation failed", () => {
    const git = fakeGit({ localBranch: true, porcelain: "" });
    const text = finalizeBranchSetupError(
      ROOT,
      BRANCH,
      { error: SWITCH_ERROR, createFailed: true },
      git.run,
    );
    expect(text.startsWith(`${SWITCH_ERROR} Leftover of a finalize run`)).toBe(true);
    expect(text).toContain(`branch -D '${BRANCH}'`);
  });

  it("returns today's text when the branch is on origin", () => {
    const git = fakeGit({ localBranch: true, remoteHead: true });
    expect(
      finalizeBranchSetupError(ROOT, BRANCH, { error: SWITCH_ERROR, createFailed: true }, git.run),
    ).toBe(SWITCH_ERROR);
  });

  it("leaves other branch-setup errors unchanged and runs no git command", () => {
    const git = fakeGit({ localBranch: true });
    expect(
      finalizeBranchSetupError(ROOT, BRANCH, { error: "branch policy config error" }, git.run),
    ).toBe("branch policy config error");
    expect(finalizeBranchSetupError(ROOT, BRANCH, { error: null }, git.run)).toBe(
      "branch setup failed",
    );
    expect(git.calls).toEqual([]);
  });
});
