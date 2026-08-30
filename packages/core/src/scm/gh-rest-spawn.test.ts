import { describe, expect, it } from "vitest";
import { GhRestError, type GhSpawnFn, type GhSpawnResult, runGhApi } from "./gh-rest.js";

const bothPresent = (name: string) => `/usr/bin/${name}`;

function fakeResult(partial: GhSpawnResult): GhSpawnResult {
  return {
    status: partial.status,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    error: partial.error,
  };
}

describe("runGhApi call-shape and spawn fallback (#3737)", () => {
  it("routes a mutation to gh even when ghx is on PATH", () => {
    const seen: string[] = [];
    const spawnFn: GhSpawnFn = (command) => {
      seen.push(command);
      return fakeResult({ status: 0, stdout: "{}" });
    };
    runGhApi(["repos/o/r/issues", "--method", "POST", "--input", "x.json"], {
      whichFn: bothPresent,
      spawnFn,
    });
    expect(seen).toEqual(["gh"]);
  });

  it("routes a flag-rich GET to gh even when ghx is on PATH", () => {
    const seen: string[] = [];
    const spawnFn: GhSpawnFn = (command) => {
      seen.push(command);
      return fakeResult({ status: 0, stdout: "[]" });
    };
    runGhApi(["repos/o/r/issues", "--method", "GET", "--raw-field", "state=open"], {
      whichFn: bothPresent,
      spawnFn,
    });
    expect(seen).toEqual(["gh"]);
  });

  it("keeps ghx for a single-path GET when both binaries exist", () => {
    const seen: string[] = [];
    const spawnFn: GhSpawnFn = (command) => {
      seen.push(command);
      return fakeResult({ status: 0, stdout: "{}" });
    };
    runGhApi(["repos/o/r/issues/1"], { whichFn: bothPresent, spawnFn });
    expect(seen).toEqual(["ghx"]);
  });

  it("falls back to gh on a simulated ghx spawn failure", () => {
    const seen: string[] = [];
    const spawnFn: GhSpawnFn = (command) => {
      seen.push(command);
      if (command === "ghx") {
        return fakeResult({
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn ghx ENOENT"), { code: "ENOENT" }),
        });
      }
      return fakeResult({ status: 0, stdout: '{"ok":true}' });
    };
    const result = runGhApi(["repos/o/r/issues/1"], { whichFn: bothPresent, spawnFn });
    expect(seen).toEqual(["ghx", "gh"]);
    expect(result.binary).toBe("gh");
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("does not fall back on an HTTP error from ghx", () => {
    const seen: string[] = [];
    const spawnFn: GhSpawnFn = (command) => {
      seen.push(command);
      return fakeResult({ status: 1, stdout: "", stderr: "HTTP 422" });
    };
    const result = runGhApi(["repos/o/r/issues/1"], { whichFn: bothPresent, spawnFn });
    expect(seen).toEqual(["ghx"]);
    expect(result.binary).toBe("ghx");
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("HTTP 422");
  });
});

describe("GhRestError diagnostic (#3737)", () => {
  it("names the binary and STATUS_DLL_INIT_FAILED without reproducing the loader fault", () => {
    const err = new GhRestError({
      stderr: "",
      exitCode: 3221225794,
      endpoint: "repos/o/r/issues/1",
      payload: null,
      binary: "ghx",
    });
    expect(err.message).toContain("ghx");
    expect(err.message).toContain("0xC0000142 STATUS_DLL_INIT_FAILED");
    expect(err.binary).toBe("ghx");
  });
});
