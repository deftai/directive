import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingEmitUrl,
  clearRecoveredUrl,
  emitSingle,
  emitUmbrella,
  existingGithubIssueRef,
  GITHUB_ISSUE_REF_TYPE,
  IssueEmitError,
  loadPendingEmitUrls,
  loadRecoveredUrl,
  loadVbrief,
  recoverySidecarPath,
  rememberCreatedUrl,
  savePendingEmitUrl,
  writeVbrief,
} from "./issue-emit.js";

function clearTestFailEnv(): void {
  delete process.env.DEFT_ISSUE_EMIT_TEST_FAIL_LEDGER;
  delete process.env.DEFT_ISSUE_EMIT_TEST_FAIL_STAMP;
}

afterEach(() => {
  clearTestFailEnv();
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

    process.env.DEFT_ISSUE_EMIT_TEST_FAIL_LEDGER = "1";
    process.env.DEFT_ISSUE_EMIT_TEST_FAIL_STAMP = "1";
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
    clearTestFailEnv();
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

    process.env.DEFT_ISSUE_EMIT_TEST_FAIL_STAMP = "1";
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

    clearTestFailEnv();
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

    savePendingEmitUrl(dir, a, "https://github.com/o/r/issues/881");
    rememberCreatedUrl(a, "https://github.com/o/r/issues/881");
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

  it("umbrella reuses already-stamped sibling URL without re-create", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-umb-stamped-"));
    const a = join(dir, "a.xbrief.json");
    const b = join(dir, "b.xbrief.json");
    writeVbrief(
      a,
      {
        plan: {
          title: "Child A",
          references: [{ type: GITHUB_ISSUE_REF_TYPE, uri: "https://github.com/o/r/issues/900" }],
        },
      },
      dir,
    );
    writeVbrief(b, { plan: { title: "Child B" } }, dir);
    clearRecoveredUrl(b);
    const action = emitUmbrella([a, b], {
      repo: "o/r",
      projectRoot: dir,
      scmCall: (() => {
        throw new Error("must reuse stamped sibling URL");
      }) as never,
      displayPaths: ["a", "b"],
    });
    expect(action.result).toBe("created");
    expect(existingGithubIssueRef(loadVbrief(a))).toBe("https://github.com/o/r/issues/900");
    expect(existingGithubIssueRef(loadVbrief(b))).toBe("https://github.com/o/r/issues/900");
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    rmSync(dir, { recursive: true, force: true });
  });

  it("umbrella rejects recovery URL that conflicts with already-stamped sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-umb-stamped-conflict-"));
    const a = join(dir, "a.xbrief.json");
    const b = join(dir, "b.xbrief.json");
    writeVbrief(
      a,
      {
        plan: {
          title: "Child A",
          references: [{ type: GITHUB_ISSUE_REF_TYPE, uri: "https://github.com/o/r/issues/901" }],
        },
      },
      dir,
    );
    writeVbrief(b, { plan: { title: "Child B" } }, dir);
    clearRecoveredUrl(b);
    savePendingEmitUrl(dir, b, "https://github.com/o/r/issues/902");
    expect(() =>
      emitUmbrella([a, b], {
        repo: "o/r",
        projectRoot: dir,
        scmCall: (() => {
          throw new Error("must not create on stamped conflict");
        }) as never,
        displayPaths: ["a", "b"],
      }),
    ).toThrow(/conflicting issue URLs/);
    expect(existingGithubIssueRef(loadVbrief(b))).toBeUndefined();
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    rmSync(dir, { recursive: true, force: true });
  });

  it("umbrella rejects conflicting recovered sibling URLs before stamping either", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-umb-conflict-"));
    const a = join(dir, "a.xbrief.json");
    const b = join(dir, "b.xbrief.json");
    writeVbrief(a, { plan: { title: "Child A" } }, dir);
    writeVbrief(b, { plan: { title: "Child B" } }, dir);
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    savePendingEmitUrl(dir, a, "https://github.com/o/r/issues/1");
    savePendingEmitUrl(dir, b, "https://github.com/o/r/issues/2");
    expect(() =>
      emitUmbrella([a, b], {
        repo: "o/r",
        projectRoot: dir,
        scmCall: (() => {
          throw new Error("must not create when conflict detected");
        }) as never,
        displayPaths: ["a", "b"],
      }),
    ).toThrow(/conflicting issue URLs/);
    // Neither sibling stamped; both recovery/ledger entries remain for operator resolve.
    expect(existingGithubIssueRef(loadVbrief(a))).toBeUndefined();
    expect(existingGithubIssueRef(loadVbrief(b))).toBeUndefined();
    expect(loadPendingEmitUrls(dir)[resolve(a)]).toBe("https://github.com/o/r/issues/1");
    expect(loadPendingEmitUrls(dir)[resolve(b)]).toBe("https://github.com/o/r/issues/2");
    clearRecoveredUrl(a);
    clearRecoveredUrl(b);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovery load refuses symlink sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-symlink-"));
    const path = join(dir, "story.xbrief.json");
    writeVbrief(path, { plan: { title: "S" } }, dir);
    clearRecoveredUrl(path);
    const side = recoverySidecarPath(path);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep-me\n", "utf8");
    try {
      // Prefer junction/file symlink; skip when platform forbids symlink without elevation.
      mkdirSync(join(side, ".."), { recursive: true });
      symlinkSync(victim, side);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    // Process map empty after clear; load must not follow symlink to victim.
    expect(loadRecoveredUrl(path)).toBeUndefined();
    // rememberCreatedUrl must not follow symlink into victim content.
    rememberCreatedUrl(path, "https://github.com/o/r/issues/9");
    expect(loadRecoveredUrl(path)).toBe("https://github.com/o/r/issues/9");
    // Victim must remain unpolluted if link was replaced/refused.
    expect(readFileSync(victim, "utf8")).not.toContain("issues/9");
    clearRecoveredUrl(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovery load refuses group/other-writable forged sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-forge-"));
    const path = join(dir, "story.xbrief.json");
    writeVbrief(path, { plan: { title: "Forge" } }, dir);
    clearRecoveredUrl(path);
    // Plant a world-writable forged sidecar under the recovery path.
    const side = recoverySidecarPath(path);
    mkdirSync(join(side, ".."), { recursive: true, mode: 0o777 });
    writeFileSync(
      side,
      `${JSON.stringify({ path: resolve(path), url: "https://github.com/evil/r/issues/666" }, null, 2)}\n`,
      "utf8",
    );
    try {
      chmodSync(side, 0o666);
    } catch {
      // Platform may ignore mode bits; ownership path still exercises.
    }
    // Clear process map so load only sees disk (forged) state.
    clearRecoveredUrl(path);
    // Re-plant after clearRecoveredUrl may have unlinked.
    writeFileSync(
      side,
      `${JSON.stringify({ path: resolve(path), url: "https://github.com/evil/r/issues/666" }, null, 2)}\n`,
      "utf8",
    );
    try {
      chmodSync(side, 0o666);
    } catch {
      // ignore
    }
    // If mode is still group/other writable, load must refuse.
    // On platforms where chmod is a no-op (win32), isTrustedStat may still accept —
    // then at least URL must not stamp from process-cleared path without our write.
    const recovered = loadRecoveredUrl(path);
    if (process.platform !== "win32") {
      expect(recovered).toBeUndefined();
    } else if (recovered !== undefined) {
      // win32 often ignores mode; still must not be stamped without emitSingle.
      expect(existingGithubIssueRef(loadVbrief(path))).toBeUndefined();
    }
    clearRecoveredUrl(path);
    rmSync(dir, { recursive: true, force: true });
  });
});
