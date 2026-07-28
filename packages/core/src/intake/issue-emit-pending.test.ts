import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingEmitUrl,
  clearRecoveredUrl,
  emitSingle,
  emitUmbrella,
  existingGithubIssueRef,
  IssueEmitError,
  issueEmitTestHooks,
  loadPendingEmitUrls,
  loadRecoveredUrl,
  loadVbrief,
  rememberCreatedUrl,
  resetIssueEmitTestHooks,
  savePendingEmitUrl,
  writeVbrief,
} from "./issue-emit.js";

afterEach(() => {
  resetIssueEmitTestHooks();
});

describe("issue-emit pending ledger (#2871)", () => {
  it("records and clears pending emit URLs under project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-pend-"));
    const vpath = join(dir, "x.xbrief.json");
    savePendingEmitUrl(dir, vpath, "https://github.com/o/r/issues/42");
    const map = loadPendingEmitUrls(dir);
    expect(map[resolve(vpath)]).toBe("https://github.com/o/r/issues/42");
    clearPendingEmitUrl(dir, vpath);
    expect(Object.keys(loadPendingEmitUrls(dir))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emitSingle reconciles pending URL without remote create", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-recon-"));
    const path = join(dir, "story.xbrief.json");
    writeVbrief(path, { plan: { title: "Hello" } }, dir);
    savePendingEmitUrl(dir, path, "https://github.com/o/r/issues/99");
    const action = emitSingle(path, {
      repo: "o/r",
      projectRoot: dir,
      scmCall: (() => {
        throw new Error("should not call scm for pending reconcile");
      }) as never,
    });
    expect(action.result).toBe("created");
    expect(action.url).toBe("https://github.com/o/r/issues/99");
    expect(existingGithubIssueRef(loadVbrief(path))).toBe("https://github.com/o/r/issues/99");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("issue-emit dual-failure + recovery durability (#2880)", () => {
  it("rememberCreatedUrl survives process recovery load without project ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-rec-"));
    const path = join(dir, "story.xbrief.json");
    writeVbrief(path, { plan: { title: "R" } }, dir);
    clearRecoveredUrl(path);
    rememberCreatedUrl(path, "https://github.com/o/r/issues/77");
    expect(loadRecoveredUrl(path)).toBe("https://github.com/o/r/issues/77");
    clearRecoveredUrl(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dual ledger+stamp failure keeps URL; retry stamps without re-create", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-dual-"));
    const path = join(dir, "story.xbrief.json");
    writeVbrief(path, { plan: { title: "Dual" } }, dir);
    clearRecoveredUrl(path);

    let scmCalls = 0;
    const scmCall = () => {
      scmCalls += 1;
      return {
        returncode: 0,
        stdout: "https://github.com/o/r/issues/501\n",
        stderr: "",
      };
    };

    issueEmitTestHooks.failProjectLedger = true;
    issueEmitTestHooks.failStamp = true;
    let thrown: unknown;
    try {
      emitSingle(path, { repo: "o/r", projectRoot: dir, scmCall: scmCall as never });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IssueEmitError);
    expect((thrown as IssueEmitError).createdUrl).toBe("https://github.com/o/r/issues/501");
    expect(scmCalls).toBe(1);
    expect(existingGithubIssueRef(loadVbrief(path))).toBeUndefined();
    expect(loadRecoveredUrl(path)).toBe("https://github.com/o/r/issues/501");

    // Retry: recovery holds URL — must not file a second issue.
    resetIssueEmitTestHooks();
    const action = emitSingle(path, {
      repo: "o/r",
      projectRoot: dir,
      scmCall: (() => {
        throw new Error("retry must not re-create remote issue");
      }) as never,
    });
    expect(action.result).toBe("created");
    expect(action.url).toBe("https://github.com/o/r/issues/501");
    expect(existingGithubIssueRef(loadVbrief(path))).toBe("https://github.com/o/r/issues/501");
    expect(scmCalls).toBe(1);
    expect(loadRecoveredUrl(path)).toBeUndefined();

    clearRecoveredUrl(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it("umbrella mid-loop stamp failure reconciles all artifacts to original URL on retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-umb-"));
    const a = join(dir, "a.xbrief.json");
    const b = join(dir, "b.xbrief.json");
    writeVbrief(a, { plan: { title: "Child A" } }, dir);
    writeVbrief(b, { plan: { title: "Child B" } }, dir);
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);

    let scmCalls = 0;
    const scmCall = () => {
      scmCalls += 1;
      return {
        returncode: 0,
        stdout: "https://github.com/o/r/issues/880\n",
        stderr: "",
      };
    };

    // First pass: remote create + durable record, but stamp fails for all.
    issueEmitTestHooks.failStamp = true;
    let thrown: unknown;
    try {
      emitUmbrella([a, b], {
        repo: "o/r",
        projectRoot: dir,
        scmCall: scmCall as never,
        displayPaths: ["a", "b"],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IssueEmitError);
    expect((thrown as IssueEmitError).createdUrl).toBe("https://github.com/o/r/issues/880");
    expect(scmCalls).toBe(1);
    expect(existingGithubIssueRef(loadVbrief(a))).toBeUndefined();
    expect(existingGithubIssueRef(loadVbrief(b))).toBeUndefined();

    // Retry: both paths reconcile from ledger/recovery — no second remote create.
    resetIssueEmitTestHooks();
    const action = emitUmbrella([a, b], {
      repo: "o/r",
      projectRoot: dir,
      scmCall: (() => {
        throw new Error("umbrella retry must not re-create remote issue");
      }) as never,
      displayPaths: ["a", "b"],
    });
    expect(action.result).toBe("created");
    expect(action.url).toBe("https://github.com/o/r/issues/880");
    expect(existingGithubIssueRef(loadVbrief(a))).toBe("https://github.com/o/r/issues/880");
    expect(existingGithubIssueRef(loadVbrief(b))).toBe("https://github.com/o/r/issues/880");
    expect(scmCalls).toBe(1);

    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    rmSync(dir, { recursive: true, force: true });
  });

  it("umbrella partial stamp: one child pending still uses sibling URL without re-create", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-umb-part-"));
    const a = join(dir, "a.xbrief.json");
    const b = join(dir, "b.xbrief.json");
    writeVbrief(a, { plan: { title: "Child A" } }, dir);
    writeVbrief(b, { plan: { title: "Child B" } }, dir);
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);

    // Simulate post-create partial: A has durable URL, B has neither stamp nor ledger.
    savePendingEmitUrl(dir, a, "https://github.com/o/r/issues/881");
    rememberCreatedUrl(a, "https://github.com/o/r/issues/881");
    // B lost local records except we still expect sibling reconcile — put recovery only on A.
    // With sibling recovery, B should inherit A's URL without scm.
    const action = emitUmbrella([a, b], {
      repo: "o/r",
      projectRoot: dir,
      scmCall: (() => {
        throw new Error("partial umbrella must reuse sibling URL");
      }) as never,
      displayPaths: ["a", "b"],
    });
    expect(action.result).toBe("created");
    expect(existingGithubIssueRef(loadVbrief(a))).toBe("https://github.com/o/r/issues/881");
    expect(existingGithubIssueRef(loadVbrief(b))).toBe("https://github.com/o/r/issues/881");

    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    rmSync(dir, { recursive: true, force: true });
  });
});
