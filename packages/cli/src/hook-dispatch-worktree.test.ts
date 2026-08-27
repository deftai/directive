import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyWorktreeOccupancy } from "@deftai/directive-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./hook-dispatch.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
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

function fixture(): { primary: string; wtA: string; wtB: string; foreign: string } {
  const base = mkdtempSync(join(tmpdir(), "cli-3794-"));
  temps.push(base);
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

function dispatchWrite(opts: { primary: string; target: string }): {
  code: number;
  body: Record<string, unknown>;
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
  const body = JSON.parse(raw) as Record<string, unknown>;
  return { code: exit, body };
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
    expect(refusedMsg).toContain("Worktree occupied");
    expect(refusedMsg.toLowerCase()).toContain(resolve(primary).toLowerCase());
    expect(refusedMsg.toLowerCase()).not.toContain(resolve(foreign).toLowerCase());
  });
});
