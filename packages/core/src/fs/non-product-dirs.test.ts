/**
 * non-product-dirs.test.ts — the agreement between the shared
 * "not product source" core and every walk that extends it (#3487).
 *
 * Two halves:
 *   1. Set contract — each of the four shipped exclusion sets is a superset of
 *      `NON_PRODUCT_DIRS`, and each keeps its own legitimate extras. Drift now
 *      fails here instead of being found by measurement a year later, which is
 *      how #2953 updated three walks and missed the fourth (#3481).
 *   2. Acceptance — a `.claude/` directory containing a nested checkout is not
 *      enumerated by any of the four walks.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodebaseMap, SKIP_DIRS } from "../codebase/default-extractor.js";
import { DEFAULT_EXCLUDES, iterSourceFiles } from "../release/build-dist.js";
import { evaluate, EXCLUDE_DIRS as LINK_EXCLUDE_DIRS } from "../validate-content/validate-links.js";
import { EXCLUDE_DIRS as STUB_EXCLUDE_DIRS, sortedRglob } from "../verify-source/verify-stubs.js";
import {
  AGENT_HOST_WORKING_DIRS,
  AGENT_SCRATCH_DIRS,
  NON_PRODUCT_DIRS,
} from "./non-product-dirs.js";

const SHIPPED_SETS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ["verify-source/verify-stubs EXCLUDE_DIRS", STUB_EXCLUDE_DIRS],
  ["validate-content/validate-links EXCLUDE_DIRS", LINK_EXCLUDE_DIRS],
  ["codebase/default-extractor SKIP_DIRS", SKIP_DIRS],
  ["release/build-dist DEFAULT_EXCLUDES", DEFAULT_EXCLUDES],
];

/**
 * Repo root with one real source file per walk plus a Claude Code agent
 * worktree — a full nested checkout under `.claude/worktrees/<agent-id>`.
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "non-product-dirs-"));

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.py"), "def main():\n    return 1\n", "utf8");
  writeFileSync(join(root, "src", "notes.md"), "See [app](./app.py).\n", "utf8");

  const nested = join(root, ".claude", "worktrees", "agent-1", "src");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".claude", "settings.local.json"), "{}\n", "utf8");
  writeFileSync(join(nested, "agent-only.py"), "def helper():\n    return 2\n", "utf8");
  // Deliberately broken link: if the link walk descends here, it reports.
  writeFileSync(join(nested, "agent-only.md"), "See [gone](./does-not-exist.md).\n", "utf8");

  return root;
}

describe("NON_PRODUCT_DIRS shared core (#3487)", () => {
  it("carries the agent-host working directory every walk was missing", () => {
    expect(AGENT_HOST_WORKING_DIRS).toContain(".claude");
    expect(NON_PRODUCT_DIRS.has(".claude")).toBe(true);
  });

  it("keeps the swarm scratch roots #2953 added", () => {
    for (const dir of AGENT_SCRATCH_DIRS) {
      expect(NON_PRODUCT_DIRS.has(dir)).toBe(true);
    }
    expect(AGENT_SCRATCH_DIRS).toEqual([".deft-scratch", "swarm-worktrees"]);
  });

  it("does not invent host directories without evidence", () => {
    // `.openclaw` is a $HOME state dir; a project-level one is forbidden by
    // content/docs/openclaw-agent-host.md. `.cursor` / `.grok` / `.codex` /
    // `.github` hold committed Directive deposits, not working state.
    for (const dir of [".openclaw", ".claw", ".cursor", ".grok", ".codex", ".github"]) {
      expect(NON_PRODUCT_DIRS.has(dir)).toBe(false);
    }
  });

  it("holds only basenames that are never product source", () => {
    // A name merely uninteresting to one gate belongs to that gate's own set.
    for (const dir of ["tests", "specs", "scripts", "history", "vendor", ".planning", "build"]) {
      expect(NON_PRODUCT_DIRS.has(dir)).toBe(false);
    }
  });
});

describe("shipped exclusion sets agree on the shared core (#3487)", () => {
  for (const [label, set] of SHIPPED_SETS) {
    it(`${label} contains every NON_PRODUCT_DIRS entry`, () => {
      const missing = [...NON_PRODUCT_DIRS].filter((dir) => !set.has(dir));
      expect(missing).toEqual([]);
    });
  }

  it("preserves each walk's own extras", () => {
    for (const dir of ["tests", "vendor", "history", "scripts"]) {
      expect(STUB_EXCLUDE_DIRS.has(dir)).toBe(true);
    }
    for (const dir of [".planning", "specs"]) {
      expect(LINK_EXCLUDE_DIRS.has(dir)).toBe(true);
    }
    expect(SKIP_DIRS.has("build")).toBe(true);
    for (const dir of ["htmlcov", "coverage", ".coverage"]) {
      expect(DEFAULT_EXCLUDES.has(dir)).toBe(true);
    }
  });

  it("does not leak one walk's extras into another", () => {
    expect(LINK_EXCLUDE_DIRS.has("tests")).toBe(false);
    expect(STUB_EXCLUDE_DIRS.has("specs")).toBe(false);
    expect(DEFAULT_EXCLUDES.has("tests")).toBe(false);
    expect(SKIP_DIRS.has("scripts")).toBe(false);
  });
});

describe("a .claude agent worktree is not enumerated (#3487 acceptance)", () => {
  it("verify:stubs sortedRglob skips it", () => {
    const entries = sortedRglob(makeFixture());
    expect(entries).toContain("src/app.py");
    expect(entries.filter((rel) => rel.startsWith(".claude"))).toEqual([]);
  });

  it("build-dist iterSourceFiles skips it", () => {
    const rels = iterSourceFiles(makeFixture()).map((entry) => entry.archiveRel);
    expect(rels).toContain("src/app.py");
    expect(rels.filter((rel) => rel.startsWith(".claude"))).toEqual([]);
  });

  it("validate:links does not report the nested checkout's broken link", () => {
    const result = evaluate({ cwd: makeFixture(), strict: true });
    expect(result.code).toBe(0);
    expect(result.message).not.toContain("agent-only.md");
  });

  it("the codebase extractor maps no module from it", () => {
    const serialized = JSON.stringify(buildCodebaseMap(makeFixture()));
    expect(serialized).toContain("src/app.py");
    expect(serialized).not.toContain("agent-only.py");
    expect(serialized).not.toContain(".claude");
  });
});
