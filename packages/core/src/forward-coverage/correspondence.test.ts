import { describe, expect, it } from "vitest";
import { defaultTestBoundaryPolicy } from "../test-boundary/policy.js";
import {
  expectedTestPaths,
  fillRootTemplate,
  isDirectoryShapedRoot,
  stripSourceRoot,
} from "./correspondence.js";
import type { ForwardCoverageOptions } from "./evaluate.js";

const policy = defaultTestBoundaryPolicy("warn");

describe("stripSourceRoot", () => {
  it("strips src/** to the remainder", () => {
    expect(stripSourceRoot("src/ui/ledger-table/index.ts", "src/**")).toEqual({
      remainder: "ui/ledger-table/index.ts",
      captures: [],
      consumed: 1,
    });
  });

  it("captures packages/*/src stars", () => {
    expect(stripSourceRoot("packages/core/src/foo.ts", "packages/*/src/**")).toEqual({
      remainder: "foo.ts",
      captures: ["core"],
      consumed: 3,
    });
  });

  it("returns null when the path is outside the root", () => {
    expect(stripSourceRoot("scripts/thing.py", "src/**")).toBeNull();
  });

  it("matches a question-mark glob segment via the shared policy matcher", () => {
    expect(stripSourceRoot("pkg/core/src/foo.ts", "pkg/c?re/src/**")).toEqual({
      remainder: "foo.ts",
      captures: [],
      consumed: 3,
    });
  });

  it("strips a mid-path double-star source root", () => {
    expect(stripSourceRoot("packages/foo/src/bar.ts", "packages/**/src/**")).toEqual({
      remainder: "bar.ts",
      captures: ["foo"],
      consumed: 3,
    });
  });

  it("backtracks when an earlier double-star follower match would fail", () => {
    expect(stripSourceRoot("packages/src/other/src/foo/bar.ts", "packages/**/src/foo/**")).toEqual({
      remainder: "bar.ts",
      captures: ["src/other"],
      consumed: 5,
    });
  });
});

describe("fillRootTemplate", () => {
  it("fills packages/*/test from a captured package name", () => {
    expect(fillRootTemplate("packages/*/test/**", ["core"])).toBe("packages/core/test");
  });

  it("returns a starless prefix when captures are empty", () => {
    expect(fillRootTemplate("tests/**", [])).toBe("tests");
  });

  it("refuses a star-count mismatch", () => {
    expect(fillRootTemplate("packages/*/test/**", [])).toBeNull();
  });

  it("fills a mid-path double-star test root", () => {
    expect(fillRootTemplate("packages/**/test/**", ["foo"])).toBe("packages/foo/test");
  });
});

describe("isDirectoryShapedRoot", () => {
  it("keeps tests/** and drops file-pattern roots", () => {
    expect(isDirectoryShapedRoot("tests/**")).toBe(true);
    expect(isDirectoryShapedRoot("packages/*/src/**/*.test.*")).toBe(false);
    expect(isDirectoryShapedRoot("**/*_test.go")).toBe(false);
  });
});

describe("expectedTestPaths", () => {
  it("searches colocated, __tests__, and tests/ for a src file", () => {
    const paths = expectedTestPaths("src/ui/ledger-table/index.ts", policy);
    expect(paths).toContain("src/ui/ledger-table/index.test.ts");
    expect(paths).toContain("src/ui/ledger-table/__tests__/index.test.ts");
    expect(paths).toContain("tests/ui/ledger-table/index.test.ts");
    expect(paths).not.toContain("index.test.ts");
  });

  it("maps packages/*/src onto packages/*/test", () => {
    const paths = expectedTestPaths("packages/core/src/forward-coverage/evaluate.ts", policy);
    expect(paths).toContain("packages/core/src/forward-coverage/evaluate.test.ts");
    expect(paths).toContain("packages/core/test/forward-coverage/evaluate.test.ts");
  });

  it("maps a mid-path double-star source root onto the matching test root", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/**/src/**"],
      testRoots: ["packages/**/test/**"],
    };
    const paths = expectedTestPaths("packages/foo/src/bar.ts", custom);
    expect(paths).toContain("packages/foo/src/bar.test.ts");
    expect(paths).toContain("packages/foo/test/bar.test.ts");
  });

  it("maps a double-star root after backtracking past an earlier follower match", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/**/src/foo/**"],
      testRoots: ["packages/**/test/foo/**"],
    };
    const paths = expectedTestPaths("packages/src/other/src/foo/bar.ts", custom);
    expect(paths).toContain("packages/src/other/src/foo/bar.test.ts");
    expect(paths).toContain("packages/src/other/test/foo/bar.test.ts");
  });

  it("mirrors the full path under tests/ when no source root matches", () => {
    const paths = expectedTestPaths("scripts/thing.py", policy);
    expect(paths).toContain("scripts/test_thing.py");
    expect(paths).toContain("tests/scripts/test_thing.py");
    expect(paths).not.toContain("tests/test_thing.py");
  });
});

describe("ForwardCoverageOptions", () => {
  it("does not declare a second testRoots field", () => {
    type HasTestRoots = "testRoots" extends keyof ForwardCoverageOptions ? true : false;
    const has: HasTestRoots = false;
    expect(has).toBe(false);
  });
});
