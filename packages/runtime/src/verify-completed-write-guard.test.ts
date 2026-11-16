import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolvePrBody, run } from "./verify-completed-write-guard.js";

describe("verify-completed-write-guard CLI (#3679)", () => {
  it("parses defaults", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      baseRef: "",
      quiet: false,
    });
  });

  it("parses flags", () => {
    expect(
      parseArgs(["--project-root", "/root", "--base-ref", "origin/master", "--quiet"]),
    ).toMatchObject({
      projectRoot: "/root",
      baseRef: "origin/master",
      quiet: true,
    });
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--nope"])).toMatchObject({ error: "unrecognized argument: --nope" });
  });

  it("parses equals-form flags and missing values", () => {
    expect(parseArgs(["--project-root=/root", "--base-ref=origin/master"])).toMatchObject({
      projectRoot: "/root",
      baseRef: "origin/master",
    });
    expect(parseArgs(["--project-root"])).toMatchObject({
      error: "argument --project-root: expected one argument",
    });
    expect(parseArgs(["--base-ref"])).toMatchObject({
      error: "argument --base-ref: expected one argument",
    });
  });

  it("run exits 2 on parse error and 0 on a non-git root skip", () => {
    expect(run(["--nope"])).toBe(2);
    const root = mkdtempSync(join(tmpdir(), "verify-cwg-nongit-"));
    try {
      expect(run(["--project-root", root, "--quiet"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify-completed-write-guard PR body (#6277)", () => {
  it("parses --pr-body-file in both forms", () => {
    expect(parseArgs(["--pr-body-file", "b.md"])).toMatchObject({ prBodyFile: "b.md" });
    expect(parseArgs(["--pr-body-file=b.md"])).toMatchObject({ prBodyFile: "b.md" });
    expect(parseArgs(["--pr-body-file"])).toMatchObject({
      error: "argument --pr-body-file: expected one argument",
    });
  });

  it("reads the body from the file, then the pull_request event, else no PR context", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-cwg-body-"));
    try {
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "Closes #77\n", "utf8");
      expect(resolvePrBody(bodyFile, {})).toEqual({ body: "Closes #77\n" });
      expect(resolvePrBody(join(root, "missing.md"), {})).toHaveProperty("error");
      const event = join(root, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { body: "Closes #77" } }), "utf8");
      expect(
        resolvePrBody("", { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event }),
      ).toEqual({ body: "Closes #77" });
      writeFileSync(event, JSON.stringify({ pull_request: { body: null } }), "utf8");
      expect(
        resolvePrBody("", { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event }),
      ).toEqual({ body: "" });
      writeFileSync(event, "{", "utf8");
      expect(
        resolvePrBody("", { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event }),
      ).toHaveProperty("error");
      expect(resolvePrBody("", { GITHUB_EVENT_NAME: "pull_request" })).toHaveProperty("error");
      expect(resolvePrBody("", { GITHUB_EVENT_NAME: "merge_group" })).toEqual({ body: undefined });
      expect(resolvePrBody("", {})).toEqual({ body: undefined });
      expect(run(["--project-root", root, "--quiet", "--pr-body-file", bodyFile])).toBe(0);
      expect(run(["--project-root", root, "--pr-body-file", join(root, "missing.md")])).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
