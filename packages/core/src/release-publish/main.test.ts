import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG_ERROR } from "../release/constants.js";
import { RELEASE_PUBLISH_HELP } from "./constants.js";
import { cmdReleasePublish } from "./main.js";
import * as pipeline from "./pipeline.js";

describe("cmdReleasePublish", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(cmdReleasePublish(["--help"])).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toBe(RELEASE_PUBLISH_HELP);
  });

  it("invalid version exits 2", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleasePublish(["not-a-version"])).toBe(EXIT_CONFIG_ERROR);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Invalid version");
  });

  it("missing version exits 2", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleasePublish([])).toBe(EXIT_CONFIG_ERROR);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("arguments are required: version");
  });

  it("unknown args exit 2", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdReleasePublish(["0.21.0", "--bogus"])).toBe(EXIT_CONFIG_ERROR);
  });

  it("dry-run delegates to runPublish", () => {
    const spy = vi.spyOn(pipeline, "runPublish").mockReturnValue(0);
    expect(cmdReleasePublish(["0.21.0", "--dry-run", "--repo", "deftai/directive"], {})).toBe(0);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      version: "0.21.0",
      repo: "deftai/directive",
      dryRun: true,
    });
  });
});
