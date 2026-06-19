import { describe, expect, it } from "vitest";
import { type RunGhApiFn, readBody, resolveLiveGh } from "./github-body.js";

describe("github-body", () => {
  it("reads body from stdin sentinel", () => {
    expect(readBody("-", "hello")).toBe("hello");
  });

  it("resolveLiveGh throws when gh missing", () => {
    expect(() => resolveLiveGh()).not.toThrow();
  });

  it("createIssue uses runFn seam", async () => {
    const { createIssue } = await import("./github-body.js");
    const runFn: RunGhApiFn = (args) => {
      if (args.length === 1) {
        return { number: 42, html_url: "https://github.com/o/r/issues/42" };
      }
      return { number: 42 };
    };
    const result = createIssue("o/r", {
      title: "t",
      body: "b",
      runFn,
      binary: "gh",
    });
    expect(result.number).toBe(42);
  });
});
