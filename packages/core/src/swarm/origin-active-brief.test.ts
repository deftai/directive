import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import { originActiveBriefPresent, originOnePrBriefAdmitted } from "./origin-active-brief.js";
import { runText, type TextCaptureResult } from "./subprocess.js";

describe("origin-active-brief (#4714 R2)", () => {
  it("reports present when cat-file -t returns blob after fetch", () => {
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "fetch") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (cmd[1] === "cat-file" && cmd[2] === "-t") {
        return { returncode: 0, stdout: "blob\n", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = originActiveBriefPresent(
      "/tmp/proj",
      "master",
      "xbrief/active/story.xbrief.json",
      runGit,
    );
    expect(result.present).toBe(true);
    expect(result.error).toBeNull();
  });

  it("refuses tree objects that would false-present as active briefs", () => {
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "fetch") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (cmd[1] === "cat-file" && cmd[2] === "-t") {
        return { returncode: 0, stdout: "tree\n", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = originActiveBriefPresent("/tmp/proj", "master", "xbrief/active", runGit);
    expect(result.present).toBe(false);
    expect(result.error).toContain("activation PR");
  });

  it("returns activation remediation when the tip blob is missing", () => {
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "fetch") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "missing" };
    };
    const result = originActiveBriefPresent(
      "/tmp/proj",
      "master",
      "xbrief/active/story.xbrief.json",
      runGit,
    );
    expect(result.present).toBe(false);
    expect(result.error).toContain("activation PR");
  });

  it("surfaces fetch failures", () => {
    const result = originActiveBriefPresent("/tmp/proj", "master", "xbrief/active/a.json", () => ({
      returncode: 1,
      stdout: "",
      stderr: "network down",
    }));
    expect(result.present).toBe(false);
    expect(result.error).toContain("git fetch origin master failed");
  });

  it("refuses hostile branch names before spawn and uses trackingFetchArgv (#5545)", () => {
    const calls: string[][] = [];
    const runGit = (cmd: readonly string[]): TextCaptureResult => {
      calls.push([...cmd]);
      return { returncode: 0, stdout: "blob\n", stderr: "" };
    };
    for (const hostile of ["--upload-pack=evil", "attacker:master", "-x", "a..b", " ", ""]) {
      calls.length = 0;
      const result = originActiveBriefPresent("/tmp/proj", hostile, "xbrief/active/a.json", runGit);
      expect(result.present).toBe(false);
      expect(result.error).toMatch(/Invalid|must match/i);
      expect(calls).toHaveLength(0);
    }
    calls.length = 0;
    const ok = originActiveBriefPresent(
      "/tmp/proj",
      "release/1.0",
      "xbrief/active/a.json",
      (cmd) => {
        calls.push([...cmd]);
        if (cmd[1] === "fetch") return { returncode: 0, stdout: "", stderr: "" };
        if (cmd[1] === "cat-file") return { returncode: 0, stdout: "blob\n", stderr: "" };
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      },
    );
    expect(ok.present).toBe(true);
    expect(calls[0]).toEqual([
      "git",
      "fetch",
      "origin",
      "--",
      "refs/heads/release/1.0:refs/remotes/origin/release/1.0",
    ]);
    expect(calls[1]?.[3]).toBe("origin/release/1.0:xbrief/active/a.json");
  });
});

describe("originOnePrBriefAdmitted (#6361)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  const PLAN_ID = "s-6361";
  const BRIEF_REL = "xbrief/active/s-6361.xbrief.json";
  const RECORD_REL = `.deft/approved-scope/${PLAN_ID}.json`;
  const INTENT_REL = `.deft/approved-scope/${PLAN_ID}.intent.json`;
  const SCOPE = ["src/a.ts", RECORD_REL, INTENT_REL];
  const PARENT_REL = "xbrief/active/parent-6361.xbrief.json";

  function write(root: string, rel: string, text: string): void {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }

  function sha(root: string, ref: string): string {
    return execFileSync("git", ["rev-parse", ref], { cwd: root }).toString().trim();
  }

  function pd(policy: Record<string, unknown> | null): string {
    return JSON.stringify({
      plan: { title: "t", status: "running", ...(policy === null ? {} : { policy }) },
    });
  }

  /**
   * origin/master: PROJECT-DEFINITION with `basePolicy`, no brief.
   * origin/one-pr: brief (+ mint pair minted for `mintScope`, unless null).
   */
  function repo(options: {
    basePolicy: Record<string, unknown> | null;
    headPolicy?: Record<string, unknown>;
    mintScope?: readonly string[] | null;
    /** Brief names a parent (planRef) that exists only on the one-PR branch. */
    withParent?: boolean;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "oab-6361-"));
    temps.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t.local");
    git("config", "user.name", "T");
    write(root, "xbrief/PROJECT-DEFINITION.xbrief.json", pd(options.basePolicy));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "one-pr");
    if (options.headPolicy !== undefined) {
      write(root, "xbrief/PROJECT-DEFINITION.xbrief.json", pd(options.headPolicy));
    }
    if (options.withParent === true) {
      write(root, PARENT_REL, JSON.stringify({ plan: { id: "parent-6361", title: "P" } }));
    }
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: PLAN_ID,
        title: "S",
        status: "running",
        ...(options.withParent === true ? { planRef: PARENT_REL } : {}),
        metadata: { swarm: { file_scope: SCOPE } },
      },
    };
    write(root, BRIEF_REL, JSON.stringify(payload));
    const mintScope = options.mintScope === undefined ? SCOPE : options.mintScope;
    if (mintScope !== null) {
      const minted = {
        ...payload,
        plan: { ...payload.plan, metadata: { swarm: { file_scope: [...mintScope] } } },
      };
      // Mint while the parent is in the working tree (as the mint verb would).
      const extracted = extractIntentFromRaw(JSON.stringify(minted), { projectRoot: root });
      if (!extracted.ok) throw new Error(extracted.error);
      const record = {
        ...buildApprovedScopeRecord({
          xbriefRelPath: BRIEF_REL,
          payload: minted,
          humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-16T00:00:00Z" },
          intentDigest: computeIntentDigest(extracted.preimage),
          digestAlgo: "intent-extract-v1",
        }),
        authHashV1: computeAuthHashV1(minted, BRIEF_REL) ?? "",
      };
      write(root, RECORD_REL, JSON.stringify(record));
      write(root, INTENT_REL, JSON.stringify(extracted.preimage));
    }
    git("add", "-A");
    git("commit", "-q", "-m", "one-PR brief");
    const bare = mkdtempSync(join(tmpdir(), "oab-6361-bare-"));
    temps.push(bare);
    execFileSync("git", ["clone", "--bare", "-q", root, join(bare, "o.git")]);
    git("remote", "add", "origin", join(bare, "o.git"));
    git("fetch", "-q", "origin");
    git("checkout", "-q", "master");
    return root;
  }

  const MINT = { onePrScopeProof: "mint" };

  it("admits a pushed one-PR brief and returns the pinned commit to build the dest from", () => {
    const root = repo({ basePolicy: MINT });
    expect(originActiveBriefPresent(root, "master", BRIEF_REL, runText).present).toBe(false);
    expect(originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, runText)).toEqual({
      present: true,
      error: null,
      ref: sha(root, "origin/one-pr"),
    });
  });

  it("reads a planRef parent from the pushed commit, not the local checkout", () => {
    const root = repo({ basePolicy: MINT, withParent: true });
    // The local checkout is master, which has no parent brief.
    expect(existsSync(join(root, ...PARENT_REL.split("/")))).toBe(false);
    expect(originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, runText)).toMatchObject({
      present: true,
      ref: sha(root, "origin/one-pr"),
    });
  });

  it("checks a pinned commit without fetching, even after the branch moves", () => {
    const root = repo({ basePolicy: MINT });
    const pinned = sha(root, "origin/one-pr");
    // The branch advances and drops the mint record.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("checkout", "-q", "one-pr");
    git("rm", "-q", RECORD_REL);
    git("commit", "-q", "-m", "drop record");
    git("push", "-q", "origin", "one-pr");
    git("checkout", "-q", "master");
    const calls: string[] = [];
    const spy: typeof runText = (cmd, opts) => {
      calls.push(String(cmd[1]));
      return runText(cmd, opts);
    };
    expect(originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, spy, pinned)).toEqual({
      present: true,
      error: null,
      ref: pinned,
    });
    expect(calls).not.toContain("fetch");
    // A fresh probe sees the moved tip and refuses.
    expect(originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, runText).error).toBe(
      "no same-PR approved-scope record",
    );
    expect(
      originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, runText, "not-a-sha").error,
    ).toBe("pinned commit is not a SHA");
  });

  it("refuses when the level is off, the record is missing or mismatched, or the head changes policy", () => {
    const off = repo({ basePolicy: null });
    expect(originOnePrBriefAdmitted(off, "master", "one-pr", BRIEF_REL, runText).error).toMatch(
      /level is off/,
    );
    const noRecord = repo({ basePolicy: MINT, mintScope: null });
    expect(originOnePrBriefAdmitted(noRecord, "master", "one-pr", BRIEF_REL, runText).error).toBe(
      "no same-PR approved-scope record",
    );
    const mismatch = repo({ basePolicy: MINT, mintScope: ["src/a.ts", RECORD_REL] });
    expect(originOnePrBriefAdmitted(mismatch, "master", "one-pr", BRIEF_REL, runText).present).toBe(
      false,
    );
    const policyEdit = repo({ basePolicy: MINT, headPolicy: { onePrScopeProof: "off" } });
    expect(
      originOnePrBriefAdmitted(policyEdit, "master", "one-pr", BRIEF_REL, runText).error,
    ).toMatch(/onePrScopeProof or requireHumanMerge/);
  });

  it("refuses a brief that is on neither ref, a hostile branch and a failed fetch", () => {
    const root = repo({ basePolicy: MINT });
    const missing = originOnePrBriefAdmitted(
      root,
      "master",
      "one-pr",
      "xbrief/active/other.xbrief.json",
      runText,
    );
    expect(missing).toMatchObject({ present: false, ref: null });
    expect(missing.error).toMatch(/has no active brief/);
    expect(
      originOnePrBriefAdmitted(root, "master", "--upload-pack=x", BRIEF_REL, runText).error,
    ).toMatch(/Invalid|must match/i);
    expect(
      originOnePrBriefAdmitted(root, "master", "no-such-branch", BRIEF_REL, runText).error,
    ).toMatch(/git fetch origin no-such-branch failed/);
  });

  it("fails closed without throwing when git throws", () => {
    const result = originOnePrBriefAdmitted("/tmp/proj", "master", "one-pr", BRIEF_REL, () => {
      throw new Error("spawn exploded");
    });
    expect(result).toEqual({
      present: false,
      error: "one-PR probe failed: spawn exploded",
      ref: null,
    });
  });
});

describe("originOnePrBriefAdmitted refusals with a scripted git (#6361)", () => {
  const BRIEF = "xbrief/active/s.xbrief.json";
  const MINT_PD = JSON.stringify({
    plan: { title: "t", status: "running", policy: { onePrScopeProof: "mint" } },
  });
  const ok = (stdout = ""): TextCaptureResult => ({ returncode: 0, stdout, stderr: "" });
  const fail: TextCaptureResult = { returncode: 1, stdout: "", stderr: "fatal" };

  /** Scripted git: fetch ok, brief is a blob, merge-base ok, PROJECT-DEFINITION mint. */
  function git(overrides: {
    mergeBase?: TextCaptureResult;
    brief?: TextCaptureResult;
    record?: TextCaptureResult;
    revParse?: TextCaptureResult;
  }) {
    return (cmd: readonly string[]): TextCaptureResult => {
      if (cmd[1] === "fetch") return ok();
      if (cmd[1] === "rev-parse") return overrides.revParse ?? ok(`${"a".repeat(40)}\n`);
      if (cmd[1] === "cat-file") return ok("blob\n");
      if (cmd[1] === "merge-base") return overrides.mergeBase ?? ok("abc123\n");
      if (cmd[1] === "show") {
        const spec = String(cmd[2]);
        if (spec.endsWith("PROJECT-DEFINITION.xbrief.json")) return ok(MINT_PD);
        if (spec.endsWith(BRIEF)) return overrides.brief ?? fail;
        if (spec.includes(".deft/approved-scope/") && !spec.endsWith(".intent.json")) {
          return overrides.record ?? fail;
        }
      }
      return fail;
    };
  }

  const probe = (runGit: ReturnType<typeof git>, delivery = "master") =>
    originOnePrBriefAdmitted("/tmp/proj", delivery, "one-pr", BRIEF, runGit);

  it("refuses an unsafe delivery branch name", () => {
    expect(probe(git({}), "--upload-pack=x").error).toMatch(/Invalid|must match/i);
  });

  it("refuses when the fetched branch does not resolve to a commit", () => {
    for (const revParse of [fail, ok("not-a-sha\n")]) {
      expect(probe(git({ revParse })).error).toBe("git rev-parse origin/one-pr failed");
    }
  });

  it("accepts a SHA-256 object id for the pinned tip", () => {
    const sha256 = "b".repeat(64);
    // Gets past the pin to the brief read, with both the fetched and the passed-in id.
    expect(probe(git({ revParse: ok(`${sha256}\n`) })).error).toBe(
      `origin/one-pr:${BRIEF} unreadable`,
    );
    expect(
      originOnePrBriefAdmitted("/tmp/proj", "master", "one-pr", BRIEF, git({}), sha256).error,
    ).toBe(`origin/one-pr:${BRIEF} unreadable`);
  });

  it("refuses when merge-base fails", () => {
    expect(probe(git({ mergeBase: fail })).error).toBe(
      "git merge-base origin/master origin/one-pr failed",
    );
    expect(probe(git({ mergeBase: ok("") })).error).toMatch(/merge-base .* failed/);
  });

  it("refuses an unreadable, non-JSON or id-less brief at the tip", () => {
    expect(probe(git({})).error).toBe(`origin/one-pr:${BRIEF} unreadable`);
    expect(probe(git({ brief: ok("{not json") })).error).toBe(
      `origin/one-pr:${BRIEF} is not valid JSON`,
    );
    expect(probe(git({ brief: ok(JSON.stringify({ plan: { title: "x" } })) })).error).toBe(
      "head brief has no plan.id",
    );
  });

  it("treats a malformed record at the tip as no record", () => {
    const brief = ok(JSON.stringify({ plan: { id: "s", title: "x", status: "running" } }));
    for (const record of [
      ok("{not json"),
      ok("[]"),
      ok("null"),
      ok(JSON.stringify({ fileScope: [] })),
      fail,
    ]) {
      expect(probe(git({ brief, record })).error).toBe("no same-PR approved-scope record");
    }
  });
});
