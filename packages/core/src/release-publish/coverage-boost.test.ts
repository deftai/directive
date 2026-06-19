import { describe, expect, it, vi } from "vitest";
import { parsePublishFlags } from "./flags.js";
import { editReleasePublish, ghApiFindReleaseByTag } from "./gh-api.js";
import { cmdReleasePublish } from "./main.js";

describe("release-publish branch coverage boost", () => {
  it("flags missing --repo value", () => {
    const flags = parsePublishFlags(["0.21.0", "--repo"]);
    expect(flags.unknown).toContain("--repo (missing value)");
  });

  it("flags missing --project-root value", () => {
    const flags = parsePublishFlags(["0.21.0", "--project-root"]);
    expect(flags.unknown).toContain("--project-root (missing value)");
  });

  it("flags empty --repo= value", () => {
    const flags = parsePublishFlags(["0.21.0", "--repo="]);
    expect(flags.unknown).toContain("--repo= (empty value)");
  });

  it("flags empty --project-root= value", () => {
    const flags = parsePublishFlags(["0.21.0", "--project-root="]);
    expect(flags.unknown).toContain("--project-root= (empty value)");
  });

  it("flags extra positional version", () => {
    const flags = parsePublishFlags(["0.21.0", "0.22.0"]);
    expect(flags.unknown).toContain("0.22.0");
  });

  it("ghApiFindReleaseByTag handles spawn throw", () => {
    const [state, , reason] = ghApiFindReleaseByTag("/usr/bin/gh", "deftai/directive", "v0.21.0", {
      spawnText: () => {
        throw new Error("ENOENT");
      },
    });
    expect(state).toBe("gh-error");
    expect(reason).toContain("gh CLI not found");
  });

  it("editReleasePublish handles patch spawn throw", () => {
    const [ok, reason] = editReleasePublish("0.21.0", "deftai/directive", 99, {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        throw new Error("ENOENT");
      },
    });
    expect(ok).toBe(false);
    expect(reason).toContain("gh CLI not found");
  });

  it("cmdReleasePublish surfaces validate errors", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleasePublish(["not-a-version"])).toBe(2);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Error:");
    stderr.mockRestore();
  });
});
