import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearPendingEmitUrl,
  emitSingle,
  existingGithubIssueRef,
  loadPendingEmitUrls,
  loadVbrief,
  savePendingEmitUrl,
  writeVbrief,
} from "./issue-emit.js";

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
