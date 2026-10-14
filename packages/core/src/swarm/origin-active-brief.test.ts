import { describe, expect, it } from "vitest";
import { originActiveBriefPresent } from "./origin-active-brief.js";
import type { TextCaptureResult } from "./subprocess.js";

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
