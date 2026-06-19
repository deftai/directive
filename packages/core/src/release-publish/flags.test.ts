import { describe, expect, it } from "vitest";
import { RELEASE_PUBLISH_HELP } from "./constants.js";
import { formatMissingVersionError, formatReleasePublishHelp, parsePublishFlags } from "./flags.js";

describe("release-publish flags", () => {
  it("formats help byte-identical to Python argparse", () => {
    expect(formatReleasePublishHelp()).toBe(RELEASE_PUBLISH_HELP);
  });

  it("parses dry-run and repo flags", () => {
    const flags = parsePublishFlags([
      "0.21.0",
      "--dry-run",
      "--repo",
      "deftai/directive",
      "--project-root",
      "/tmp/root",
    ]);
    expect(flags.version).toBe("0.21.0");
    expect(flags.dryRun).toBe(true);
    expect(flags.repo).toBe("deftai/directive");
    expect(flags.projectRoot).toBe("/tmp/root");
  });

  it("parses equals-form project root", () => {
    const flags = parsePublishFlags(["0.21.0", "--project-root=/tmp/x"]);
    expect(flags.projectRoot).toBe("/tmp/x");
  });

  it("collects unknown flags", () => {
    const flags = parsePublishFlags(["0.21.0", "--bogus"]);
    expect(flags.unknown).toEqual(["--bogus"]);
  });

  it("formats missing version error", () => {
    expect(formatMissingVersionError()).toContain("arguments are required: version");
  });
});
