/**
 * #5837 Prefer-A: tracked divergent managed hooks are preserved (non-failure);
 * replace only when untracked or with explicit operator force.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitHooks, isGitTrackedPath, PRE_PUSH_BOUND_PRE_PR_MARKER } from "./setup-wiring.js";

const TEMPS: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-tracked-hooks-"));
  TEMPS.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** Consumer-customized managed hook (sources the shared helper). */
const CUSTOM_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

const LEGACY_HELPER = `#!/usr/bin/env sh
run_deft() { deft "$@"; }
`;

function writeHook(root: string, rel: string, body: string): void {
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
}

function track(root: string, rel: string): void {
  execFileSync("git", ["add", "--", rel], { cwd: root });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("ensureGitHooks tracked divergent preserve (#5837)", () => {
  it("keeps a git-tracked managed pre-push and discloses it as preserved, not a conflict", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/pre-push", CUSTOM_PRE_PUSH);
    track(root, ".githooks/pre-push");
    const out = ensureGitHooks(root);
    expect(readFileSync(join(root, ".githooks/pre-push"), "utf8")).toBe(CUSTOM_PRE_PUSH);
    expect(out.modified).not.toContain(".githooks/pre-push");
    expect(out.conflicts).toEqual([]);
    expect(out.preserved.join("\n")).toContain(".githooks/pre-push");
  });

  it("replaces an untracked divergent managed hook (lawful replace path)", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/pre-push", CUSTOM_PRE_PUSH);
    const out = ensureGitHooks(root);
    expect(readFileSync(join(root, ".githooks/pre-push"), "utf8")).not.toBe(CUSTOM_PRE_PUSH);
    expect(out.modified).toContain(".githooks/pre-push");
    expect(out.preserved).toEqual([]);
  });

  it("replaces a tracked divergent managed hook only with explicit operator force", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/pre-push", CUSTOM_PRE_PUSH);
    track(root, ".githooks/pre-push");
    const out = ensureGitHooks(root, { forceTrackedReplace: true });
    expect(readFileSync(join(root, ".githooks/pre-push"), "utf8")).not.toBe(CUSTOM_PRE_PUSH);
    expect(out.modified).toContain(".githooks/pre-push");
    expect(out.preserved).toEqual([]);
  });

  it("is idempotent: a second run over the preserved tree writes nothing", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/pre-push", CUSTOM_PRE_PUSH);
    track(root, ".githooks/pre-push");
    ensureGitHooks(root);
    const second = ensureGitHooks(root);
    expect(second.modified).not.toContain(".githooks/pre-push");
    expect(readFileSync(join(root, ".githooks/pre-push"), "utf8")).toBe(CUSTOM_PRE_PUSH);
  });

  it("keeps a tracked legacy _deft-run.sh helper instead of deleting it", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/_deft-run.sh", LEGACY_HELPER);
    track(root, ".githooks/_deft-run.sh");
    const out = ensureGitHooks(root);
    expect(existsSync(join(root, ".githooks/_deft-run.sh"))).toBe(true);
    expect(out.preserved.join("\n")).toContain(".githooks/_deft-run.sh");
    expect(out.conflicts).toEqual([]);
  });

  it("still removes an untracked legacy helper", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/_deft-run.sh", LEGACY_HELPER);
    ensureGitHooks(root);
    expect(existsSync(join(root, ".githooks/_deft-run.sh"))).toBe(false);
  });

  it("force never bypasses refuse-to-downgrade (#5804 / #5885)", () => {
    const root = tempRepo();
    const enrolled = `${CUSTOM_PRE_PUSH}# ${PRE_PUSH_BOUND_PRE_PR_MARKER}\n`;
    writeHook(root, ".githooks/pre-push", enrolled);
    track(root, ".githooks/pre-push");
    // Tip PRE_PUSH already carries the marker; inject a marker-free next body so
    // forceTrackedReplace reaches the refuse-to-downgrade branch (#5885 P2).
    const out = ensureGitHooks(root, {
      forceTrackedReplace: true,
      testOnlyNextBodyByRel: { ".githooks/pre-push": CUSTOM_PRE_PUSH },
    });
    const body = readFileSync(join(root, ".githooks/pre-push"), "utf8");
    expect(body).toBe(enrolled);
    expect(out.modified).not.toContain(".githooks/pre-push");
    expect(out.conflicts.some((c) => c.includes("refuse-to-downgrade"))).toBe(true);
    expect(out.preserved).toEqual([]);
  });

  it("isGitTrackedPath reads false outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "setup-tracked-nogit-"));
    TEMPS.push(root);
    expect(isGitTrackedPath(root, ".githooks/pre-push")).toBe(false);
  });
});
