import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excuseMergeArrivals } from "./merge-commit-excuse.js";
import { listStagedIndexEntries, type StagedIndexEntry } from "./planning-publication.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function put(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

/** A clone whose `feature` branch is mid-merge (`--no-commit`) of a merge head. */
function midMerge(mergeRef: "origin/master" | "side"): {
  root: string;
  entries: StagedIndexEntry[];
} {
  const base = mkdtempSync(join(tmpdir(), "merge-excuse-"));
  temps.push(base);
  const origin = join(base, "origin.git");
  const root = join(base, "work");
  mkdirSync(root);
  git(base, ["init", "-q", "--bare", origin]);
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  put(root, "packages/b/y.ts", "base\n");
  put(root, "packages/b/gone.ts", "gone\n");
  put(root, "packages/a/x.ts", "a\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["branch", "feature"]);
  // The default branch moves on: one change and one deletion.
  put(root, "packages/b/y.ts", "master\n");
  git(root, ["rm", "-q", "packages/b/gone.ts"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "master"]);
  git(root, ["push", "-q", "origin", "master"]);
  if (mergeRef === "side") {
    // A commit that is not an ancestor of the fetched delivery ref.
    git(root, ["checkout", "-q", "-b", "side"]);
    put(root, "packages/b/y.ts", "side\n");
    git(root, ["commit", "-q", "-am", "side"]);
  }
  git(root, ["checkout", "-q", "feature"]);
  put(root, "packages/a/x.ts", "feature\n");
  git(root, ["commit", "-q", "-am", "feature"]);
  git(root, ["merge", "-q", "--no-commit", "--no-ff", mergeRef]);
  const listed = listStagedIndexEntries(root);
  if (!listed.ok) throw new Error(listed.message);
  return { root, entries: [...listed.entries] };
}

const PATHS = ["packages/b/y.ts", "packages/b/gone.ts"] as const;

describe("merge-commit excuse (#6379 item 6)", { timeout: 120_000 }, () => {
  it("excuses staged entries and deletions identical to an authoritative MERGE_HEAD", () => {
    const { root, entries } = midMerge("origin/master");
    const result = excuseMergeArrivals({
      projectRoot: root,
      paths: [...PATHS, "packages/z/new.ts"],
      stagedEntries: entries,
      deliveryRef: "origin/master",
    });
    expect(result.excused).toEqual([...PATHS]);
    expect(result.remaining).toEqual(["packages/z/new.ts"]);

    // A staged entry that differs from MERGE_HEAD stays under the check.
    put(root, "packages/b/y.ts", "edited during the merge\n");
    git(root, ["add", "packages/b/y.ts"]);
    const listed = listStagedIndexEntries(root);
    if (!listed.ok) throw new Error(listed.message);
    const edited = excuseMergeArrivals({
      projectRoot: root,
      paths: [...PATHS],
      stagedEntries: listed.entries,
      deliveryRef: "origin/master",
    });
    expect(edited.remaining).toEqual(["packages/b/y.ts"]);
  });

  it("excuses nothing when MERGE_HEAD or the fetched delivery ref cannot be read", () => {
    const { root, entries } = midMerge("origin/master");
    const base = { projectRoot: root, paths: [...PATHS], stagedEntries: entries };
    const none = { excused: [], remaining: [...PATHS] };
    expect(excuseMergeArrivals({ ...base, deliveryRef: undefined })).toEqual(none);
    expect(excuseMergeArrivals({ ...base, deliveryRef: "origin/missing" })).toEqual(none);
    // A local branch is not a fetched ref.
    expect(excuseMergeArrivals({ ...base, deliveryRef: "master" })).toEqual(none);
    expect(
      excuseMergeArrivals({ ...base, stagedEntries: undefined, deliveryRef: "origin/master" }),
    ).toEqual(none);
    // An unreadable MERGE_HEAD.
    const mergeHead = git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
    writeFileSync(join(root, mergeHead), "not a commit id\n", "utf8");
    expect(excuseMergeArrivals({ ...base, deliveryRef: "origin/master" })).toEqual(none);
    git(root, ["merge", "--abort"]);
    expect(excuseMergeArrivals({ ...base, deliveryRef: "origin/master" })).toEqual(none);
  });

  it("excuses nothing from a MERGE_HEAD that is not an ancestor of the delivery ref", () => {
    const { root, entries } = midMerge("side");
    const result = excuseMergeArrivals({
      projectRoot: root,
      paths: ["packages/b/y.ts"],
      stagedEntries: entries,
      deliveryRef: "origin/master",
    });
    expect(result).toEqual({ excused: [], remaining: ["packages/b/y.ts"] });
  });

  it("excuses nothing when a git call throws", () => {
    const result = excuseMergeArrivals({
      projectRoot: "/nowhere",
      paths: ["a.ts"],
      stagedEntries: [],
      deliveryRef: "origin/master",
      runGit: () => {
        throw new Error("boom");
      },
    });
    expect(result).toEqual({ excused: [], remaining: ["a.ts"] });
  });

  it("compares parsed tree entries from stubbed git output, path by path", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-excuse-stub-"));
    temps.push(root);
    const head = "a".repeat(40);
    writeFileSync(join(root, "MERGE_HEAD"), `${head}\n`, "utf8");
    const blob = "b".repeat(40);
    let lsTreeCode = 0;
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return { code: 0, stdout: "MERGE_HEAD\n", stderr: "" };
      }
      if (args[0] === "rev-parse")
        return { code: 0, stdout: "refs/remotes/origin/master\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
      return {
        code: lsTreeCode,
        stdout: [
          `100644 blob ${blob}\tsrc/same.ts`,
          "garbage",
          "100644 blob\tsrc/short.ts",
          "",
        ].join("\u0000"),
        stderr: "",
      };
    };
    const entries: StagedIndexEntry[] = [
      { path: "src/same.ts", kind: "M", mode: "100644", blob },
      { path: "./src/short.ts\r", kind: "M", mode: "100644", blob },
      { path: "src/gone.ts", kind: "M", mode: "000000", blob: "0".repeat(40) },
    ];
    const input = {
      projectRoot: root,
      paths: ["src/same.ts", "src/short.ts", "src/gone.ts", "src/unstaged.ts"],
      stagedEntries: entries,
      deliveryRef: "origin/master",
      runGit,
    };
    expect(excuseMergeArrivals(input)).toEqual({
      excused: ["src/same.ts", "src/gone.ts"],
      remaining: ["src/short.ts", "src/unstaged.ts"],
    });
    lsTreeCode = 128;
    expect(excuseMergeArrivals(input).excused).toEqual([]);
    const noPath = (_cwd: string, args: readonly string[]) =>
      args[1] === "--git-path" ? { code: 1, stdout: "", stderr: "" } : runGit(_cwd, args);
    expect(excuseMergeArrivals({ ...input, runGit: noPath }).excused).toEqual([]);
  });
});
