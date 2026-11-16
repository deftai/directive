/**
 * evaluateScopeProvenance with the batched census, the in-run text map and the
 * per-call git limit (#6378): same verdict, fewer processes.
 */
import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateScopeProvenance,
  forgeApprovalGitFromRunner,
  type ScopeProvenanceOptions,
  type ScopeProvenanceResult,
} from "./evaluate.js";
import { createScopeProvenanceGit, type GitSpawn } from "./git-call.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function g(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  g(root, ["add", "--", rel]);
}

function brief(planId: string, fileScope: string[], status = "running"): string {
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8" },
      plan: { id: planId, status, metadata: { swarm: { file_scope: fileScope } } },
    },
    null,
    2,
  )}\n`;
}

/** Base: one active story plus completed briefs; impl branch edits product code. */
function fixture(opts: { extraProduct?: number; brokenCompleted?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "scope-prov-batch-"));
  g(root, ["init", "-q"]);
  g(root, ["checkout", "-q", "-b", "main"]);
  g(root, ["config", "core.autocrlf", "false"]);
  writeTracked(
    root,
    "xbrief/active/story.xbrief.json",
    brief("story-1", ["packages/core/src/foo.ts"]),
  );
  for (let i = 0; i < 12; i += 1) {
    writeTracked(
      root,
      `xbrief/completed/done-${String(i)}.xbrief.json`,
      brief(`done-${String(i)}`, [], "completed"),
    );
  }
  if (opts.brokenCompleted) writeTracked(root, "xbrief/completed/broken.xbrief.json", "{ not json");
  writeTracked(root, "packages/core/src/foo.ts", "export const a = 1;\n");
  g(root, ["commit", "-q", "-m", "base"]);
  g(root, ["branch", "base"]);
  g(root, ["checkout", "-q", "-b", "impl"]);
  writeTracked(root, "packages/core/src/foo.ts", "export const a = 2;\n");
  for (let i = 0; i < (opts.extraProduct ?? 0); i += 1) {
    writeTracked(root, `packages/core/src/extra-${String(i)}.ts`, "export {};\n");
  }
  // Touch the brief so membership and continuity run.
  writeTracked(
    root,
    "xbrief/active/story.xbrief.json",
    brief("story-1", ["packages/core/src/foo.ts"]).replace("\n}", ',\n  "note": "x"\n}'),
  );
  g(root, ["commit", "-q", "-m", "impl"]);
  return root;
}

function recording(
  rewrite?: (
    args: readonly string[],
    r: SpawnSyncReturns<string | Buffer>,
  ) => SpawnSyncReturns<string | Buffer>,
): { spawn: GitSpawn; calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> } {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawn: GitSpawn = (cmd, args, options) => {
    calls.push({ args: [...args], env: options.env });
    const r = spawnSync(cmd, [...args], options) as SpawnSyncReturns<string | Buffer>;
    return rewrite ? rewrite(args, r) : r;
  };
  return { spawn, calls };
}

function timedOut(r: SpawnSyncReturns<string | Buffer>): SpawnSyncReturns<string | Buffer> {
  const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
  return { ...r, status: null, signal: "SIGKILL", error };
}

function verdict(r: ScopeProvenanceResult): unknown {
  return { exitCode: r.exitCode, message: r.message, findings: r.findings };
}

const BASE: ScopeProvenanceOptions = { baseRef: "base", gitTimeoutSeconds: 120 };

describe("evaluateScopeProvenance with the batched census (#6378)", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });
  const make = (opts?: Parameters<typeof fixture>[0]): string => {
    const root = fixture(opts);
    roots.push(root);
    return root;
  };

  it("gives the same verdict and exit code as single reads", () => {
    for (const opts of [{}, { extraProduct: 7 }, { brokenCompleted: true }]) {
      const root = make(opts);
      const batched = evaluateScopeProvenance(root, BASE);
      const single = evaluateScopeProvenance(root, { ...BASE, censusBatch: false });
      expect(verdict(batched)).toEqual(verdict(single));
    }
  });

  it("serves later base reads from the census texts without another git process", () => {
    const root = make();
    const rec = recording();
    const result = evaluateScopeProvenance(root, { ...BASE, gitSpawn: rec.spawn });
    expect(result.exitCode).toBe(0);
    const lifecycleShows = rec.calls.filter(
      (c) =>
        c.args[0] === "show" &&
        /:xbrief\/(active|pending|completed|cancelled)\//.test(c.args[1] ?? ""),
    );
    expect(lifecycleShows).toEqual([]);
    const census = rec.calls.filter((c) => c.args[0] === "ls-tree" || c.args[0] === "cat-file");
    expect(census.length).toBeLessThan(20);
    expect(rec.calls.some((c) => c.args.join(" ") === "cat-file --batch")).toBe(true);
  });

  it("starts every git call with GIT_OPTIONAL_LOCKS=0", () => {
    const root = make();
    const rec = recording();
    evaluateScopeProvenance(root, { ...BASE, gitSpawn: rec.spawn });
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const c of rec.calls) expect(c.env?.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("keeps nothing between runs", () => {
    const root = make();
    const first = recording();
    evaluateScopeProvenance(root, { ...BASE, gitSpawn: first.spawn });
    const second = recording();
    evaluateScopeProvenance(root, { ...BASE, gitSpawn: second.spawn });
    const batches = (r: typeof first) =>
      r.calls.filter((c) => c.args.join(" ") === "cat-file --batch").length;
    expect(batches(first)).toBeGreaterThan(0);
    expect(batches(second)).toBe(batches(first));
  });

  it("uses an injected base reader or base map and starts no git batch", () => {
    const root = make();
    const rec = recording();
    const asked: string[] = [];
    const reader = (rel: string): string | null => {
      asked.push(rel);
      try {
        return g(root, ["show", `base:${rel}`]);
      } catch {
        return null;
      }
    };
    const injected = evaluateScopeProvenance(root, {
      ...BASE,
      gitSpawn: rec.spawn,
      readAtBase: reader,
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(rec.calls.some((c) => c.args[0] === "cat-file")).toBe(false);
    expect(verdict(injected)).toEqual(verdict(evaluateScopeProvenance(root, BASE)));

    const mapRec = recording();
    const baseXbriefs = new Map([
      [
        "xbrief/active/story.xbrief.json",
        g(root, ["show", "base:xbrief/active/story.xbrief.json"]),
      ],
    ]);
    evaluateScopeProvenance(root, { ...BASE, gitSpawn: mapRec.spawn, baseXbriefs });
    expect(mapRec.calls.some((c) => c.args[0] === "cat-file" || c.args[0] === "ls-tree")).toBe(
      false,
    );
  });

  it("does not change the result when phase lines are on", () => {
    const root = make({ extraProduct: 7 });
    const phases: string[] = [];
    const on = evaluateScopeProvenance(root, { ...BASE, onPhase: (p) => phases.push(p) });
    const off = evaluateScopeProvenance(root, BASE);
    expect(verdict(on)).toEqual(verdict(off));
    expect(phases[0]).toBe("base resolution");
    expect(phases).toContain("change-set read");
    expect(phases).toContain("per-story evaluation");
    expect(phases.some((p) => /^census \(\d+ briefs\)$/.test(p))).toBe(true);
  });

  it("warn mode: a batch call that reaches the limit runs again and keeps the verdict", () => {
    const root = make();
    let fired = false;
    const rec = recording((args, r) => {
      if (!fired && args.join(" ") === "cat-file --batch") {
        fired = true;
        return timedOut(r);
      }
      return r;
    });
    const warnings: string[] = [];
    const result = evaluateScopeProvenance(root, {
      ...BASE,
      gitSpawn: rec.spawn,
      onGitTimeoutWarning: (l) => warnings.push(l),
    });
    expect(verdict(result)).toEqual(verdict(evaluateScopeProvenance(root, BASE)));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('phase "census"');
    expect(warnings[0]).toContain("`git cat-file --batch`");
    // No fallback to single reads because of the limit.
    expect(rec.calls.some((c) => c.args[0] === "show" && /:xbrief\//.test(c.args[1] ?? ""))).toBe(
      false,
    );
  });

  it("enforce mode: a call that reaches the limit exits 2 with the refusal line", () => {
    const root = make();
    const rec = recording((args, r) => (args.join(" ") === "cat-file --batch" ? timedOut(r) : r));
    const result = evaluateScopeProvenance(root, {
      ...BASE,
      gitSpawn: rec.spawn,
      gitTimeoutMode: "enforce",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("scope-provenance-git-call-timeout (enforce)");
    expect(result.message).toContain('phase "census"');
    expect(result.message).toContain(
      "Remedy: deft verify:scope-provenance --git-timeout-seconds 240",
    );
    expect(rec.calls.some((c) => c.args[0] === "show" && /:xbrief\//.test(c.args[1] ?? ""))).toBe(
      false,
    );
  });

  it("enforce mode: a timeout inside a step that swallows errors still exits 2", () => {
    const root = make();
    const rec = recording((args, r) => (args[0] === "rev-parse" ? timedOut(r) : r));
    const result = evaluateScopeProvenance(root, {
      changedFiles: ["packages/core/src/foo.ts"],
      gitSpawn: rec.spawn,
      gitTimeoutMode: "enforce",
      gitTimeoutSeconds: 30,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('phase "base resolution"');
  });

  it("keeps a census that throws a non-timeout error a census read failure", () => {
    const root = make();
    const spawn: GitSpawn = (cmd, args, options) => {
      if (args[0] === "ls-tree") throw new Error("boom");
      return spawnSync(cmd, [...args], options) as SpawnSyncReturns<string | Buffer>;
    };
    const result = evaluateScopeProvenance(root, { ...BASE, gitSpawn: spawn });
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => /census read failed/.test(f.detail))).toBe(true);
  });

  it("enforce mode: a change-set call that reaches the limit exits 2", () => {
    const root = make();
    const rec = recording((args, r) => (args[0] === "diff" ? timedOut(r) : r));
    const result = evaluateScopeProvenance(root, {
      ...BASE,
      gitSpawn: rec.spawn,
      gitTimeoutMode: "enforce",
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('phase "change-set read"');
  });
});

describe("forgeApprovalGitFromRunner (#6378)", () => {
  it("reads HEAD, its parents and the origin slug through the runner", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-prov-forge-"));
    try {
      g(root, ["init", "-q"]);
      g(root, ["commit", "-q", "--allow-empty", "-m", "a"]);
      g(root, ["commit", "-q", "--allow-empty", "-m", "b"]);
      const rec = recording();
      const git = forgeApprovalGitFromRunner(
        root,
        createScopeProvenanceGit({ timeoutSeconds: 30, spawn: rec.spawn }),
      );
      expect(git.headSha()).toMatch(/^[0-9a-f]{40}$/);
      expect(git.headParents()).toHaveLength(1);
      expect(git.originRepo()).toBeNull();
      g(root, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
      expect(git.originRepo()).toBe("acme/widgets");
      expect(rec.calls.every((c) => c.env?.GIT_OPTIONAL_LOCKS === "0")).toBe(true);
      const empty = mkdtempSync(join(tmpdir(), "scope-prov-forge-empty-"));
      try {
        const none = forgeApprovalGitFromRunner(
          empty,
          createScopeProvenanceGit({ timeoutSeconds: 30 }),
        );
        expect(none.headSha()).toBeNull();
        expect(none.headParents()).toEqual([]);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
