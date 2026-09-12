import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyMutationSummary, type MutationSummary } from "../fs/mutation-ledger.js";
import {
  assertKnownUpdateFlags,
  DIRTY_TREE_REFUSAL_MESSAGE,
  decideUpdateGitGate,
  destPlanIsEmpty,
  type GitExecResult,
  gitPreflightRequired,
  parsePorcelainV1Nul,
  probeUpdateGit,
  UNREADABLE_REPO_REFUSAL_MESSAGE,
  UnknownUpdateFlagError,
  UPDATE_GIT_PREFLIGHT_ARGV,
  UPDATE_GIT_REV_PARSE_ARGV,
} from "./update-git-preflight.js";

describe("parsePorcelainV1Nul", () => {
  it("returns empty for empty stdout", () => {
    expect(parsePorcelainV1Nul("")).toEqual([]);
  });

  it("parses modified and untracked NUL records", () => {
    expect(parsePorcelainV1Nul(" M src/a.ts\0?? scratch.md\0")).toEqual(["src/a.ts", "scratch.md"]);
  });

  it("parses rename source and destination", () => {
    expect(parsePorcelainV1Nul("R  old.ts\0new.ts\0")).toEqual(["old.ts", "new.ts"]);
  });

  it("parses copy destination as a second path", () => {
    expect(parsePorcelainV1Nul("C  keep.ts\0copy.ts\0")).toEqual(["keep.ts", "copy.ts"]);
  });

  it("dedupes repeated paths", () => {
    expect(parsePorcelainV1Nul("M  a.ts\0 M a.ts\0")).toEqual(["a.ts"]);
  });

  it("throws on a truncated rename", () => {
    expect(() => parsePorcelainV1Nul("R  old.ts\0")).toThrow(/porcelain-parse-failure/);
  });

  it("throws on a missing space after XY", () => {
    expect(() => parsePorcelainV1Nul("MMa.ts\0")).toThrow(/porcelain-parse-failure/);
  });
});

describe("destPlanIsEmpty / gitPreflightRequired", () => {
  it("treats an empty ledger as empty dest plan", () => {
    expect(destPlanIsEmpty(emptyMutationSummary())).toBe(true);
  });

  it("treats any mutation as a non-empty dest plan", () => {
    const summary: MutationSummary = {
      ...emptyMutationSummary(),
      wrote: ["AGENTS.md"],
      mutations: [{ kind: "wrote", path: "AGENTS.md" }],
    };
    expect(destPlanIsEmpty(summary)).toBe(false);
  });

  it("requires preflight when dest plan is non-empty", () => {
    expect(gitPreflightRequired(false, false)).toBe(true);
  });

  it("requires preflight when dest plan is empty but an out-of-root writer might fire", () => {
    expect(gitPreflightRequired(true, true)).toBe(true);
  });

  it("skips preflight only when dest plan is empty and no out-of-root writer", () => {
    expect(gitPreflightRequired(true, false)).toBe(false);
  });
});

describe("decideUpdateGitGate", () => {
  const dirty = {
    kind: "dirty" as const,
    dirty_tree: true,
    dirty_files: ["scratch.md"],
    stderr: "",
  };
  const unreadable = {
    kind: "unreadable" as const,
    dirty_tree: false,
    dirty_files: [],
    stderr: "fatal: detected dubious ownership",
  };
  const clean = {
    kind: "clean" as const,
    dirty_tree: false,
    dirty_files: [],
    stderr: "",
  };
  const noRepo = {
    kind: "no-repository" as const,
    dirty_tree: false,
    dirty_files: [],
    stderr: "",
  };

  it("does not refuse when preflight is not required, even if dirty", () => {
    const decision = decideUpdateGitGate({
      preflight: dirty,
      required: false,
      allowDirtyNoStage: false,
    });
    expect(decision.action).toBe("proceed");
  });

  it("proceeds for no-repository when required", () => {
    expect(
      decideUpdateGitGate({ preflight: noRepo, required: true, allowDirtyNoStage: false }).action,
    ).toBe("proceed");
  });

  it("proceeds for clean when required", () => {
    expect(
      decideUpdateGitGate({ preflight: clean, required: true, allowDirtyNoStage: false }).action,
    ).toBe("proceed");
  });

  it("refuses dirty without the escape", () => {
    const decision = decideUpdateGitGate({
      preflight: dirty,
      required: true,
      allowDirtyNoStage: false,
    });
    expect(decision).toMatchObject({
      action: "refuse",
      error_code: "dirty_tree",
      message: DIRTY_TREE_REFUSAL_MESSAGE,
    });
  });

  it("proceeds dirty with --allow-dirty-no-stage", () => {
    const decision = decideUpdateGitGate({
      preflight: dirty,
      required: true,
      allowDirtyNoStage: true,
    });
    expect(decision.action).toBe("proceed");
  });

  it("refuses unreadable even with --allow-dirty-no-stage", () => {
    const decision = decideUpdateGitGate({
      preflight: unreadable,
      required: true,
      allowDirtyNoStage: true,
    });
    expect(decision).toMatchObject({
      action: "refuse",
      error_code: "unreadable_repo",
      message: UNREADABLE_REPO_REFUSAL_MESSAGE,
    });
  });
});

describe("assertKnownUpdateFlags", () => {
  it("accepts the canonical update flag set", () => {
    expect(() =>
      assertKnownUpdateFlags([
        "--yes",
        "--upgrade",
        "--repo-root",
        ".",
        "--json",
        "--dry-run",
        "--allow-dirty-no-stage",
      ]),
    ).not.toThrow();
  });

  it("rejects unknown flags", () => {
    expect(() => assertKnownUpdateFlags(["--json", "--mystery"])).toThrow(UnknownUpdateFlagError);
    expect(() => assertKnownUpdateFlags(["--mystery"])).toThrow(/unknown flag: --mystery/);
  });

  it("rejects --allow-dirty and --force as not this escape", () => {
    expect(() => assertKnownUpdateFlags(["--allow-dirty"])).toThrow(
      /not the dirty-update escape; use --allow-dirty-no-stage/,
    );
    expect(() => assertKnownUpdateFlags(["--force"])).toThrow(
      /not the dirty-update escape; use --allow-dirty-no-stage/,
    );
  });
});

describe("probeUpdateGit", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "update-git-"));
    created.push(root);
    return root;
  }

  it("uses --no-optional-locks porcelain v1 -z --untracked-files=all", () => {
    const calls: string[][] = [];
    const execGit = (args: readonly string[]): GitExecResult => {
      calls.push([...args]);
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = probeUpdateGit("/proj", { execGit, gitDirExists: () => true });
    expect(result.kind).toBe("clean");
    expect(calls[0]).toEqual([...UPDATE_GIT_REV_PARSE_ARGV]);
    expect(calls[1]).toEqual([...UPDATE_GIT_PREFLIGHT_ARGV]);
  });

  it("no-repository when git is missing and there is no .git", () => {
    const result = probeUpdateGit("/proj", {
      execGit: () => ({ status: 127, stdout: "", stderr: "", errorCode: "ENOENT" }),
      gitDirExists: () => false,
    });
    expect(result.kind).toBe("no-repository");
  });

  it("unreadable when git is missing but .git is present", () => {
    const result = probeUpdateGit("/proj", {
      execGit: () => ({ status: 127, stdout: "", stderr: "", errorCode: "ENOENT" }),
      gitDirExists: () => true,
    });
    expect(result.kind).toBe("unreadable");
  });

  it("unreadable on safe.directory refusal", () => {
    const result = probeUpdateGit("/proj", {
      execGit: () => ({
        status: 128,
        stdout: "",
        stderr: "fatal: detected dubious ownership in repository",
      }),
      gitDirExists: () => true,
    });
    expect(result.kind).toBe("unreadable");
    expect(result.stderr).toMatch(/dubious ownership/);
  });

  it("unreadable on porcelain parse failure", () => {
    const execGit = (args: readonly string[]): GitExecResult => {
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      return { status: 0, stdout: "not-porcelain", stderr: "" };
    };
    expect(probeUpdateGit("/proj", { execGit, gitDirExists: () => true }).kind).toBe("unreadable");
  });

  it("reports dirty files from porcelain", () => {
    const execGit = (args: readonly string[]): GitExecResult => {
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "true\n", stderr: "" };
      }
      return { status: 0, stdout: " M AGENTS.md\0?? extra.txt\0", stderr: "" };
    };
    const result = probeUpdateGit("/proj", { execGit, gitDirExists: () => true });
    expect(result.kind).toBe("dirty");
    expect(result.dirty_tree).toBe(true);
    expect(result.dirty_files).toEqual(["AGENTS.md", "extra.txt"]);
  });

  it("live no-repo temp dir is no-repository", () => {
    const root = freshRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x\n", "utf8");
    expect(probeUpdateGit(root).kind).toBe("no-repository");
  });

  it("live dirty git worktree is dirty", () => {
    const root = freshRoot();
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "a\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    writeFileSync(join(root, "scratch.txt"), "dirty\n", "utf8");
    const result = probeUpdateGit(root);
    expect(result.kind).toBe("dirty");
    expect(result.dirty_files).toContain("scratch.txt");
  });

  it("live clean committed worktree is clean", () => {
    const root = freshRoot();
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "a\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    expect(probeUpdateGit(root).kind).toBe("clean");
  });
});
