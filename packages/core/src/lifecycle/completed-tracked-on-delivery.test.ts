import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateCompletedTracked, resolveDeliveryTip } from "./completed-tracked-on-delivery.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-completed-tracked-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  // Default branch name varies by git config; pin master for fixtures.
  git(root, ["checkout", "-q", "-b", "master"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function writeBrief(
  root: string,
  folder: string,
  name: string,
  plan: Record<string, unknown>,
): string {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan,
    }),
    "utf8",
  );
  return path;
}

function writeCachedIssue(
  root: string,
  repo: string,
  number: number,
  state: "open" | "closed",
): void {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`invalid repo slug: ${repo}`);
  }
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number, state }), "utf8");
}

const issuePlan = (number: number): Record<string, unknown> => ({
  status: "completed",
  title: `story ${number}`,
  references: [
    {
      uri: `https://github.com/deftai/directive/issues/${number}`,
      type: "x-xbrief/github-issue",
    },
  ],
});

describe("resolveDeliveryTip", () => {
  it("uses explicit tip when present", () => {
    const root = makeGitRepo();
    const { tip, error } = resolveDeliveryTip(root, "HEAD", (cwd, args) => {
      try {
        const stdout = execFileSync("git", [...args], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout: String(stdout).trimEnd(), stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "fail" };
      }
    });
    expect(error).toBeNull();
    expect(tip).toBe("HEAD");
  });

  // #3478 review: the gate proves an artifact landed on the delivery tip, not on
  // feature-worktree HEAD. When neither origin/<branch> nor <branch> resolves
  // (shallow clone, unfetched worktree, fetch-depth:1 checkout), falling back to
  // HEAD would check the very branch whose land is in question and pass.
  it("fails closed instead of falling back to HEAD when the delivery ref is absent", () => {
    const root = makeGitRepo();
    // Detach onto a feature-shaped ref so neither origin/master nor master resolve.
    git(root, ["checkout", "-q", "-b", "feature/land-in-flight"]);
    git(root, ["branch", "-q", "-D", "master"]);
    const { tip, error } = resolveDeliveryTip(root, null, (cwd, args) => {
      try {
        const stdout = execFileSync("git", [...args], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout: String(stdout).trimEnd(), stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "fail" };
      }
    });
    expect(tip).toBeNull();
    expect(error).toContain("could not resolve delivery tip");
    expect(error).toContain("--tip");
  });
});

describe("evaluateCompletedTracked (#3264)", () => {
  it("fails when closed scoped issue has untracked completed residue only", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "missing-land.xbrief.json", issuePlan(9001));
    writeCachedIssue(root, "deftai/directive", 9001, "closed");
    // Do NOT git-add the completed brief — untracked laptop residue.
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.issue.number).toBe(9001);
    expect(result.message).toContain("task swarm:finalize-cohort");
    expect(result.message).toContain("lifecycle PR");
    expect(result.message).toContain("9001");
  });

  it("is green when tracked completed on delivery tip references the closed issue", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "landed.xbrief.json", issuePlan(9002));
    writeCachedIssue(root, "deftai/directive", 9002, "closed");
    git(root, ["add", "xbrief/completed/landed.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "land completed"]);
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.message).toContain("tracked completed/cancelled");
  });

  it("does not false-positive for closed issues with no scope xBRIEF origin", () => {
    const root = makeGitRepo();
    writeCachedIssue(root, "deftai/directive", 9003, "closed");
    // No lifecycle xBRIEF references 9003.
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
  });

  it("does not fail open scoped issues still in active/", () => {
    const root = makeGitRepo();
    writeBrief(root, "active", "open-story.xbrief.json", {
      ...issuePlan(9004),
      status: "running",
    });
    writeCachedIssue(root, "deftai/directive", 9004, "open");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
  });

  it("fails when tip still has active brief for a closed issue and no terminal land", () => {
    const root = makeGitRepo();
    writeBrief(root, "active", "stale-active.xbrief.json", {
      ...issuePlan(9005),
      status: "running",
    });
    writeCachedIssue(root, "deftai/directive", 9005, "closed");
    git(root, ["add", "xbrief/active/stale-active.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "active only"]);
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9005);
  });

  it("accepts tracked cancelled as land", () => {
    const root = makeGitRepo();
    writeBrief(root, "cancelled", "abandoned.xbrief.json", {
      ...issuePlan(9006),
      status: "cancelled",
    });
    writeCachedIssue(root, "deftai/directive", 9006, "closed");
    git(root, ["add", "xbrief/cancelled/abandoned.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "cancel land"]);
    // Local completed untracked residue should not fail once tip has cancelled.
    writeBrief(root, "completed", "dup.xbrief.json", issuePlan(9006));
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
  });

  it("returns config error when tip override is missing", () => {
    const root = makeGitRepo();
    const result = evaluateCompletedTracked(root, {
      tip: "refs/does-not-exist",
      skipGh: true,
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("delivery tip ref not found");
  });

  it("soft-skips non-git roots (greenfield consumer fixtures)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-completed-tracked-nongit-"));
    temps.push(root);
    const result = evaluateCompletedTracked(root, { skipGh: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain("not a git worktree");
    expect(result.message).toContain("skip");
  });

  it("returns config error when project root path is missing", () => {
    const result = evaluateCompletedTracked(
      join(tmpdir(), "deft-completed-tracked-missing-root-xyz"),
      { skipGh: true },
    );
    expect(result.code).toBe(2);
    expect(result.message).toContain("project root does not exist");
  });

  it("quiet mode suppresses pass and fail message bodies", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "quiet-miss.xbrief.json", issuePlan(9010));
    writeCachedIssue(root, "deftai/directive", 9010, "closed");
    const miss = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      quiet: true,
    });
    expect(miss.code).toBe(1);
    expect(miss.message.length).toBeGreaterThan(0); // fail still reports remediation
    expect(miss.stream).toBe("stderr");

    writeBrief(root, "completed", "quiet-ok.xbrief.json", issuePlan(9011));
    writeCachedIssue(root, "deftai/directive", 9011, "closed");
    git(root, ["add", "xbrief/completed/quiet-ok.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "quiet land"]);
    // Remove the untracked miss so only landed 9011 remains as closed scoped.
    // 9010 still untracked completed → still fail; use resolveIssueState instead.
    const passRoot = makeGitRepo();
    writeBrief(passRoot, "completed", "only-ok.xbrief.json", issuePlan(9012));
    writeCachedIssue(passRoot, "deftai/directive", 9012, "closed");
    git(passRoot, ["add", "xbrief/completed/only-ok.xbrief.json"]);
    git(passRoot, ["commit", "-q", "-m", "land"]);
    const pass = evaluateCompletedTracked(passRoot, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      quiet: true,
    });
    expect(pass.code).toBe(0);
    expect(pass.message).toBe("");
    expect(pass.stream).toBe("none");
  });

  it("uses live gh when cache misses and skipGh is false", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "live-gh.xbrief.json", issuePlan(9020));
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: false,
      tip: "HEAD",
      runGh: (cmd) => {
        if (cmd.join(" ").includes("/issues/9020")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "closed" }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "miss" };
      },
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9020);
  });

  it("does not fail when issue state cannot be resolved", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "unknown-state.xbrief.json", issuePlan(9021));
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
  });

  it("skips unreadable local briefs and tip blobs that are not plans", () => {
    const root = makeGitRepo();
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(join(root, "xbrief", "completed", "bad.xbrief.json"), "{not-json", "utf8");
    writeFileSync(
      join(root, "xbrief", "completed", "no-plan.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" } }),
      "utf8",
    );
    writeBrief(root, "completed", "good.xbrief.json", issuePlan(9030));
    writeCachedIssue(root, "deftai/directive", 9030, "closed");
    git(root, ["add", "xbrief/completed"]);
    git(root, ["commit", "-q", "-m", "mixed completed"]);
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
  });

  it("truncates long origin lists in the fail message", () => {
    const root = makeGitRepo();
    for (let i = 0; i < 4; i += 1) {
      writeBrief(root, "active", `origin-${i}.xbrief.json`, {
        ...issuePlan(9040),
        status: "running",
        title: `origin ${i}`,
      });
    }
    writeCachedIssue(root, "deftai/directive", 9040, "closed");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("more origin path");
  });

  it("honors resolveIssueState test seam", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "seam.xbrief.json", issuePlan(9050));
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      resolveIssueState: () => "closed",
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9050);
  });

  it("revalidates stale open cache via live gh when skipGh is false (#3264 P1)", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "stale-open.xbrief.json", issuePlan(9060));
    writeCachedIssue(root, "deftai/directive", 9060, "open");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: false,
      tip: "HEAD",
      runGh: (cmd) => {
        if (cmd.join(" ").includes("/issues/9060")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ state: "closed" }),
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "miss" };
      },
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9060);
  });

  it("fails when land is only on HEAD and delivery tip is an older rev (strict tip)", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "pr-land.xbrief.json", issuePlan(9070));
    writeCachedIssue(root, "deftai/directive", 9070, "closed");
    git(root, ["add", "xbrief/completed/pr-land.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "lifecycle PR land"]);
    const first = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: first,
    });
    expect(result.code).toBe(1);
    // Operators validating an in-flight land PR should pass --tip HEAD.
    const headTip = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(headTip.code).toBe(0);
  });

  it("scopes --issue N so a sibling unlanded closed issue does not fail (#3476)", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "landed.xbrief.json", issuePlan(9101));
    writeBrief(root, "completed", "sibling-untracked.xbrief.json", issuePlan(9102));
    writeCachedIssue(root, "deftai/directive", 9101, "closed");
    writeCachedIssue(root, "deftai/directive", 9102, "closed");
    git(root, ["add", "xbrief/completed/landed.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "land 9101 only"]);
    const scoped = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9101,
    });
    expect(scoped.code).toBe(0);
    expect(scoped.missing).toEqual([]);
    const sibling = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9102,
    });
    expect(sibling.code).toBe(1);
    expect(sibling.missing[0]?.issue.number).toBe(9102);
  });

  it("fails --issue N when completed is only on feature HEAD, not delivery tip (#3476)", () => {
    const root = makeGitRepo();
    const deliveryTip = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeBrief(root, "completed", "laptop-only.xbrief.json", issuePlan(9103));
    writeCachedIssue(root, "deftai/directive", 9103, "closed");
    git(root, ["add", "xbrief/completed/laptop-only.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "feature-only land"]);
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: deliveryTip,
      issue: 9103,
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9103);
    expect(result.message).toContain("task swarm:finalize-cohort");
    const featureHead = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9103,
    });
    expect(featureHead.code).toBe(0);
  });

  it("fails --issue N with no local origin when the issue is closed and unlanded (#3476)", () => {
    const root = makeGitRepo();
    writeCachedIssue(root, "deftai/directive", 9104, "closed");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9104,
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9104);
    expect(result.missing[0]?.origins).toContain("--issue 9104");
  });

  it("does not fail --issue N when the named issue is still open and unlanded", () => {
    const root = makeGitRepo();
    writeCachedIssue(root, "deftai/directive", 9105, "open");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9105,
    });
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
  });

  it("returns config error for a non-positive --issue", () => {
    const root = makeGitRepo();
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 0,
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("positive integer");
  });

  it("fails closed when live gh fails for an unlanded origin (#3264 conf residual)", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "stale-open-live-fail.xbrief.json", issuePlan(9080));
    writeCachedIssue(root, "deftai/directive", 9080, "open");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: false,
      tip: "HEAD",
      runGh: () => ({ returncode: 1, stdout: "", stderr: "network down" }),
    });
    // Unknown with live expected must not green-skip unlanded residue.
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9080);
  });

  // #3478 review: --issue matching must be repo-scoped. A foreign repo's
  // same-numbered issue previously survived the filter, left originMap
  // non-empty (suppressing synthesis of the requested issue), and let its
  // own open state green-skip the local unlanded one.
  it("does not let a foreign repo's same-numbered issue satisfy --issue", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "foreign-same-number.xbrief.json", {
      status: "completed",
      title: "foreign story 9200",
      references: [
        {
          uri: "https://github.com/otherorg/otherrepo/issues/9200",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "otherorg/otherrepo", 9200, "open");
    writeCachedIssue(root, "deftai/directive", 9200, "closed");
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9200,
    });
    expect(result.code).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.issue.repo).toBe("deftai/directive");
    expect(result.missing[0]?.issue.number).toBe(9200);
  });

  // #3478 review: --skip-gh must not turn the named-issue DONE form into a
  // no-op for an issue the cache has never seen.
  it("fails --issue N under --skip-gh when the cache has no state for it", () => {
    const root = makeGitRepo();
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 9201,
    });
    expect(result.code).toBe(1);
    expect(result.missing[0]?.issue.number).toBe(9201);
    expect(result.missing[0]?.origins).toContain("--issue 9201");
  });

  // Guard the narrowing above: the unscoped corpus scan keeps its offline
  // allowance, since a cold cache legitimately knows nothing about most
  // scoped issues. Only the explicitly named --issue tightens.
  it("keeps the offline allowance for uncached issues on the unscoped scan", () => {
    const root = makeGitRepo();
    writeBrief(root, "completed", "uncached-unscoped.xbrief.json", issuePlan(9202));
    const result = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.code).toBe(0);
    expect(result.missing).toEqual([]);
  });
});
