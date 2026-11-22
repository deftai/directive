/**
 * `deft check --no-suite` branch resolution (#6970): the delivery and
 * comparison branches come from the existing resolvers, a remote default is
 * bootstrapped only when nothing local names one, and a missing branch is told
 * apart from other fetch failures. Offline: git runs through the seam.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NoSuiteGhGetFn,
  type NoSuiteGitFn,
  prepareNoSuiteRun,
  remoteHeadBranchFromLsRemote,
} from "./no-suite.js";

const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeProject(policy: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "no-suite-branch-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ plan: { title: "P", status: "running", policy } }),
    "utf8",
  );
  return root;
}

interface RepoOptions {
  /** Target of local `refs/remotes/origin/HEAD`, if set. */
  readonly originHead?: string;
  /** Remote-tracking refs present before the run. */
  readonly tracking?: readonly string[];
  /** Branches origin has. */
  readonly remoteBranches: readonly string[];
  /** What `ls-remote --symref origin HEAD` reports; null makes it fail. */
  readonly remoteHead?: string | null;
  /** Fetches of these branches fail although origin may have them. */
  readonly failFetch?: readonly string[];
  /** Exit status of the exact `ls-remote --exit-code` probe, overriding the model. */
  readonly probeStatus?: number;
}

function fakeRepo(options: RepoOptions): { git: NoSuiteGitFn; calls: string[] } {
  const calls: string[] = [];
  const tracking = new Set(options.tracking ?? []);
  let originHead = options.originHead;
  if (originHead !== undefined) tracking.add(originHead);
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = (status: number, stderr: string) => ({ status, stdout: "", stderr });
  const git: NoSuiteGitFn = (args) => {
    calls.push(args.join(" "));
    const [cmd] = args;
    if (cmd === "symbolic-ref") {
      return originHead !== undefined ? ok(`origin/${originHead}\n`) : fail(128, "not a symref");
    }
    if (cmd === "show-ref") {
      const ref = args[args.length - 1] ?? "";
      const prefix = "refs/remotes/origin/";
      return ref.startsWith(prefix) && tracking.has(ref.slice(prefix.length)) ? ok() : fail(1, "");
    }
    if (cmd === "ls-remote" && args[1] === "--symref") {
      return options.remoteHead === null || options.remoteHead === undefined
        ? fail(128, "fatal: could not read from remote repository")
        : ok(`ref: refs/heads/${options.remoteHead}\tHEAD\n${HEAD}\tHEAD\n`);
    }
    if (cmd === "ls-remote" && args[1] === "--exit-code") {
      if (options.probeStatus !== undefined) return fail(options.probeStatus, "");
      const branch = (args[3] ?? "").replace("refs/heads/", "");
      return options.remoteBranches.includes(branch) ? ok(`${HEAD}\t${args[3]}\n`) : fail(2, "");
    }
    if (cmd === "fetch") {
      const refspec = args[args.length - 1] ?? "";
      const branch = refspec.slice("refs/heads/".length, refspec.indexOf(":"));
      if (options.failFetch?.includes(branch)) {
        return fail(128, "error: cannot lock ref 'refs/remotes/origin/x'");
      }
      if (!options.remoteBranches.includes(branch)) {
        return fail(128, `fatal: couldn't find remote ref ${branch}`);
      }
      tracking.add(branch);
      return ok();
    }
    if (cmd === "remote" && args[1] === "set-head") {
      const branch = args[3] ?? "";
      if (!tracking.has(branch))
        return fail(128, `error: Not a valid ref: refs/remotes/origin/${branch}`);
      originHead = branch;
      return ok();
    }
    if (cmd === "remote" && args[1] === "get-url") return ok("https://github.com/acme/app.git\n");
    if (cmd === "rev-parse") return ok(`${HEAD}\n`);
    if (cmd === "merge-base") return ok("mergebase0\n");
    return fail(1, "unexpected");
  };
  return { git, calls };
}

function gh(pulls: Record<string, unknown>[] = []): NoSuiteGhGetFn {
  return (path) => {
    if (path.endsWith("/pulls")) return { ok: true, json: pulls };
    const n = Number(path.split("/").pop());
    const found = pulls.find((p) => p.number === n);
    return found !== undefined ? { ok: true, json: found } : { ok: false, error: "HTTP 404" };
  };
}

function openPr(number: number, base: string): Record<string, unknown> {
  return { number, state: "open", head: { sha: HEAD }, base: { ref: base }, body: "" };
}

const fetchesOf = (calls: string[]) => calls.filter((c) => c.startsWith("fetch "));
const fetchOf = (b: string) => `fetch origin -- refs/heads/${b}:refs/remotes/origin/${b}`;
const noEvent = () => ({ path: "/tmp/no-suite-branch-event.json", cleanup: () => {} });

describe("check --no-suite branch resolution (#6970)", () => {
  it("fetches main, not master, when origin/HEAD names main and no policy is set", () => {
    const { git, calls } = fakeRepo({ originHead: "main", remoteBranches: ["main"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(true);
    expect(fetchesOf(calls)).toEqual([fetchOf("main")]);
    expect(calls).toContain("merge-base HEAD origin/main");
    expect(calls.some((c) => c.includes("master"))).toBe(false);
    if (prep.ok) {
      expect(prep.header[0]).toBe(
        "check --no-suite: fetched origin/main (origin/HEAD or an existing main/master ref)",
      );
      expect(prep.header[1]).toContain("with origin/main");
    }
  });

  it("fetches a typed base branch and a different typed delivery branch", () => {
    const { git, calls } = fakeRepo({ remoteBranches: ["develop", "main"] });
    const root = makeProject({ baseBranch: "develop", deliveryBranch: "main" });
    const prep = prepareNoSuiteRun({ projectRoot: root, env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(true);
    expect(fetchesOf(calls)).toEqual([fetchOf("develop"), fetchOf("main")]);
    expect(calls).toContain("merge-base HEAD origin/develop");
    if (prep.ok) {
      expect(prep.header[0]).toBe(
        "check --no-suite: fetched origin/develop (plan.policy.baseBranch) and origin/main (plan.policy.deliveryBranch)",
      );
    }
  });

  it("compares against the open PR's base and still fetches the delivery branch", () => {
    const { git, calls } = fakeRepo({ originHead: "main", remoteBranches: ["main", "release"] });
    const prep = prepareNoSuiteRun({
      projectRoot: makeProject(),
      env: {},
      git,
      ghGet: gh([openPr(12, "release")]),
      writeEvent: noEvent,
    });
    expect(prep.ok).toBe(true);
    expect(fetchesOf(calls)).toEqual([fetchOf("release"), fetchOf("main")]);
    expect(calls).toContain("merge-base HEAD origin/release");
    if (prep.ok) {
      expect(prep.env.GITHUB_BASE_REF).toBe("release");
      expect(prep.header[0]).toContain("origin/release (pull request #12 base)");
    }
  });

  it("bootstraps origin/HEAD from origin's HEAD branch: fetch first, then set-head", () => {
    const { git, calls } = fakeRepo({ remoteHead: "trunk", remoteBranches: ["trunk"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(true);
    const fetchAt = calls.indexOf(fetchOf("trunk"));
    const setHeadAt = calls.indexOf("remote set-head origin trunk");
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(setHeadAt).toBeGreaterThan(fetchAt);
    expect(fetchesOf(calls)).toEqual([fetchOf("trunk")]);
    expect(calls).toContain("merge-base HEAD origin/trunk");
    expect(calls.some((c) => c.startsWith("fetch") && c.includes("master"))).toBe(false);
    if (prep.ok) {
      expect(prep.header[0]).toBe("check --no-suite: fetched origin/trunk (origin's HEAD branch)");
    }
  });

  it("does not query origin when a local default exists", () => {
    const { git, calls } = fakeRepo({ tracking: ["master"], remoteBranches: ["master"] });
    prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(calls.some((c) => c.startsWith("ls-remote --symref"))).toBe(false);
  });

  it("keeps the fallback without set-head when the remote HEAD query fails", () => {
    const { git, calls } = fakeRepo({ remoteHead: null, remoteBranches: ["master"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("remote set-head"))).toBe(false);
    expect(fetchesOf(calls)).toEqual([fetchOf("master")]);
    if (prep.ok) expect(prep.header[0]).toContain("origin/master (framework fallback)");
  });

  it("names a missing typed base branch and its policy key, not the network", () => {
    const { git } = fakeRepo({ originHead: "trunk", remoteBranches: ["trunk"] });
    const root = makeProject({ baseBranch: "main" });
    const prep = prepareNoSuiteRun({ projectRoot: root, env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.exitCode).toBe(2);
    expect(prep.message).toBe(
      "check --no-suite: origin has no branch main (from plan.policy.baseBranch); no gate ran. " +
        "Set plan.policy.baseBranch to a branch origin has, then run again.",
    );
    expect(prep.message.toLowerCase()).not.toContain("network");
  });

  it("matches the fix to the source of a missing branch", () => {
    const inferred = prepareNoSuiteRun({
      projectRoot: makeProject(),
      env: {},
      git: fakeRepo({ originHead: "main", remoteBranches: ["trunk"] }).git,
      ghGet: gh(),
    });
    expect(!inferred.ok && inferred.message).toContain(
      "origin has no branch main (from origin/HEAD or an existing main/master ref)",
    );
    expect(!inferred.ok && inferred.message).toContain("Set plan.policy.deliveryBranch (and");
    const typedDelivery = prepareNoSuiteRun({
      projectRoot: makeProject({ deliveryBranch: "prod" }),
      env: {},
      git: fakeRepo({ remoteBranches: ["main"] }).git,
      ghGet: gh(),
    });
    expect(!typedDelivery.ok && typedDelivery.message).toContain(
      "(from plan.policy.deliveryBranch); no gate ran. Set plan.policy.deliveryBranch to",
    );
    const prBase = prepareNoSuiteRun({
      projectRoot: makeProject(),
      env: {},
      git: fakeRepo({ originHead: "main", remoteBranches: ["main"] }).git,
      ghGet: gh([openPr(31, "gone")]),
      writeEvent: noEvent,
    });
    expect(!prBase.ok && prBase.message).toContain(
      "origin has no branch gone (from pull request #31 base); no gate ran. " +
        "Retarget pull request #31 or push its base branch, then run again.",
    );
  });

  it("keeps git's error without a network claim when origin has the branch", () => {
    const { git } = fakeRepo({ originHead: "main", remoteBranches: ["main"], failFetch: ["main"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.exitCode).toBe(2);
    expect(prep.message).toContain("although origin has that branch");
    expect(prep.message).toContain("cannot lock ref");
    expect(prep.message.toLowerCase()).not.toContain("network");
  });

  it("keeps the network text when the probe is inconclusive", () => {
    const { git } = fakeRepo({
      originHead: "main",
      remoteBranches: ["main"],
      failFetch: ["main"],
      probeStatus: 128,
    });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(!prep.ok && prep.message).toContain(
      "git fetch origin refs/heads/main:refs/remotes/origin/main failed (exit 128)",
    );
    expect(!prep.ok && prep.message).toContain("Restore network or remote access");
  });

  it.each([
    [{ baseBranch: 42 }, "plan.policy.baseBranch"],
    [{ baseBranch: "" }, "plan.policy.baseBranch"],
    [{ baseBranch: "bad:ref" }, "plan.policy.baseBranch"],
    [{ deliveryBranch: "bad:ref" }, "plan.policy.deliveryBranch"],
  ])("exits 2 before any fetch on malformed policy %j", (policy, key) => {
    const { git, calls } = fakeRepo({ originHead: "main", remoteBranches: ["main"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(policy), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.exitCode).toBe(2);
    expect(prep.message).toContain(`check --no-suite: ${key} is malformed`);
    expect(prep.message).toContain(`Correct ${key}, then run again.`);
    expect(fetchesOf(calls)).toEqual([]);
  });

  it("refuses an unsafe PR base name before fetching it", () => {
    const { git, calls } = fakeRepo({ originHead: "main", remoteBranches: ["main"] });
    const prep = prepareNoSuiteRun({
      projectRoot: makeProject(),
      env: {},
      git,
      ghGet: gh([openPr(8, "-x")]),
      writeEvent: noEvent,
    });
    expect(prep.ok).toBe(false);
    if (prep.ok) return;
    expect(prep.message).toContain("Invalid branch");
    expect(prep.message).toContain("(from pull request #8 base); no gate ran.");
    expect(fetchesOf(calls)).toEqual([]);
  });

  it("fetches only master in a repo whose origin/HEAD names master", () => {
    const { git, calls } = fakeRepo({ originHead: "master", remoteBranches: ["master"] });
    const prep = prepareNoSuiteRun({ projectRoot: makeProject(), env: {}, git, ghGet: gh() });
    expect(prep.ok).toBe(true);
    expect(fetchesOf(calls)).toEqual([fetchOf("master")]);
  });
});

describe("remoteHeadBranchFromLsRemote (#6970)", () => {
  it("reads the HEAD symref line and rejects unsafe or missing names", () => {
    expect(remoteHeadBranchFromLsRemote(`ref: refs/heads/main\tHEAD\n${HEAD}\tHEAD\n`)).toBe(
      "main",
    );
    expect(remoteHeadBranchFromLsRemote("ref: refs/heads/team/trunk\tHEAD\r\n")).toBe("team/trunk");
    expect(remoteHeadBranchFromLsRemote(`${HEAD}\tHEAD\n`)).toBeNull();
    expect(remoteHeadBranchFromLsRemote("ref: refs/heads/-x\tHEAD\n")).toBeNull();
    expect(remoteHeadBranchFromLsRemote("ref: refs/heads/main\trefs/heads/x\n")).toBeNull();
    expect(remoteHeadBranchFromLsRemote("")).toBeNull();
  });
});
