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

  it("strips consecutive trailing globstars to a usable remainder", () => {
    expect(stripSourceRoot("packages/foo/bar.ts", "packages/**/**")).toEqual({
      remainder: "foo/bar.ts",
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
      captures: ["core"],
      consumed: 3,
    });
  });

  it("matches a character-class glob segment via the shared policy matcher", () => {
    expect(stripSourceRoot("pkg/core/src/foo.ts", "pkg/c[ao]re/src/**")).toEqual({
      remainder: "foo.ts",
      captures: ["core"],
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

  it("keeps the first successful double-star alignment when several src segments match", () => {
    expect(stripSourceRoot("packages/pkg/src/sub/src/file.ts", "packages/**/src/**")).toEqual({
      remainder: "sub/src/file.ts",
      captures: ["pkg"],
      consumed: 3,
    });
  });

  it("captures consecutive double-stars as non-empty segments", () => {
    expect(stripSourceRoot("packages/foo/bar/src/file.ts", "packages/**/**/src/**")).toEqual({
      remainder: "file.ts",
      captures: ["foo", "bar"],
      consumed: 4,
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

  it("fills a question-mark test root from the captured segment", () => {
    expect(fillRootTemplate("pkg/c?re/test/**", ["core"])).toBe("pkg/core/test");
  });

  it("rejects a capture that does not match a constrained test-root glob", () => {
    expect(fillRootTemplate("pkg/c?re/test/**", ["foo"])).toBeNull();
  });

  it("fills a character-class test root from the captured segment", () => {
    expect(fillRootTemplate("pkg/c[ao]re/test/**", ["core"])).toBe("pkg/core/test");
  });

  it("fills two single-star test slots from consecutive double-star captures", () => {
    expect(fillRootTemplate("packages/*/*/test/**", ["foo", "bar"])).toBe("packages/foo/bar/test");
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

  it("maps a question-mark source root onto the matching test root", () => {
    const custom = {
      ...policy,
      sourceRoots: ["pkg/c?re/src/**"],
      testRoots: ["pkg/c?re/test/**"],
    };
    const paths = expectedTestPaths("pkg/core/src/foo.ts", custom);
    expect(paths).toContain("pkg/core/src/foo.test.ts");
    expect(paths).toContain("pkg/core/test/foo.test.ts");
    expect(paths).not.toContain("pkg/c?re/test/foo.test.ts");
  });

  it("maps a character-class source root onto the matching test root", () => {
    const custom = {
      ...policy,
      sourceRoots: ["pkg/c[ao]re/src/**"],
      testRoots: ["pkg/c[ao]re/test/**"],
    };
    const paths = expectedTestPaths("pkg/core/src/foo.ts", custom);
    expect(paths).toContain("pkg/core/test/foo.test.ts");
    expect(paths).not.toContain("pkg/c[ao]re/test/foo.test.ts");
  });

  it("maps the shallow double-star source root when a later src also matches", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/**/src/**"],
      testRoots: ["packages/**/test/**"],
    };
    const paths = expectedTestPaths("packages/pkg/src/sub/src/file.ts", custom);
    expect(paths).toContain("packages/pkg/test/sub/src/file.test.ts");
    expect(paths).not.toContain("packages/pkg/src/sub/test/file.test.ts");
  });

  it("maps consecutive double-star source roots onto two single-star test slots", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/**/**/src/**"],
      testRoots: ["packages/*/*/test/**"],
    };
    const paths = expectedTestPaths("packages/foo/bar/src/file.ts", custom);
    expect(paths).toContain("packages/foo/bar/test/file.test.ts");
    expect(paths).not.toContain("packages//foo/bar/test/file.test.ts");
  });

  it("keeps candidates from overlapping source roots with different capture shapes", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/core/src/**", "packages/*/src/**"],
      testRoots: ["tests/**", "packages/*/test/**"],
    };
    const paths = expectedTestPaths("packages/core/src/foo.ts", custom);
    expect(paths).toContain("tests/foo.test.ts");
    expect(paths).toContain("packages/core/test/foo.test.ts");
  });

  it("still searches a starless test root when the source root captured a star", () => {
    const custom = {
      ...policy,
      sourceRoots: ["packages/*/src/**"],
      testRoots: ["tests/**"],
    };
    const paths = expectedTestPaths("packages/core/src/foo.ts", custom);
    expect(paths).toContain("tests/foo.test.ts");
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
