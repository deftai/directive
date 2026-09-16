import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyWorktreeOccupancy } from "@deftai/directive-core/session";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "./hook-dispatch.js";

const ephemeralTemps: string[] = [];
const sharedTemps: string[] = [];

type LinkedFixture = { primary: string; wtA: string; wtB: string; foreign: string };
type NestedFixture = { primary: string; nested: string };

let sharedLinked: LinkedFixture | null = null;
let sharedNested: NestedFixture | null = null;

function resetLeaseFiles(root: string): void {
  rmSync(join(root, ".deft", "occupancy.json"), { force: true });
  rmSync(join(root, ".deft", "child-occupancy"), { recursive: true, force: true });
  rmSync(join(root, ".deft-directive-disable"), { force: true });
}

function resetSharedFixtures(): void {
  if (sharedLinked !== null) {
    resetLeaseFiles(sharedLinked.primary);
    resetLeaseFiles(sharedLinked.wtA);
    resetLeaseFiles(sharedLinked.wtB);
    resetLeaseFiles(sharedLinked.foreign);
  }
  if (sharedNested !== null) {
    resetLeaseFiles(sharedNested.primary);
    resetLeaseFiles(sharedNested.nested);
  }
}

afterEach(() => {
  resetSharedFixtures();
  for (const t of ephemeralTemps.splice(0)) rmSync(t, { recursive: true, force: true });
});

afterAll(() => {
  for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.dev"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["commit", "--allow-empty", "-q", "-m", "base"]);
}

function buildLinkedFixture(): LinkedFixture {
  const base = mkdtempSync(join(tmpdir(), "cli-3794-"));
  sharedTemps.push(base);
  const primary = join(base, "primary");
  const wtA = join(base, "wt-a");
  const wtB = join(base, "wt-b");
  const foreign = join(base, "foreign");
  initRepo(primary);
  git(primary, ["worktree", "add", "--detach", "-q", wtA]);
  git(primary, ["worktree", "add", "--detach", "-q", wtB]);
  initRepo(foreign);
  return { primary, wtA, wtB, foreign };
}

function fixture(): LinkedFixture {
  if (sharedLinked === null) sharedLinked = buildLinkedFixture();
  return sharedLinked;
}

function buildNestedFixture(): NestedFixture {
  const base = mkdtempSync(join(tmpdir(), "cli-3794-nested-"));
  sharedTemps.push(base);
  const primary = join(base, "primary");
  initRepo(primary);
  const nested = join(primary, ".deft-scratch", "worktrees", "story");
  mkdirSync(join(primary, ".deft-scratch", "worktrees"), { recursive: true });
  git(primary, ["worktree", "add", "--detach", "-q", nested]);
  return { primary, nested };
}

function nestedFixture(): NestedFixture {
  if (sharedNested === null) sharedNested = buildNestedFixture();
  return sharedNested;
}

beforeAll(() => {
  fixture();
  nestedFixture();
});

function dispatchWrite(opts: { primary: string; target: string }): {
  code: number;
  body: Record<string, unknown>;
  raw: string;
} {
  const out: string[] = [];
  const exit = run(["--host=grok", "--event=tool.before"], {
    readStdin: () =>
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: opts.target, contents: "x" },
        workspace_roots: [opts.primary],
      }),
    writeOut: (text) => out.push(text),
    writeErr: () => undefined,
    cwd: () => opts.primary,
    stdinEmptyRetryMs: 0,
  });
  const raw = out.join("").trim();
  const body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  return { code: exit, body, raw };
}

describe("deposited hook CLI without --project-root (#3794)", () => {
  it("gates a worktree write against the target tree, not the payload primary", () => {
    const { primary, wtA, wtB, foreign } = fixture();
    expect(wtB.length).toBeGreaterThan(0);

    applyWorktreeOccupancy(primary, { sessionId: "primary-owner", intent: "mutation" });
    const unrelated = dispatchWrite({
      primary,
      target: join(wtA, "src", "app.ts"),
    });
    expect(unrelated.body.decision).toBe("deny");
    const unrelatedMsg = String(unrelated.body.reason ?? "");
    expect(unrelatedMsg).not.toContain("primary-owner");
    expect(unrelatedMsg.toLowerCase()).toContain(resolve(primary).toLowerCase());
    expect(unrelatedMsg.toLowerCase()).toContain(resolve(wtA).toLowerCase());

    applyWorktreeOccupancy(wtA, { sessionId: "wt-owner", intent: "mutation" });
    const foreignLease = dispatchWrite({
      primary,
      target: join(wtA, "src", "app.ts"),
    });
    expect(foreignLease.body.decision).toBe("deny");
    const occupiedMsg = String(foreignLease.body.reason ?? "");
    expect(occupiedMsg).toContain("Worktree occupied");
    expect(occupiedMsg).toContain("wt-owner");
    expect(occupiedMsg).toContain("payloadRoot=");
    expect(occupiedMsg).toContain("effectiveRoot=");
    expect(occupiedMsg.toLowerCase()).toContain(resolve(wtA).toLowerCase());

    const refused = dispatchWrite({
      primary,
      target: join(foreign, "src", "app.ts"),
    });
    expect(refused.body.decision).toBe("deny");
    const refusedMsg = String(refused.body.reason ?? "");
    expect(refusedMsg).toContain("different Git repository");
    expect(refusedMsg.toLowerCase()).toContain(resolve(primary).toLowerCase());
    expect(refusedMsg.toLowerCase()).toContain(resolve(foreign).toLowerCase());
  });
});

describe("assist-scratch reclassification through the deposited CLI (#3794)", () => {
  it("stops treating worktree product files as disposable scratch", () => {
    const { primary, nested } = nestedFixture();
    const previous = process.env.DEFT_SESSION_POSTURE;
    process.env.DEFT_SESSION_POSTURE = "assist";
    try {
      const product = dispatchWrite({
        primary,
        target: join(nested, "packages", "core", "src", "app.ts"),
      });
      expect(String(product.body.reason ?? "")).not.toContain("assist scratch");
      expect(product.body.decision).toBe("deny");

      const scratch = dispatchWrite({
        primary,
        target: join(nested, ".deft-scratch", "notes.md"),
      });
      expect(scratch.body.decision).not.toBe("deny");
    } finally {
      if (previous === undefined) delete process.env.DEFT_SESSION_POSTURE;
      else process.env.DEFT_SESSION_POSTURE = previous;
    }
  });
});
