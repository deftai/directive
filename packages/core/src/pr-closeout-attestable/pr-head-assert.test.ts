import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkingTreeIsPrHead,
  classifyLifecycleDirty,
  fetchPrHeadShaViaApi,
  findWorktreeAtSha,
  formatLifecycleDirtyRemediation,
  LIFECYCLE_STATUS_UNREADABLE,
  parseLifecyclePorcelainEntries,
  refuseDirtyLifecycle,
  resolveLifecycleDirty,
  shasMatch,
} from "./pr-head-assert.js";

describe("pr-head-assert helpers (#3875)", () => {
  it("matches full and abbreviated SHAs either way", () => {
    const full = "abcdef0123456789abcdef0123456789abcdef01";
    expect(shasMatch(full, full.slice(0, 7))).toBe(true);
    expect(shasMatch(full.slice(0, 7), full)).toBe(true);
    expect(shasMatch(full, "deadbeef")).toBe(false);
    expect(shasMatch("", full)).toBe(false);
    expect(shasMatch("abc", full)).toBe(false);
  });

  it("parses head.sha from pulls JSON", () => {
    const sha = "d".repeat(40);
    const runGh = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: { sha } }),
      stderr: "",
    });
    expect(fetchPrHeadShaViaApi(12, "deftai/directive", runGh)).toBe(sha);
  });

  it("returns null when pulls JSON is missing head.sha", () => {
    const runGh = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: {} }),
      stderr: "",
    });
    expect(fetchPrHeadShaViaApi(12, "deftai/directive", runGh)).toBeNull();
  });

  it("assertWorkingTreeIsPrHead fails closed on mismatch", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "b".repeat(40),
        resolveWorktreeAtSha: () => ({ status: "absent" }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("is not PR #7 head");
    }
  });

  it("assertWorkingTreeIsPrHead fails closed when worktree list errors", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "b".repeat(40),
        resolveWorktreeAtSha: () => ({
          status: "error",
          message: "cannot list linked worktrees under /tmp/unused (git worktree list exited 128)",
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/cannot list linked worktrees|unverified/);
    }
  });

  it("assertWorkingTreeIsPrHead can be disabled for seams", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      { enabled: false },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a dirty lifecycle tree on the matched PR head", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "a".repeat(40),
        checkLifecycleDirty: true,
        classifyLifecycleDirty: () => ({
          status: "dirty",
          entries: [{ x: "?", y: "?", path: "xbrief/active/story.xbrief.json" }],
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("uncommitted xbrief/vbrief");
      expect(result.reason).toBe("lifecycle-dirty");
    }
  });

  it("resolves a linked worktree when caller HEAD is not the PR head", () => {
    const prHead = "b".repeat(40);
    const result = assertWorkingTreeIsPrHead(
      "/tmp/primary",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: prHead,
        resolveWorktreeAtSha: () => ({ status: "found", path: "/tmp/pr-worktree" }),
        resolveLocalHeadSha: (root) => (root === "/tmp/pr-worktree" ? prHead : "a".repeat(40)),
        classifyLifecycleDirty: () => ({ status: "clean" }),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedProjectRoot).toBe("/tmp/pr-worktree");
      expect(result.localHeadSha).toBe(prHead);
    }
  });
});

describe("pr-head-assert Prefer-A #6128", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function git(cwd: string, args: string[]): void {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
    if ((r.status ?? 1) !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  }

  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-6128-repo-"));
    temps.push(root);
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "test"]);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "story.xbrief.json"), "{}\n");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "init"]);
    return root;
  }

  it("parseLifecyclePorcelainEntries undoes C-quoting", () => {
    const entries = parseLifecyclePorcelainEntries(' D "xbrief/active/weird\\nname.json"\n');
    expect(entries).toEqual([{ x: " ", y: "D", path: "xbrief/active/weird\nname.json" }]);
  });

  it("resolveLifecycleDirty is behaviour-identical wrapper", () => {
    expect(resolveLifecycleDirty).toBeTypeOf("function");
    const cleanRoot = initRepo();
    expect(resolveLifecycleDirty(cleanRoot)).toBeNull();

    writeFileSync(join(cleanRoot, "xbrief", "active", "extra.xbrief.json"), "{}\n");
    const dirtySample = resolveLifecycleDirty(cleanRoot);
    expect(dirtySample).not.toBeNull();
    expect(dirtySample).toContain("xbrief/active/extra.xbrief.json");

    // Unverifiable: non-repo path → non-null sentinel (never clean).
    const bogus = join(tmpdir(), `deft-6128-no-git-${String(Date.now())}`);
    mkdirSync(bogus, { recursive: true });
    temps.push(bogus);
    const unread = resolveLifecycleDirty(bogus);
    expect(unread).toBe(LIFECYCLE_STATUS_UNREADABLE);
  });

  it("refuseDirtyLifecycle stamps reason and deletions-only remediation", () => {
    const refused = refuseDirtyLifecycle("/tmp/dirty-root", {
      status: "dirty",
      entries: [{ x: "D", y: " ", path: "xbrief/active/story.xbrief.json" }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("lifecycle-dirty");
    expect(refused.message).toContain(
      "git -C '/tmp/dirty-root' checkout HEAD -- 'xbrief/active/story.xbrief.json'",
    );
    expect(refused.message).not.toContain("git stash push -u");
  });

  it("formatLifecycleDirtyRemediation buckets modify vs untracked", () => {
    expect(
      formatLifecycleDirtyRemediation("/r", [{ x: "M", y: " ", path: "xbrief/active/a.json" }]),
    ).toMatch(/Do not bare-checkout/);
    expect(
      formatLifecycleDirtyRemediation("/r", [{ x: "?", y: "?", path: "xbrief/active/u.json" }]),
    ).toMatch(/untracked-only/);
    expect(
      formatLifecycleDirtyRemediation("/r", [
        { x: "D", y: " ", path: "xbrief/active/d.json" },
        { x: "M", y: " ", path: "xbrief/active/m.json" },
      ]),
    ).toMatch(/excludes modified entries/);
    // MD (index modify + worktree delete): must not appear in restore path list (Greptile P1).
    const md = formatLifecycleDirtyRemediation("/r", [
      { x: "M", y: "D", path: "xbrief/active/md.json" },
      { x: "D", y: " ", path: "xbrief/active/pure-d.json" },
    ]);
    expect(md).toMatch(/excludes modified entries/);
    expect(md).toContain("'xbrief/active/pure-d.json'");
    expect(md).not.toContain("'xbrief/active/md.json'");
    expect(md).not.toMatch(/checkout HEAD --[^\n]*md\.json/);
  });

  it("candidate-zero dirty + worktree-list error → lifecycle-dirty one-poll reason", () => {
    let classifyCalls = 0;
    const result = assertWorkingTreeIsPrHead(
      "/tmp/caller",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "a".repeat(40),
        checkLifecycleDirty: true,
        classifyLifecycleDirty: () => {
          classifyCalls += 1;
          return {
            status: "dirty",
            entries: [{ x: "D", y: " ", path: "xbrief/active/story.xbrief.json" }],
          };
        },
        resolveWorktreeAtSha: () => ({
          status: "error",
          message: "cannot list linked worktrees under /tmp/caller (git worktree list exited 128)",
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("lifecycle-dirty");
      expect(result.message).toContain("checkout HEAD --");
      expect(result.message).not.toContain("cannot list linked worktrees");
    }
    expect(classifyCalls).toBeGreaterThanOrEqual(1);
  });

  it("unverifiable status never stamps lifecycle-dirty and never prints discard", () => {
    let classifyCalls = 0;
    const result = assertWorkingTreeIsPrHead(
      "/tmp/caller",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "a".repeat(40),
        checkLifecycleDirty: true,
        classifyLifecycleDirty: () => {
          classifyCalls += 1;
          return { status: "unverifiable", diagnostic: LIFECYCLE_STATUS_UNREADABLE };
        },
        resolveWorktreeAtSha: () => ({ status: "absent" }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeUndefined();
      expect(result.message).toContain("unverifiable");
      expect(result.message).toContain("No discard remediation");
      expect(result.message).not.toContain("discard local lifecycle edits");
    }
    expect(classifyCalls).toBeGreaterThanOrEqual(1);
  });

  it("real-git prefer-clean: dirty caller at tip selects clean sibling", () => {
    const primary = initRepo();
    const sha = spawnSync("git", ["-C", primary, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
    const sibling = mkdtempSync(join(tmpdir(), "deft-6128-sib-"));
    temps.push(sibling);
    git(primary, ["worktree", "add", sibling, "HEAD"]);
    // Dirty primary lifecycle (deletion of tracked brief).
    rmSync(join(primary, "xbrief", "active", "story.xbrief.json"));

    const ranked = findWorktreeAtSha(primary, sha, classifyLifecycleDirty);
    expect(ranked.status).toBe("found");
    if (ranked.status === "found") {
      const siblingLeaf = sibling.replace(/\\/g, "/").split(/[/\\]/).pop() ?? "";
      expect(siblingLeaf.length).toBeGreaterThan(0);
      expect(ranked.path.replace(/\\/g, "/")).toContain(siblingLeaf);
    }

    const result = assertWorkingTreeIsPrHead(
      primary,
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: sha,
        prHeadSha: sha,
        checkLifecycleDirty: true,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedProjectRoot).toBeDefined();
    }
  });

  it("real-git all-dirty ranked-found returns existing path with lifecycle-dirty", () => {
    const primary = initRepo();
    const sha = spawnSync("git", ["-C", primary, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
    const sibling = mkdtempSync(join(tmpdir(), "deft-6128-alldirty-"));
    temps.push(sibling);
    git(primary, ["worktree", "add", sibling, "HEAD"]);
    rmSync(join(primary, "xbrief", "active", "story.xbrief.json"));
    rmSync(join(sibling, "xbrief", "active", "story.xbrief.json"));

    const ranked = findWorktreeAtSha(primary, sha);
    expect(ranked.status).toBe("found");
    if (ranked.status === "found") {
      expect(ranked.path.length).toBeGreaterThan(0);
    }

    const result = assertWorkingTreeIsPrHead(
      primary,
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: sha,
        prHeadSha: sha,
        checkLifecycleDirty: true,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("lifecycle-dirty");
    }
  });

  it("real-git brief-less selected over briefed sets anotherShaMatchHasXbrief", () => {
    const primary = initRepo();
    const sha = spawnSync("git", ["-C", primary, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim();
    // Path-prefix so sibling sorts before primary; sparse-checkout keeps sibling clean
    // without an on-disk xbrief layout (deleting tracked xbrief would dirty it).
    const sibling = mkdtempSync(join(tmpdir(), "aaa-deft-6128-briefless-"));
    temps.push(sibling);
    git(primary, ["worktree", "add", "--no-checkout", sibling, "HEAD"]);
    git(sibling, ["sparse-checkout", "init", "--no-cone"]);
    git(sibling, ["sparse-checkout", "set", "/*", "!/xbrief", "!/xbrief/**"]);
    git(sibling, ["checkout", "HEAD"]);
    expect(existsSync(join(sibling, "xbrief"))).toBe(false);
    expect(existsSync(join(primary, "xbrief"))).toBe(true);

    const ranked = findWorktreeAtSha(primary, sha);
    expect(ranked.status).toBe("found");
    if (ranked.status === "found") {
      expect(ranked.anotherShaMatchHasXbrief).toBe(true);
      // Prefer-clean + path order should pick the brief-less clean sibling first.
      expect(resolvePathKeyForTest(ranked.path)).toBe(resolvePathKeyForTest(sibling));
    }
  });

  function resolvePathKeyForTest(p: string): string {
    try {
      const { realpathSync } = require("node:fs") as typeof import("node:fs");
      const native = (realpathSync as { native?: (path: string) => string }).native;
      return native !== undefined ? native(p) : realpathSync(p);
    } catch {
      return p.replace(/\\/g, "/").toLowerCase();
    }
  }
});
