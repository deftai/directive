/**
 * Batched lifecycle census (#6378 items 1-5): the batched read gives the same
 * census as today's single reads, and every fault falls back to them.
 */
import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BaseBriefRead,
  gitShowPath,
  isBatchEligibleRequest,
  type LifecycleCensusResult,
  listLifecycleBriefsAtRef,
  normalizeRepoRelPath,
  readBlobsInBatches,
  unquoteGitPath,
} from "./census-batch.js";
import {
  createScopeProvenanceGit,
  GitCallTimeoutError,
  type GitSpawn,
  type ScopeProvenanceGit,
} from "./git-call.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function g(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "census-batch-"));
  g(root, ["init", "-q"]);
  g(root, ["config", "core.autocrlf", "false"]);
  // Index-only names (trailing space, line break) that NTFS cannot hold.
  g(root, ["config", "core.protectNTFS", "false"]);
  return root;
}

function brief(planId: string, extra = ""): string {
  return `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { id: planId, note: extra } }, null, 2)}\n`;
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  g(root, ["add", "--", rel]);
}

/** Add an index entry by path only (names a working tree cannot hold). */
function addIndexEntry(root: string, mode: string, oid: string, rel: string): void {
  g(root, ["update-index", "-z", "--index-info"], `${mode} ${oid}\t${rel}\0`);
}

function blob(root: string, body: string): string {
  return g(root, ["hash-object", "-w", "--stdin"], body).trim();
}

function commit(root: string): void {
  g(root, ["commit", "-q", "-m", "c", "--allow-empty"]);
}

/** Today's single read: `git show <ref>:<path>` with the evaluator's missing rule. */
function singleReader(root: string, ref: string, git: ScopeProvenanceGit) {
  const reads: string[] = [];
  const read = (rel: string): BaseBriefRead => {
    reads.push(rel);
    const r = git.runText(["show", `${ref}:${gitShowPath(rel)}`], root);
    // The evaluator's git helper throws on a spawn error (ENOBUFS past the buffer).
    if (r.error !== undefined) return { kind: "error", message: String(r.error.message) };
    if (r.status === 0) return { kind: "text", text: r.stdout };
    const detail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.toLowerCase();
    if (detail.includes("does not exist") || detail.includes("exists on disk, but not in")) {
      return { kind: "missing" };
    }
    return { kind: "error", message: `exit ${String(r.status)}` };
  };
  return { read, reads };
}

/** Spawn seam that records every git argv and can rewrite results. */
function recordingSpawn(
  rewrite?: (
    args: readonly string[],
    r: SpawnSyncReturns<string | Buffer>,
  ) => SpawnSyncReturns<string | Buffer>,
): { spawn: GitSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: GitSpawn = (cmd, args, options) => {
    calls.push([...args]);
    const r = spawnSync(cmd, [...args], options) as SpawnSyncReturns<string | Buffer>;
    return rewrite ? rewrite(args, r) : r;
  };
  return { spawn, calls };
}

function census(
  root: string,
  opts: { batch: boolean; git?: ScopeProvenanceGit; ref?: string },
): { result: LifecycleCensusResult; singleReads: string[]; kept: string[] } {
  const git = opts.git ?? createScopeProvenanceGit({ timeoutSeconds: 0 });
  const ref = opts.ref ?? "HEAD";
  const single = singleReader(root, ref, git);
  const kept: string[] = [];
  const result = listLifecycleBriefsAtRef({
    git,
    projectRoot: root,
    baseRef: ref,
    readAtBase: single.read,
    batch: opts.batch,
    keep: (rel) => kept.push(rel),
  });
  return { result, singleReads: single.reads, kept };
}

function strip(result: LifecycleCensusResult): unknown {
  if (result.kind === "error") return { kind: "error" };
  return {
    kind: "ok",
    briefs: result.briefs.map((b) => ({ rel: b.rel, planId: b.planId, raw: b.raw })),
  };
}

describe("census-batch helpers", () => {
  it("partitions requests on printable ASCII only", () => {
    expect(isBatchEligibleRequest("HEAD:xbrief/active/a.xbrief.json")).toBe(true);
    expect(isBatchEligibleRequest("HEAD:xbrief/active/a b.xbrief.json")).toBe(true);
    expect(isBatchEligibleRequest("HEAD:xbrief/active/a\nb.xbrief.json")).toBe(false);
    expect(isBatchEligibleRequest("HEAD:xbrief/active/a\tb.xbrief.json")).toBe(false);
    expect(isBatchEligibleRequest("HEAD:xbrief/active/é.xbrief.json")).toBe(false);
    expect(isBatchEligibleRequest("HEAD:xbrief/active/a\u007f.xbrief.json")).toBe(false);
    expect(isBatchEligibleRequest("")).toBe(false);
  });

  it("keeps today's path rules", () => {
    expect(gitShowPath(".\\xbrief\\active\\a.xbrief.json")).toBe("xbrief/active/a.xbrief.json");
    expect(normalizeRepoRelPath("./a//b")).toBe("a/b");
    expect(unquoteGitPath('"xbrief/active/\\303\\251.xbrief.json"')).toBe(
      "xbrief/active/é.xbrief.json",
    );
    expect(unquoteGitPath('"a\\tb\\n\\\\c"')).toBe("a\tb\n/c");
    expect(unquoteGitPath(" xbrief/active/a.xbrief.json \r")).toBe("xbrief/active/a.xbrief.json");
  });
});

describe("listLifecycleBriefsAtRef batched read (#6378)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("gives the same census as single reads, with few git processes", () => {
    root = initRepo();
    for (let i = 0; i < 40; i += 1) {
      const folder = ["pending", "active", "completed", "cancelled"][i % 4];
      writeTracked(
        root,
        `xbrief/${folder}/s${String(i)}.xbrief.json`,
        brief(`p${String(i)}`, "héllo ✓"),
      );
    }
    writeTracked(root, "xbrief/active/notes.md", "not a brief\n");
    commit(root);
    const rec = recordingSpawn();
    const git = createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn });
    const batched = census(root, { batch: true, git });
    const single = census(root, { batch: false });
    expect(batched.result.kind).toBe("ok");
    expect(strip(batched.result)).toEqual(strip(single.result));
    expect(batched.singleReads).toEqual([]);
    expect(batched.kept).toHaveLength(40);
    // 4 ls-tree + 1 size call + 1 batch chunk; well under 20.
    expect(rec.calls.length).toBeLessThan(20);
    expect(rec.calls.filter((c) => c[0] === "show")).toHaveLength(0);
    expect(rec.calls.filter((c) => c.join(" ") === "cat-file --batch-check")).toHaveLength(1);
  });

  it("reads a name with a line break with the single read", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    addIndexEntry(root, "100644", blob(root, brief("nl")), "xbrief/active/x\ny.xbrief.json");
    commit(root);
    const rec = recordingSpawn();
    const git = createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn });
    const batched = census(root, { batch: true, git });
    const single = census(root, { batch: false });
    expect(strip(batched.result)).toEqual(strip(single.result));
    expect(batched.singleReads).toEqual(["xbrief/active/x\ny.xbrief.json"]);
    const checkCall = rec.calls.findIndex((c) => c.join(" ") === "cat-file --batch-check");
    expect(checkCall).toBeGreaterThanOrEqual(0);
  });

  it("reads a non-ASCII name with the single read", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    writeTracked(root, "xbrief/active/é.xbrief.json", brief("e"));
    commit(root);
    const batched = census(root, { batch: true });
    const single = census(root, { batch: false });
    expect(batched.result.kind).toBe("ok");
    expect(strip(batched.result)).toEqual(strip(single.result));
    expect(batched.singleReads).toEqual(["xbrief/active/é.xbrief.json"]);
  });

  it("keeps an absent requested path the same as today (rewritten name)", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    // Listed with a trailing space; today's trim requests a path that is absent.
    addIndexEntry(root, "100644", blob(root, brief("t")), "xbrief/active/t.xbrief.json ");
    commit(root);
    const batched = census(root, { batch: true });
    const single = census(root, { batch: false });
    expect(batched.result.kind).toBe("error");
    expect(batched.result).toEqual(single.result);
    expect(batched.singleReads).toEqual(["xbrief/active/t.xbrief.json"]);
  });

  it("reads the object at the rewritten path and keeps both entries", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/d.xbrief.json", brief("real", "the real brief body"));
    // Same path after trimming; its own blob is a different size.
    addIndexEntry(root, "100644", blob(root, brief("other")), "xbrief/active/d.xbrief.json ");
    commit(root);
    const batched = census(root, { batch: true });
    const single = census(root, { batch: false });
    expect(batched.result.kind).toBe("ok");
    expect(strip(batched.result)).toEqual(strip(single.result));
    if (batched.result.kind !== "ok") return;
    expect(batched.result.briefs).toHaveLength(2);
    expect(batched.result.briefs.map((b) => b.planId)).toEqual(["real", "real"]);
    expect(batched.singleReads).toEqual([]);
  });

  it("keeps a directory or submodule entry the same as today", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    // A directory at the rewritten path.
    writeTracked(root, "xbrief/active/dir.xbrief.json/inner.txt", "x\n");
    addIndexEntry(root, "100644", blob(root, brief("d")), "xbrief/active/dir.xbrief.json ");
    commit(root);
    const dirBatched = census(root, { batch: true });
    const dirSingle = census(root, { batch: false });
    expect(dirBatched.result.kind).toBe("error");
    expect(dirBatched.result).toEqual(dirSingle.result);
    expect(dirBatched.singleReads).toContain("xbrief/active/dir.xbrief.json");

    rmSync(root, { recursive: true, force: true });
    root = initRepo();
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    addIndexEntry(root, "160000", "1".repeat(40), "xbrief/active/sub.xbrief.json");
    commit(root);
    const subBatched = census(root, { batch: true });
    const subSingle = census(root, { batch: false });
    expect(subBatched.result).toEqual(subSingle.result);
    // A gitlink is never answered as a blob, so it is read with today's single read.
    expect(subBatched.singleReads).toContain("xbrief/active/sub.xbrief.json");
  });

  it("reads a brief one byte under the buffer limit the same as today", () => {
    root = initRepo();
    const limit = 4096;
    const pad = "x".repeat(limit - 1 - brief("big", "").length);
    const body = brief("big", pad);
    expect(Buffer.byteLength(body)).toBe(limit - 1);
    writeTracked(root, "xbrief/active/big.xbrief.json", body);
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    commit(root);
    const git = createScopeProvenanceGit({ timeoutSeconds: 0, maxBuffer: limit });
    const batched = census(root, { batch: true, git });
    const single = census(root, {
      batch: false,
      git: createScopeProvenanceGit({ timeoutSeconds: 0, maxBuffer: limit }),
    });
    expect(batched.result.kind).toBe("ok");
    expect(strip(batched.result)).toEqual(strip(single.result));
    // Its framed answer does not fit under the limit: single read.
    expect(batched.singleReads).toEqual(["xbrief/active/big.xbrief.json"]);
  });

  it("reads a brief larger than the buffer limit the same as today", () => {
    root = initRepo();
    const limit = 4096;
    writeTracked(root, "xbrief/active/huge.xbrief.json", brief("huge", "y".repeat(limit * 256)));
    writeTracked(root, "xbrief/active/a.xbrief.json", brief("a"));
    commit(root);
    const mk = () => createScopeProvenanceGit({ timeoutSeconds: 0, maxBuffer: limit });
    const batched = census(root, { batch: true, git: mk() });
    const single = census(root, { batch: false, git: mk() });
    expect(batched.result.kind).toBe("error");
    expect(batched.result).toEqual(single.result);
  });

  it("reads briefs over the buffer limit in more than one chunk", () => {
    root = initRepo();
    const limit = 4096;
    for (let i = 0; i < 6; i += 1) {
      writeTracked(
        root,
        `xbrief/active/c${String(i)}.xbrief.json`,
        brief(`c${String(i)}`, "z".repeat(1500)),
      );
    }
    commit(root);
    const rec = recordingSpawn();
    const batched = census(root, {
      batch: true,
      git: createScopeProvenanceGit({ timeoutSeconds: 0, maxBuffer: limit, spawn: rec.spawn }),
    });
    const single = census(root, { batch: false });
    expect(batched.result.kind).toBe("ok");
    expect(strip(batched.result)).toEqual(strip(single.result));
    expect(rec.calls.filter((c) => c.join(" ") === "cat-file --batch").length).toBeGreaterThan(1);
    expect(batched.singleReads).toEqual([]);
  });

  it("falls back to single reads when batch output ends early", () => {
    root = initRepo();
    for (let i = 0; i < 3; i += 1)
      writeTracked(root, `xbrief/active/s${String(i)}.xbrief.json`, brief(`s${String(i)}`));
    commit(root);
    const rec = recordingSpawn((args, r) => {
      if (args.join(" ") !== "cat-file --batch") return r;
      const out = r.stdout as Buffer;
      return { ...r, stdout: out.subarray(0, Math.floor(out.length / 2)) };
    });
    const batched = census(root, {
      batch: true,
      git: createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn }),
    });
    const single = census(root, { batch: false });
    expect(strip(batched.result)).toEqual(strip(single.result));
    expect(batched.singleReads).toHaveLength(3);
  });

  it("falls back to single reads when a batch id or size differs from the size call", () => {
    root = initRepo();
    for (let i = 0; i < 3; i += 1)
      writeTracked(root, `xbrief/active/s${String(i)}.xbrief.json`, brief(`s${String(i)}`));
    commit(root);
    for (const field of ["oid", "size"] as const) {
      const rec = recordingSpawn((args, r) => {
        if (args.join(" ") !== "cat-file --batch-check") return r;
        const lines = String(r.stdout).split("\n");
        const [oid, type, size] = (lines[1] ?? "").split(" ");
        lines[1] =
          field === "oid"
            ? `${"0".repeat((oid ?? "").length)} ${type ?? ""} ${size ?? ""}`
            : `${oid ?? ""} ${type ?? ""} ${String(Number(size) + 1)}`;
        return { ...r, stdout: lines.join("\n") };
      });
      const batched = census(root, {
        batch: true,
        git: createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn }),
      });
      const single = census(root, { batch: false });
      expect(strip(batched.result)).toEqual(strip(single.result));
      expect(batched.singleReads).toHaveLength(3);
    }
  });

  it("falls back to single reads when a batch call exits non-zero or answers the wrong count", () => {
    root = initRepo();
    for (let i = 0; i < 2; i += 1)
      writeTracked(root, `xbrief/active/s${String(i)}.xbrief.json`, brief(`s${String(i)}`));
    commit(root);
    const cases: Array<
      (
        args: readonly string[],
        r: SpawnSyncReturns<string | Buffer>,
      ) => SpawnSyncReturns<string | Buffer>
    > = [
      (args, r) => (args.join(" ") === "cat-file --batch" ? { ...r, status: 128 } : r),
      (args, r) => (args.join(" ") === "cat-file --batch-check" ? { ...r, stdout: "" } : r),
      (args, r) =>
        args.join(" ") === "cat-file --batch-check" ? { ...r, stdout: "garbage line\nx\n" } : r,
      (args, r) =>
        args.join(" ") === "cat-file --batch"
          ? { ...r, stdout: Buffer.concat([r.stdout as Buffer, Buffer.from("extra")]) }
          : r,
    ];
    for (const rewrite of cases) {
      const rec = recordingSpawn(rewrite);
      const batched = census(root, {
        batch: true,
        git: createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn }),
      });
      expect(batched.result.kind).toBe("ok");
      expect(batched.singleReads).toHaveLength(2);
    }
  });

  it("does not fall back when a batch call reaches the limit in enforce mode", () => {
    root = initRepo();
    writeTracked(root, "xbrief/active/s.xbrief.json", brief("s"));
    commit(root);
    const rec = recordingSpawn((args, r) =>
      args.join(" ") === "cat-file --batch"
        ? ({
            ...r,
            status: null,
            signal: "SIGKILL",
            error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
          } as SpawnSyncReturns<string | Buffer>)
        : r,
    );
    const git = createScopeProvenanceGit({ timeoutSeconds: 5, mode: "enforce", spawn: rec.spawn });
    expect(() => census(root as string, { batch: true, git })).toThrow(GitCallTimeoutError);
    expect(rec.calls.filter((c) => c[0] === "show")).toHaveLength(0);
  });

  it("returns an empty map without a batch call when nothing is eligible", () => {
    root = initRepo();
    commit(root);
    const rec = recordingSpawn();
    const texts = readBlobsInBatches({
      git: createScopeProvenanceGit({ timeoutSeconds: 0, spawn: rec.spawn }),
      projectRoot: root,
      ref: "HEAD",
      paths: ["xbrief/active/é.xbrief.json"],
    });
    expect(texts?.size).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("reports an ls-tree failure as a census error", () => {
    root = initRepo();
    commit(root);
    const r = census(root, { batch: true, ref: "no-such-ref" });
    expect(r.result.kind).toBe("error");
  });
});
