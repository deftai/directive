/**
 * #5808 / #5976 / D-023: setup replaces every Directive-shaped git hook, old or
 * edited, committed or not, and names each one. A hook that is not Directive's
 * stays a named conflict. The deposited hooks run the 0.126 commit gates and the
 * refspec-aware push gate (D-021).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fingerprintContent,
  readOwnershipRecord,
} from "@deftai/directive-core/dist/install-health/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";
import {
  DIRECTIVE_GIT_HOOK_BODIES,
  ensureGitHooks,
  formatGitHookUpdated,
  isGitTrackedPath,
} from "./setup-wiring.js";

const TEMPS: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-tracked-hooks-"));
  TEMPS.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function writeHook(root: string, rel: string, body: string): void {
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
}

/** Commit hooks without running them, as a customer's history would hold them. */
function commitHooks(root: string, hooks: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(hooks)) writeHook(root, rel, body);
  git(root, "add", "--", ".githooks");
  git(root, "commit", "-q", "--no-verify", "-m", "hooks");
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

// 0.126.2 deposit (`git show v0.126.2:.githooks/*`), trimmed to the lines that matter.
const V0126_HELPER = `# Shared deft CLI resolver for .githooks/* (#2067, #2248).
run_deft() {
    _deft_local="$REPO_ROOT/packages/cli/dist/bin.js"
    if command -v deft >/dev/null 2>&1; then
        deft "$@"
        return $?
    fi
    echo "deft hooks: 'deft' not found on PATH." >&2
    exit 1
}
`;
const V0126_PRE_COMMIT = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
. "$REPO_ROOT/.githooks/_deft-run.sh"
run_deft verify:branch --project-root "$REPO_ROOT" || exit $?
run_deft verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
run_deft verify:forward-coverage --staged --project-root "$REPO_ROOT" || exit $?
`;
const V0126_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
. "$REPO_ROOT/.githooks/_deft-run.sh"
run_deft preflight-gh --pre-push-stdin --project-root "$REPO_ROOT"
exit $?
`;

// 0.127.0 thin hooks.
const V0127_PRE_COMMIT = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
`;
const V0127_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
`;

// 0.129.x pre-push with the #5804 marker and the push-admit arm.
const V0129_PRE_PUSH = `#!/usr/bin/env sh
# deft:pre-pr-bound-push-v1 — refuse-to-downgrade marker (#5804); marker-aware ensureGitHooks only
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
# Enrolled bound pre-PR arm: sole-stdin (do not redirect shared run_directive to /dev/null)
run_directive pre-pr:run --push-admit --project-root "$REPO_ROOT" || exit $?
`;
const V0129_HELPER = `#!/usr/bin/env sh
run_directive() {
  node "$REPO_ROOT/node_modules/@deftai/directive-runtime/dist/bin.js" "$@"
}
`;

const FOREIGN_PRE_COMMIT = `#!/usr/bin/env sh
npx prettier --check .
`;

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("deposited git-hook templates (#5808 / D-021)", () => {
  it("pre-commit runs the 0.126 gates through run_directive, brief gates behind a folder test", () => {
    const body = DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-commit"] ?? "";
    const lines = body.split("\n");
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    for (const verb of ["verify:branch", "verify:encoding", "verify:forward-coverage"]) {
      expect(body).toContain(`run_directive ${verb}`);
    }
    expect(at("verify:branch")).toBeLessThan(at("verify:encoding"));
    expect(at("verify:encoding")).toBeLessThan(at("verify:forward-coverage"));
    const guard = at('[ -d "$REPO_ROOT/xbrief" ] || [ -d "$REPO_ROOT/vbrief" ]');
    expect(guard).toBeGreaterThan(at("verify:forward-coverage"));
    expect(at("verify:vbrief-conformance --staged")).toBeGreaterThan(guard);
    expect(at("verify:xbrief-drift --staged")).toBeGreaterThan(guard);
    expect(body).not.toContain("run_deft");
  });

  it("pre-push runs only preflight-gh --pre-push-stdin and carries no #5804 marker", () => {
    const body = DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-push"] ?? "";
    const calls = body.split("\n").filter((l) => l.startsWith("run_directive "));
    expect(calls).toEqual([
      'run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?',
    ]);
    expect(body).not.toContain("deft:pre-pr-bound-push-v1");
    expect(body).not.toContain("--push-admit");
  });
});

describe("ensureGitHooks replaces committed Directive hooks (#5976 / D-023)", () => {
  it("replaces a committed 0.126.2 trio, removes _deft-run.sh and names each file", () => {
    const root = tempRepo();
    commitHooks(root, {
      ".githooks/_deft-run.sh": V0126_HELPER,
      ".githooks/pre-commit": V0126_PRE_COMMIT,
      ".githooks/pre-push": V0126_PRE_PUSH,
    });
    const out = ensureGitHooks(root);
    expect(out.conflicts).toEqual([]);
    for (const [rel, body] of Object.entries(DIRECTIVE_GIT_HOOK_BODIES)) {
      expect(read(root, rel)).toBe(body);
    }
    expect(read(root, ".githooks/pre-commit")).not.toMatch(/(^|\s)deft\s/m);
    expect(read(root, ".githooks/_directive-run.sh")).toContain(
      "node_modules/@deftai/directive-runtime/dist/bin.js",
    );
    expect(existsSync(join(root, ".githooks/_deft-run.sh"))).toBe(false);
    expect(out.removed).toEqual([".githooks/_deft-run.sh"]);
    expect(out.updated).toEqual([
      "Updated `.githooks/pre-commit`; your earlier version is in git history.",
      "Updated `.githooks/pre-push`; your earlier version is in git history.",
      "Removed `.githooks/_deft-run.sh`; your earlier version is in git history.",
    ]);
  });

  it.each([
    ["0.127.0", V0127_PRE_COMMIT, V0127_PRE_PUSH],
    ["0.129.x", V0127_PRE_COMMIT, V0129_PRE_PUSH],
  ])("replaces committed %s hooks with the current templates", (_era, preCommit, prePush) => {
    const root = tempRepo();
    commitHooks(root, {
      ".githooks/_directive-run.sh": V0129_HELPER,
      ".githooks/pre-commit": preCommit,
      ".githooks/pre-push": prePush,
    });
    const out = ensureGitHooks(root);
    expect(out.conflicts).toEqual([]);
    for (const [rel, body] of Object.entries(DIRECTIVE_GIT_HOOK_BODIES)) {
      expect(read(root, rel)).toBe(body);
      expect(out.modified).toContain(rel);
      expect(out.updated).toContain(formatGitHookUpdated(rel, true));
    }
  });

  it("replaces a committed, edited Directive hook and names it", () => {
    const root = tempRepo();
    const edited = `${DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-commit"]}npx prettier --check .\n`;
    commitHooks(root, { ".githooks/pre-commit": edited });
    const out = ensureGitHooks(root);
    expect(read(root, ".githooks/pre-commit")).toBe(
      DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-commit"],
    );
    expect(out.conflicts).toEqual([]);
    expect(out.updated).toEqual([
      "Updated `.githooks/pre-commit`; your earlier version is in git history.",
    ]);
  });

  it("recognises a known hook checked out with CRLF line endings", () => {
    const root = tempRepo();
    commitHooks(root, { ".githooks/pre-push": V0126_PRE_PUSH.replace(/\n/g, "\r\n") });
    const out = ensureGitHooks(root);
    expect(out.conflicts).toEqual([]);
    expect(read(root, ".githooks/pre-push")).toBe(DIRECTIVE_GIT_HOOK_BODIES[".githooks/pre-push"]);
    expect(out.modified).toContain(".githooks/pre-push");
  });

  it("does not claim git history for a hook git does not track", () => {
    const root = tempRepo();
    writeHook(root, ".githooks/pre-push", V0129_PRE_PUSH);
    const out = ensureGitHooks(root);
    expect(isGitTrackedPath(root, ".githooks/pre-push")).toBe(false);
    expect(out.updated).toEqual(["Updated `.githooks/pre-push`."]);
  });

  it("never overwrites a committed hook that is not Directive's", () => {
    const root = tempRepo();
    commitHooks(root, { ".githooks/pre-commit": FOREIGN_PRE_COMMIT });
    const out = ensureGitHooks(root);
    expect(read(root, ".githooks/pre-commit")).toBe(FOREIGN_PRE_COMMIT);
    expect(out.conflicts).toEqual([
      ".githooks/pre-commit: existing hook is not Directive-managed; refusing to overwrite (chain or remove manually)",
    ]);
    expect(out.updated).toEqual([]);
  });

  it("is quiet on a second run: nothing left to replace", () => {
    const root = tempRepo();
    commitHooks(root, { ".githooks/pre-push": V0129_PRE_PUSH });
    ensureGitHooks(root);
    const second = ensureGitHooks(root);
    expect(second.modified).toEqual([]);
    expect(second.updated).toEqual([]);
  });

  it("the ownership record claims only hook bodies Directive wrote", () => {
    const root = tempRepo();
    commitHooks(root, {
      ".githooks/pre-commit": FOREIGN_PRE_COMMIT,
      ".githooks/pre-push": V0129_PRE_PUSH,
    });
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(result.conflicts.some((c) => c.startsWith(".githooks/pre-commit"))).toBe(true);
    expect(result.gitHookUpdates).toEqual([
      "Updated `.githooks/pre-push`; your earlier version is in git history.",
    ]);
    const hooks = (readOwnershipRecord(root)?.ownership ?? []).filter((a) =>
      a.path.startsWith(".githooks/"),
    );
    expect(hooks.map((a) => a.path).sort()).toEqual([
      ".githooks/_directive-run.sh",
      ".githooks/pre-push",
    ]);
    for (const art of hooks) {
      expect(art.fingerprint).toBe(fingerprintContent(read(root, art.path)));
      expect(read(root, art.path)).toBe(DIRECTIVE_GIT_HOOK_BODIES[art.path]);
    }
  });

  it("isGitTrackedPath reads false outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "setup-tracked-nogit-"));
    TEMPS.push(root);
    expect(isGitTrackedPath(root, ".githooks/pre-push")).toBe(false);
  });

  it("no runtime or launcher source tells users to pass --force-githooks", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      join(here, "setup-wiring.ts"),
      join(here, "setup.ts"),
      join(here, "contract-entry.ts"),
      join(here, "self-complete.ts"),
      join(here, "..", "..", "cli", "src", "plan-present.ts"),
      join(here, "..", "..", "cli", "src", "bookends.ts"),
    ];
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toContain("--force-githooks");
    }
  });
});

// Runs the deposited hooks for real against the built runtime (dist/bin.js),
// linked into the fixture as its pinned package.
describe("deposited hooks stop a bad commit and a default-branch push (#5808)", () => {
  const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..");

  function fixture(): string {
    const root = tempRepo();
    git(root, "checkout", "-q", "-b", "feature/hooks");
    const version = (
      JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as { version: string }
    ).version;
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { name: "t", private: true, devDependencies: { "@deftai/directive-runtime": version } },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
    symlinkSync(runtimeDir, join(root, "node_modules", "@deftai", "directive-runtime"), "junction");
    ensureGitHooks(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    return root;
  }

  function commit(root: string, message: string): { status: number | null; output: string } {
    const r = spawnSync("git", ["commit", "-q", "-m", message], { cwd: root, encoding: "utf8" });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  it("without xbrief/ the commit gates run and a clean commit passes", () => {
    const root = fixture();
    writeFileSync(join(root, "notes.txt"), "hello\n");
    git(root, "add", "notes.txt");
    const out = commit(root, "notes");
    expect(out.status, out.output).toBe(0);
    expect(out.output).toContain("verify_forward_coverage");
    expect(out.output).not.toContain("verify_vbrief_conformance");
  }, 120_000);

  it("with xbrief/ a commit that adds an invalid brief fails at pre-commit", () => {
    const root = fixture();
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "proposed", "2026-01-01-bad.xbrief.json"),
      // `owner` is a bare (non-core, un-namespaced) plan key: brief conformance refuses it.
      '{"xBRIEFInfo":{"version":"0.8"},"plan":{"title":"bad","status":"draft","items":[],"owner":"x"}}\n',
    );
    git(root, "add", "-A");
    const out = commit(root, "bad brief");
    expect(out.status).not.toBe(0);
    expect(out.output).toContain("verify_vbrief_conformance");
  }, 120_000);

  it("pre-push refuses HEAD:refs/heads/main from a feature branch", () => {
    const root = fixture();
    const remote = mkdtempSync(join(tmpdir(), "setup-tracked-remote-"));
    TEMPS.push(remote);
    git(remote, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", remote);
    const toMain = spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(toMain.status).not.toBe(0);
    const toFeature = spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/feature/hooks"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(toFeature.status, toFeature.stderr).toBe(0);
  }, 120_000);
});
