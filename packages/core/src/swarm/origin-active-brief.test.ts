import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  function write(root: string, rel: string, text: string): void {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
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
    const payload = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: PLAN_ID,
        title: "S",
        status: "running",
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
      const extracted = extractIntentFromRaw(JSON.stringify(minted), {});
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

  it("admits a pushed one-PR brief and returns the ref to build the dest from", () => {
    const root = repo({ basePolicy: MINT });
    expect(originActiveBriefPresent(root, "master", BRIEF_REL, runText).present).toBe(false);
    expect(originOnePrBriefAdmitted(root, "master", "one-pr", BRIEF_REL, runText)).toEqual({
      present: true,
      error: null,
      ref: "origin/one-pr",
    });
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
