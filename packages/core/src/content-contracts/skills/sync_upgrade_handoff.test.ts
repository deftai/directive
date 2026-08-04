import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill } from "./helpers.js";

/**
 * #1604 — upgrade workflow SCM release handoff after successful deposit.
 * Stop-after-local-commit is a failure mode; terminal states must be named;
 * human-merge path must not claim `released` without merge.
 */

const SYNC_PATH = "skills/deft-directive-sync/SKILL.md";
const UPGRADING_PATH = "UPGRADING.md";

function readSync(): string {
  return readSkill(SYNC_PATH);
}

function phase8Section(): string {
  const text = readSync();
  const start = text.indexOf("## Phase 8 -- SCM release handoff");
  expect(start).not.toBe(-1);
  const anti = text.indexOf("## Anti-Patterns", start);
  expect(anti).not.toBe(-1);
  return text.slice(start, anti);
}

describe("sync upgrade handoff (#1604)", () => {
  it("leads with npm + directive/deft update as primary path", () => {
    const text = readSync();
    expect(text).toContain("npm i -g @deftai/directive@latest");
    expect(text).toMatch(/directive update|deft update/);
    expect(text).toContain("Phase 0 -- Primary upgrade");
    // Submodule is demoted, not primary
    expect(text).toMatch(/Legacy \/ back-compat only/i);
    expect(text).toContain("not the primary consumer upgrade path");
  });

  it("does not force upgrade on routine good-morning without consent", () => {
    const text = readSync();
    expect(text).toContain("When mutation is authorized");
    expect(text).toMatch(/good morning/i);
    expect(text).toMatch(
      /\u2297 Run `npm i -g @deftai\/directive@latest` or `directive update` \/ `deft update` on a routine "good morning"/,
    );
  });

  it("requires worktree isolation before deposit handoff", () => {
    const text = readSync();
    expect(text).toContain("Consumer worktree isolation before deposit");
    expect(text).toContain("git status --porcelain");
    expect(text).toContain("blocked:dirty-worktree");
    expect(text).toContain("Framework-only path allowlist");
  });

  it("names the three terminal states", () => {
    const section = phase8Section();
    expect(section).toContain("`released`");
    expect(section).toContain("`pr-open`");
    expect(section).toContain("`blocked:<reason>`");
    expect(section).toContain("upgrade-handoff:");
  });

  it("treats stop-after-commit as a failure mode", () => {
    const text = readSync();
    expect(text).toContain("Stop-after-commit is a failure mode");
    expect(text).toMatch(/local framework-only commit/i);
    // Anti-pattern must forbid silent stop after local commit
    expect(text).toMatch(
      /\u2297 Stop after a local framework-only commit without naming the next release step/,
    );
  });

  it("human-merge / branch-protected path stops at pr-open without false released", () => {
    const section = phase8Section();
    expect(section).toMatch(/requireHumanMerge|human merge/i);
    expect(section).toContain("pr-open");
    expect(section).toMatch(/\u2297 Auto-merge past `requireHumanMerge`/);
    expect(section).toMatch(
      /\u2297 Claim `released` when the PR is only open or only locally committed/,
    );
  });

  it("direct-commit path is explicit and ends at released only on default branch", () => {
    const section = phase8Section();
    expect(section).toMatch(/allowDirectCommitsToMaster|Direct-commit-enabled/i);
    expect(section).toMatch(/explicit.*default-branch|default-branch path with confirmation/i);
    expect(section).toMatch(
      /Record terminal state \*\*`released`\*\* only after the default branch/,
    );
  });

  it("missing CLI remediation is npm install not release-asset archaeology", () => {
    const text = readSync();
    expect(text).toContain("Missing CLI / PATH remediation");
    expect(text).toContain("npm i -g @deftai/directive@latest");
    expect(text).toMatch(/\u2297 Send the operator to manual GitHub release-asset archaeology/);
  });

  it("UPGRADING documents SCM release handoff terminal states", () => {
    const text = readRepoFile(UPGRADING_PATH);
    expect(text).toContain("SCM release handoff after deposit (#1604)");
    expect(text).toContain("`released`");
    expect(text).toContain("`pr-open`");
    expect(text).toContain("`blocked:<reason>`");
    expect(text).toContain("upgrade-handoff:");
    expect(text).toMatch(/requireHumanMerge|human merge gate/i);
  });

  it("Phase 7 no longer ends only at Shall I commit without handoff", () => {
    const text = readSync();
    // Old failure mode: ask to commit and stop (no Phase 8)
    expect(text).toContain("## Phase 8 -- SCM release handoff");
    expect(text).toContain("do not stop at the local change set");
    expect(text).toContain("Proceed to Phase 8");
  });
});
