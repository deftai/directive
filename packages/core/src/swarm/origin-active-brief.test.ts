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
});
