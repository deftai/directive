import { describe, expect, it } from "vitest";
import {
  checkVbriefLifecycleSync,
  refreshRoadmap,
  runBuild,
  runCi,
  runUvLock,
} from "./python-bridge.js";
import type { ReleaseSeams } from "./types.js";

describe("python-bridge with mocked spawn", () => {
  it("runCi succeeds on exit 0", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok, msg] = runCi("/proj", "/scripts", seams);
    expect(ok).toBe(true);
    expect(msg).toBe("ran ci:local");
  });

  it("runCi fails on non-zero", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "fail" }),
    };
    const [ok] = runCi("/proj", "/scripts", seams);
    expect(ok).toBe(false);
  });

  it("refreshRoadmap succeeds", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok] = refreshRoadmap("/proj", "/scripts", seams);
    expect(ok).toBe(true);
  });

  it("refreshRoadmap fails", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "render err" }),
    };
    const [ok, msg] = refreshRoadmap("/proj", "/scripts", seams);
    expect(ok).toBe(false);
    expect(msg).toContain("roadmap:render failed");
  });

  it("runBuild succeeds with version env", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok, msg] = runBuild("/proj", "/scripts", "0.21.0", seams);
    expect(ok).toBe(true);
    expect(msg).toContain("DEFT_RELEASE_VERSION=0.21.0");
  });

  it("runBuild fails", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 2, stdout: "", stderr: "" }),
    };
    const [ok] = runBuild("/proj", "/scripts", null, seams);
    expect(ok).toBe(false);
  });

  it("checkVbriefLifecycleSync parses JSON ok", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify({ ok: true, mismatch_count: 0, reason: "no mismatches" }),
        stderr: "",
      }),
    };
    expect(checkVbriefLifecycleSync("/p", "r", "/scripts", seams)).toEqual([
      true,
      0,
      "no mismatches",
    ]);
  });

  it("checkVbriefLifecycleSync parses mismatch JSON", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({
        status: 0,
        stdout: JSON.stringify({ ok: false, mismatch_count: 1, reason: "drift" }),
        stderr: "",
      }),
    };
    const [ok, count, reason] = checkVbriefLifecycleSync("/p", "r", "/scripts", seams);
    expect(ok).toBe(false);
    expect(count).toBe(1);
    expect(reason).toBe("drift");
  });

  it("checkVbriefLifecycleSync handles invalid JSON", () => {
    const seams: ReleaseSeams = {
      spawnText: () => ({ status: 0, stdout: "not json", stderr: "" }),
    };
    const [ok, count] = checkVbriefLifecycleSync("/p", "r", "/scripts", seams);
    expect(ok).toBe(false);
    expect(count).toBe(-1);
  });

  it("runUvLock succeeds", () => {
    const seams: ReleaseSeams = {
      fileExists: () => true,
      whichUv: () => "/usr/bin/uv",
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok] = runUvLock("/proj", seams);
    expect(ok).toBe(true);
  });
});
