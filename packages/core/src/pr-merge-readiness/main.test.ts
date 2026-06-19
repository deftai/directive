import { describe, expect, it, vi } from "vitest";
import { cmdPrMergeReadiness, parseArgs, run } from "./main.js";
import type { RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";

function fakeRunGh(): RunGhFn {
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("headRefOid")) {
      return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    if (joined.includes("/comments")) {
      return {
        returncode: 0,
        stdout:
          "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
          `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`,
        stderr: "",
      };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

describe("parseArgs", () => {
  it("parses pr number repo and json", () => {
    expect(parseArgs(["1", "--repo", "deftai/directive", "--json"])).toEqual({
      prNumber: 1,
      repo: "deftai/directive",
      emitJson: true,
    });
  });

  it("parses --repo= form", () => {
    expect(parseArgs(["2", "--repo=org/repo"])).toMatchObject({ prNumber: 2, repo: "org/repo" });
  });

  it("errors on missing pr number", () => {
    expect(parseArgs(["--json"]).error).toContain("required");
  });

  it("errors on invalid pr number", () => {
    expect(parseArgs(["abc"]).error).toContain("invalid");
  });

  it("errors on unknown flag", () => {
    expect(parseArgs(["1", "--nope"]).error).toContain("unrecognized");
  });

  it("errors on missing --repo value", () => {
    expect(parseArgs(["1", "--repo"]).error).toContain("--repo");
  });
});

describe("run CLI", () => {
  it("returns 0 for clean json run", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = run(["1", "--repo", "deftai/directive", "--json"], { runGh: fakeRunGh() });
    expect(code).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain('"merge_ready": true');
    stdout.mockRestore();
  });

  it("returns 2 on parse error", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([], { runGh: fakeRunGh() })).toBe(2);
    stderr.mockRestore();
  });

  it("cmdPrMergeReadiness delegates to run", () => {
    expect(
      cmdPrMergeReadiness(["1", "--repo", "deftai/directive", "--json"], { runGh: fakeRunGh() }),
    ).toBe(0);
  });
});
