import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinReadResult } from "../resolution/pin.js";
import type { GitLsFiles } from "./gitignore.js";
import { UNTRACK_CORE_GITIGNORE_LINES } from "./gitignore.js";
import {
  type GitRmCached,
  runUntrackCoreCli,
  UNTRACK_CORE_PATH,
  untrackCore,
} from "./untrack-core.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

function pin(version: string | null, extra: Partial<PinReadResult> = {}): PinReadResult {
  return {
    pinVersion: version,
    rawSpec: version,
    isPrivate: true,
    nonExact: false,
    ...extra,
  };
}

/**
 * A fake git harness: `gitLsFiles` reports `.deft/core` tracked until
 * `gitRmCached` clears it, so the same instance can drive a run and its rerun.
 */
function fakeGit(trackedInitially: boolean): {
  gitLsFiles: GitLsFiles;
  gitRmCached: GitRmCached;
  calls: string[][];
} {
  let tracked = trackedInitially;
  const calls: string[][] = [];
  return {
    gitLsFiles: () => (tracked ? ".deft/core/main.md\n" : ""),
    gitRmCached: (_dir, paths) => {
      calls.push([...paths]);
      tracked = false;
      return { ok: true, detail: "" };
    },
    calls,
  };
}

/** Materialize a working-tree deposit so we can assert it is never deleted. */
function seedDeposit(root: string): string {
  const file = join(root, ".deft/core", "main.md");
  mkdirSync(join(root, ".deft/core"), { recursive: true });
  writeFileSync(file, "# vendored deposit\n", "utf8");
  return file;
}

describe("untrackCore", () => {
  it("un-tracks a tracked deposit, reconciles .gitignore, and leaves the working tree intact", () => {
    const root = freshRoot("untrack-tracked-");
    const depositFile = seedDeposit(root);
    const git = fakeGit(true);

    const result = untrackCore(root, {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin("0.59.0"),
    });

    expect(result.outcome).toBe("untracked");
    expect(result.exitCode).toBe(0);
    expect(result.deftCoreTracked).toBe(true);
    expect(result.pinVersion).toBe("0.59.0");
    // Exactly one destructive index mutation, scoped to the deposit path.
    expect(git.calls).toEqual([[UNTRACK_CORE_PATH]]);
    // Working-tree content is never deleted.
    expect(existsSync(depositFile)).toBe(true);
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".deft/core/");
    expect(gitignore).not.toMatch(/^package\.json\s*$/m);
    expect(result.gitignoreChanged).toBe(true);
  });

  it("refuses (exit 1) when no committed pin exists, running no git rm --cached", () => {
    const root = freshRoot("untrack-nopin-");
    const git = fakeGit(true);

    const result = untrackCore(root, {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin(null),
    });

    expect(result.outcome).toBe("refused-missing-pin");
    expect(result.exitCode).toBe(1);
    expect(git.calls).toEqual([]);
    // Refusal is non-destructive: no .gitignore is written.
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(result.message).toContain("refusing");
  });

  it("refuses when the pin is a non-exact range spec", () => {
    const root = freshRoot("untrack-range-");
    const git = fakeGit(true);

    const result = untrackCore(root, {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin(null, { rawSpec: "^0.59.0", nonExact: true }),
    });

    expect(result.outcome).toBe("refused-missing-pin");
    expect(result.exitCode).toBe(1);
    expect(git.calls).toEqual([]);
    expect(result.message).toContain("non-exact");
  });

  it("refuses a non-exact pin even when readPin resolves a version (guard is not coupled to pinVersion===null)", () => {
    const root = freshRoot("untrack-range-resolved-");
    const git = fakeGit(true);

    // A hypothetical readPin that resolves a concrete version from a range spec
    // while still flagging it non-exact. The guard MUST refuse on nonExact alone.
    const result = untrackCore(root, {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin("0.59.0", { rawSpec: "^0.59.0", nonExact: true }),
    });

    expect(result.outcome).toBe("refused-missing-pin");
    expect(result.exitCode).toBe(1);
    expect(git.calls).toEqual([]);
    expect(result.message).toContain("non-exact");
  });

  it("is an idempotent no-op when the deposit is already untracked and ignored", () => {
    const root = freshRoot("untrack-clean-");
    // Pre-seed a fully reconciled .gitignore so the second-run reconcile is a no-op.
    writeFileSync(join(root, ".gitignore"), `${UNTRACK_CORE_GITIGNORE_LINES.join("\n")}\n`, "utf8");
    const git = fakeGit(false);

    const result = untrackCore(root, {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin("0.59.0"),
    });

    expect(result.outcome).toBe("already-clean");
    expect(result.exitCode).toBe(0);
    expect(result.deftCoreTracked).toBe(false);
    expect(result.gitignoreChanged).toBe(false);
    expect(git.calls).toEqual([]);
  });

  it("re-running after an un-track is a no-op that mutates nothing", () => {
    const root = freshRoot("untrack-rerun-");
    seedDeposit(root);
    const git = fakeGit(true);
    const seams = {
      gitLsFiles: git.gitLsFiles,
      gitRmCached: git.gitRmCached,
      readPin: () => pin("0.59.0"),
    };

    const first = untrackCore(root, seams);
    expect(first.outcome).toBe("untracked");
    const afterFirst = readFileSync(join(root, ".gitignore"), "utf8");

    const second = untrackCore(root, seams);
    expect(second.outcome).toBe("already-clean");
    expect(second.gitignoreChanged).toBe(false);
    // git rm --cached ran exactly once across both invocations.
    expect(git.calls).toEqual([[UNTRACK_CORE_PATH]]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(afterFirst);
  });

  it("end-to-end: default seams un-track a real tracked deposit, index-only", () => {
    const root = freshRoot("untrack-e2e-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    const depositFile = seedDeposit(root);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ private: true, devDependencies: { "@deftai/directive": "0.59.0" } }, null, 2)}\n`,
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: root, stdio: "ignore" });

    // Sanity: the deposit is tracked before the un-commit.
    expect(
      execFileSync("git", ["ls-files", ".deft/core"], { cwd: root, encoding: "utf8" }).trim(),
    ).not.toBe("");

    // No seams injected -> real git ls-files + git rm --cached + real readPin.
    const result = untrackCore(root);

    expect(result.outcome).toBe("untracked");
    expect(result.pinVersion).toBe("0.59.0");
    // Removed from the index...
    expect(
      execFileSync("git", ["ls-files", ".deft/core"], { cwd: root, encoding: "utf8" }).trim(),
    ).toBe("");
    // ...but the working-tree file is never deleted.
    expect(existsSync(depositFile)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".deft/core/");
  });

  it("surfaces a git-error (exit 2) when git rm --cached fails", () => {
    const root = freshRoot("untrack-gitfail-");
    const result = untrackCore(root, {
      gitLsFiles: () => ".deft/core/main.md\n",
      gitRmCached: () => ({ ok: false, detail: "fatal: not a git repository" }),
      readPin: () => pin("0.59.0"),
    });

    expect(result.outcome).toBe("git-error");
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("git rm --cached failed");
    // The trimmed git detail is interpolated into the guard message.
    expect(result.message).toContain("fatal: not a git repository");
  });
});

describe("runUntrackCoreCli", () => {
  function capture(): {
    out: string[];
    err: string[];
    writeOut: (t: string) => void;
    writeErr: (t: string) => void;
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) };
  }

  it("emits JSON and returns exit 0 on a successful un-track", () => {
    const root = freshRoot("untrack-cli-json-");
    seedDeposit(root);
    const io = capture();

    const code = runUntrackCoreCli({
      projectDir: root,
      jsonOut: true,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: {
        gitLsFiles: () => ".deft/core/main.md\n",
        gitRmCached: () => ({ ok: true, detail: "" }),
        readPin: () => pin("0.59.0"),
      },
    });

    expect(code).toBe(0);
    // JSON.parse can return a top-level null/primitive without throwing; assert
    // an object before property access so a malformed payload fails loud here.
    const parsed: unknown = JSON.parse(io.out.join(""));
    expect(parsed).toBeTypeOf("object");
    expect(parsed).not.toBeNull();
    const payload = parsed as Record<string, unknown>;
    expect(payload.action).toBe("migrate-untrack-core");
    expect(payload.outcome).toBe("untracked");
    expect(payload.exit_code).toBe(0);
    expect(payload.pin_version).toBe("0.59.0");
    expect(payload.project_dir).toBe(resolve(root));
  });

  it("prints the refusal to stderr and returns exit 1 (human mode)", () => {
    const root = freshRoot("untrack-cli-refuse-");
    const io = capture();

    const code = runUntrackCoreCli({
      projectDir: root,
      jsonOut: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: {
        gitLsFiles: () => ".deft/core/main.md\n",
        gitRmCached: () => ({ ok: true, detail: "" }),
        readPin: () => pin(null),
      },
    });

    expect(code).toBe(1);
    expect(io.out.join("")).toBe("");
    expect(io.err.join("")).toContain("refusing");
  });

  it("prints the success summary to stdout and returns exit 0 (human mode)", () => {
    const root = freshRoot("untrack-cli-human-");
    seedDeposit(root);
    const io = capture();

    const code = runUntrackCoreCli({
      projectDir: root,
      jsonOut: false,
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      seams: {
        gitLsFiles: () => ".deft/core/main.md\n",
        gitRmCached: () => ({ ok: true, detail: "" }),
        readPin: () => pin("0.59.0"),
      },
    });

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("removed .deft/core from the git index");
    expect(io.err.join("")).toBe("");
  });
});

describe("destructive-mutation boundary (#2269 a1)", () => {
  it("git rm --cached is invoked only from untrack-core.ts across init-deposit + init-cli", () => {
    // Portable __dirname (avoids relying on the Node-version-gated
    // `import.meta.dirname`, which some type-checkers reject).
    const initDepositDir = dirname(fileURLToPath(import.meta.url));
    const initCliDir = resolve(initDepositDir, "../../../cli/src/init-cli");
    // The destructive index mutation is the `["rm", "--cached", ...]` argv
    // adjacency — NOT a bare `--cached` (e.g. the non-destructive
    // `git diff --cached` read in hygiene.ts).
    const gitRmCached = /["']rm["']\s*,\s*["']--cached["']/;

    const offenders: string[] = [];
    for (const dir of [initDepositDir, initCliDir]) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ts")) continue;
        if (name.endsWith(".test.ts")) continue;
        if (name === "untrack-core.ts") continue;
        const text = readFileSync(join(dir, name), "utf8");
        if (gitRmCached.test(text)) offenders.push(join(dir, name));
      }
    }

    expect(offenders).toEqual([]);
    // And the sole allowed call site actually contains the mutation.
    expect(readFileSync(join(initDepositDir, "untrack-core.ts"), "utf8")).toMatch(gitRmCached);
  });
});
