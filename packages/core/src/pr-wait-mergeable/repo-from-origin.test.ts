import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatInferredRepoLine,
  formatRepoRequiredError,
  inferRepoFromOrigin,
  type OriginRepoSeam,
  readOriginRemote,
  readRepoFork,
} from "./repo-from-origin.js";

function gh(returncode: number, stdout: string, stderr = "") {
  const calls: (readonly string[])[] = [];
  const runGh = (cmd: readonly string[]) => {
    calls.push(cmd);
    return { returncode, stdout, stderr };
  };
  return { runGh, calls };
}

describe("readRepoFork (#6869 item 2)", () => {
  it("reads repos/<owner>/<name> once through REST and returns the fork flag", () => {
    const { runGh, calls } = gh(0, JSON.stringify({ full_name: "acme/project", fork: false }));
    expect(readRepoFork("acme/project", runGh)).toEqual({ fork: false, error: null });
    expect(calls).toEqual([["gh", "api", "repos/acme/project"]]);
    expect(readRepoFork("acme/project", gh(0, '{"fork": true}').runGh)).toEqual({
      fork: true,
      error: null,
    });
  });

  it("reports a failed, non-JSON or fork-less read as an error", () => {
    expect(readRepoFork("acme/project", gh(1, "", "HTTP 404\n").runGh)).toEqual({
      fork: null,
      error: "gh api repos/acme/project failed: HTTP 404",
    });
    const missingCli = () => {
      throw new Error("neither 'ghx' nor 'gh' found on PATH");
    };
    expect(readRepoFork("acme/project", missingCli)).toEqual({
      fork: null,
      error: "gh api repos/acme/project failed: neither 'ghx' nor 'gh' found on PATH",
    });
    expect(readRepoFork("acme/project", gh(0, "not json").runGh).error).toBe(
      "repos/acme/project is not JSON",
    );
    for (const body of ["[]", "{}", '{"fork": "no"}']) {
      expect(readRepoFork("acme/project", gh(0, body).runGh).error).toBe(
        "repos/acme/project has no boolean fork field",
      );
    }
  });
});

describe("readOriginRemote (#6869 item 2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "origin-6869-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    return dir;
  }

  it("returns the raw origin URL", () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/project.git"]);
    expect(readOriginRemote(dir)).toEqual({ url: "git@github.com:acme/project.git", error: null });
  });

  it("returns an error when there is no origin remote", () => {
    const read = readOriginRemote(repo());
    expect(read.url).toBeNull();
    expect(read.error).not.toBeNull();
  });
});

describe("inferRepoFromOrigin (#6869 items 2 and 3)", () => {
  function seam(url: string | null, error: string | null = null): OriginRepoSeam {
    return {
      readOriginRemote: () => ({ url, error }),
      readRepo: () => ({ fork: false, error: null }),
    };
  }

  it("infers owner/name from an http, https or ssh github.com origin", () => {
    for (const url of [
      "https://github.com/acme/project.git",
      "https://github.com/acme/project",
      "http://github.com/acme/project.git",
      "git@github.com:acme/project.git",
    ]) {
      expect(inferRepoFromOrigin("/root", seam(url))).toEqual({
        repo: "acme/project",
        reason: null,
      });
    }
  });

  it("gives a reason for an empty or unreadable origin", () => {
    expect(inferRepoFromOrigin("/root", seam("")).reason).toBe(
      "cannot read the origin remote (empty URL)",
    );
    expect(inferRepoFromOrigin("/root", seam(null, "boom")).reason).toBe(
      "cannot read the origin remote (boom)",
    );
  });

  it("formats the refusal and the inference line", () => {
    expect(formatRepoRequiredError("acme/project is a fork")).toBe(
      "Error: --repo OWNER/REPO is required (or set $GH_REPO, or run in a clone whose origin " +
        "is a non-fork github.com repository); origin: acme/project is a fork\n",
    );
    expect(formatInferredRepoLine("acme/project")).toBe(
      "pr_wait_mergeable: repo=acme/project (from origin)\n",
    );
  });
});
