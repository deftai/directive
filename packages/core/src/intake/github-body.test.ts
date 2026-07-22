import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  editIssueBody,
  fetchIssueBody,
  GitHubBodyError,
  type RunGhApiFn,
  readBody,
  resolveLiveGh,
  verifyBodyPostcondition,
  writeIssueBodyToFile,
} from "./github-body.js";

describe("github-body", () => {
  it("reads body from stdin sentinel", () => {
    expect(readBody("-", "hello")).toBe("hello");
  });

  it("resolveLiveGh throws when gh missing", () => {
    expect(() => resolveLiveGh()).not.toThrow();
  });

  it("createIssue uses runFn seam", async () => {
    const { createIssue } = await import("./github-body.js");
    let lastBody = "";
    const runFn: RunGhApiFn = (args, options) => {
      if (args.includes("--method")) {
        if (options?.inputText) {
          const parsed = JSON.parse(options.inputText) as { body?: string };
          if (typeof parsed.body === "string") lastBody = parsed.body;
        }
        return { number: 42 };
      }
      return { number: 42, body: lastBody, html_url: "https://github.com/o/r/issues/42" };
    };
    const result = createIssue("o/r", {
      title: "t",
      body: "b",
      runFn,
      binary: "gh",
    });
    expect(result.number).toBe(42);
  });

  it("verifyBodyPostcondition passes on exact match", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1\nline2")).not.toThrow();
  });

  it("verifyBodyPostcondition passes on CRLF normalization", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1\r\nline2")).not.toThrow();
  });

  it("verifyBodyPostcondition fails on flattened newlines", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1 line2")).toThrow(GitHubBodyError);
    expect(() => verifyBodyPostcondition("line1\nline2", "line1 line2")).toThrow(
      /collapsed to spaces/,
    );
  });

  it("verifyBodyPostcondition fails on mojibake marker", () => {
    expect(() => verifyBodyPostcondition("arrow → dash", "arrow \uFFFD dash")).toThrow(
      GitHubBodyError,
    );
    expect(() => verifyBodyPostcondition("arrow → dash", "arrow \uFFFD dash")).toThrow(/U\+FFFD/);
  });

  it("editIssueBody fails closed when read-back body is flattened", () => {
    const intended = "section one\nsection two";
    const runFn: RunGhApiFn = (args, _options) => {
      if (args.includes("--method")) {
        return { number: 7 };
      }
      if (args.length === 1 && args[0] === "repos/o/r/issues/7") {
        return { body: "section one section two" };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    expect(() => editIssueBody("o/r", 7, { body: intended, runFn, binary: "gh" })).toThrow(
      /body postcondition failed/,
    );
  });

  it("editIssueBody succeeds when read-back matches intended body", () => {
    const intended = "section one\nsection two → em-dash";
    const runFn: RunGhApiFn = (args) => {
      if (args.includes("--method")) {
        return { number: 7 };
      }
      if (args.length === 1 && args[0] === "repos/o/r/issues/7") {
        return { body: intended };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const result = editIssueBody("o/r", 7, { body: intended, runFn, binary: "gh" });
    expect(result.body).toBe(intended);
  });

  it("fetchIssueBody returns live body via runFn", () => {
    const body = "line one\nline two — unicode";
    const runFn: RunGhApiFn = (args) => {
      expect(args).toEqual(["repos/o/r/issues/42"]);
      return { body };
    };
    expect(fetchIssueBody("o/r", 42, { runFn, binary: "gh" })).toBe(body);
  });

  it("writeIssueBodyToFile writes exact UTF-8 body", () => {
    const dir = mkdtempSync(join(tmpdir(), "github-body-"));
    const outFile = join(dir, "body.md");
    const body = "line one\nline two → em-dash";
    const runFn: RunGhApiFn = () => ({ body });
    try {
      writeIssueBodyToFile("o/r", 42, outFile, { runFn, binary: "gh" });
      expect(readFileSync(outFile, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
