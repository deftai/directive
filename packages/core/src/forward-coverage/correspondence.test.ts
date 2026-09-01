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
