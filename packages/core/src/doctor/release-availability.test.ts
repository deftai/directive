import { describe, expect, it } from "vitest";
import { evaluateReleaseAvailability } from "./release-availability.js";

describe("release availability (#1692)", () => {
  it("reports a newer stable release", () => {
    expect(evaluateReleaseAvailability("v1.2.3", "1.3.0")).toEqual({
      status: "available",
      installedVersion: "1.2.3",
      latestVersion: "1.3.0",
      resolver: "npm-view",
    });
  });

  it.each([
    ["v1.2.3", "1.2.3"],
    ["v1.3.0", "1.2.3"],
  ])("reports %s as current against %s", (installed, latest) => {
    expect(evaluateReleaseAvailability(installed, latest).status).toBe("current");
  });

  it("does not direct a stable install to a prerelease", () => {
    expect(evaluateReleaseAvailability("1.2.3", "1.3.0-rc.1")).toMatchObject({
      status: "prerelease-ignored",
      installedVersion: "1.2.3",
      latestVersion: "1.3.0-rc.1",
    });
  });

  it("directs a prerelease install to the corresponding stable release", () => {
    expect(evaluateReleaseAvailability("1.3.0-rc.2", "1.3.0")).toMatchObject({
      status: "available",
      installedVersion: "1.3.0-rc.2",
      latestVersion: "1.3.0",
    });
  });

  it("treats branch pins as not applicable", () => {
    expect(evaluateReleaseAvailability("master", "1.3.0")).toMatchObject({
      status: "not-applicable",
      installedVersion: null,
      latestVersion: "1.3.0",
    });
  });

  it.each([
    null,
    "",
    "not-a-release",
    "1.3.0-test.1",
  ])("reports an unavailable latest version as unverified: %s", (latest) => {
    expect(evaluateReleaseAvailability("1.2.3", latest)).toMatchObject({
      status: "unverified",
      installedVersion: "1.2.3",
      latestVersion: null,
    });
  });
});
