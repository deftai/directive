import { describe, expect, it } from "vitest";
import { dispatch } from "../dispatch.js";
import { run as runRelease } from "../release.js";
import { run as runReleaseE2e } from "../release-e2e.js";
import { run as runReleasePublish } from "../release-publish.js";
import { run as runReleaseRollback } from "../release-rollback.js";
import { muteProcessStreams, silentIo } from "./helpers.js";

describe("deft-ts release:* dispatcher (#1838 s4)", () => {
  it("release --help exits 0 via the dispatcher", async () => {
    expect(await dispatch(["release", "--help"], silentIo())).toBe(0);
    expect(await dispatch(["release-publish", "--help"], silentIo())).toBe(0);
    expect(await dispatch(["release-rollback", "--help"], silentIo())).toBe(0);
    expect(await dispatch(["release-e2e", "--help"], silentIo())).toBe(0);
  });

  it("release rejects invalid version with exit 2", async () => {
    expect(await dispatch(["release", "not-a-version"], silentIo())).toBe(2);
  });

  it("release rejects missing version with exit 2", async () => {
    expect(await dispatch(["release", "--dry-run"], silentIo())).toBe(2);
  });

  it("release rejects unknown flags with exit 2", async () => {
    expect(await dispatch(["release", "1.0.0", "--totally-unknown"], silentIo())).toBe(2);
  });

  it("release-publish rejects missing version with exit 2", async () => {
    expect(await dispatch(["release-publish", "--dry-run"], silentIo())).toBe(2);
  });

  it("release-rollback rejects missing version with exit 2", async () => {
    expect(await dispatch(["release-rollback"], silentIo())).toBe(2);
  });

  it("release-e2e rejects unknown flags with exit 2", async () => {
    expect(await dispatch(["release-e2e", "--bogus"], silentIo())).toBe(2);
  });

  it("CLI wrappers mirror python exit codes for argv errors", () => {
    expect(muteProcessStreams(() => runRelease(["not-a-version"]))).toBe(2);
    expect(muteProcessStreams(() => runReleasePublish(["--dry-run"]))).toBe(2);
    expect(muteProcessStreams(() => runReleaseRollback([]))).toBe(2);
    expect(muteProcessStreams(() => runReleaseE2e(["--nope"]))).toBe(2);
  });
});
