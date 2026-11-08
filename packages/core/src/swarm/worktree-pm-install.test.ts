/**
 * AC14.25 worktree PM install unit tests.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectWorktreePm,
  installWorktreePackages,
  OUTER_VISIBLE_RUNTIME_PIN_REL,
  prepareLinkedWorktree,
  resolvePresenterSessionId,
  runtimePinMatchesRequest,
  worktreeHasRuntimePin,
} from "./worktree-pm-install.js";

function fixture(pkg: Record<string, unknown>, lock?: "npm" | "pnpm"): string {
  const root = mkdtempSync(join(tmpdir(), "wt-pm-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
  if (lock === "npm") writeFileSync(join(root, "package-lock.json"), "{}\n");
  if (lock === "pnpm") writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  return root;
}

describe("worktree-pm-install (AC14.25)", () => {
  it("detects npm vs pnpm from lockfiles", () => {
    expect(detectWorktreePm(fixture({ name: "x" }, "npm"))).toBe("npm");
    expect(detectWorktreePm(fixture({ name: "x" }, "pnpm"))).toBe("pnpm");
  });

  it("worktreeHasRuntimePin reads exact runtime pin", () => {
    const root = fixture({
      name: "x",
      devDependencies: { "@deftai/directive-runtime": "1.2.3" },
    });
    expect(worktreeHasRuntimePin(root)).toBe(true);
    expect(worktreeHasRuntimePin(fixture({ name: "y" }))).toBe(false);
  });

  it("skips when package.json absent", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-pm-empty-"));
    const r = installWorktreePackages(root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skipped).toBe(true);
  });

  it("runs pm install via seam and requires runtime node_modules when pinned", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const calls: string[][] = [];
    const r = installWorktreePackages(root, {
      runner: (cmd, args, cwd) => {
        calls.push([cmd, ...args, cwd]);
        const runtime = join(root, "node_modules", "@deftai", "directive-runtime");
        mkdirSync(join(runtime, "dist"), { recursive: true });
        writeFileSync(
          join(runtime, "package.json"),
          JSON.stringify({ name: "@deftai/directive-runtime", version: "1.2.3" }),
        );
        writeFileSync(join(runtime, "dist", "hook-bin.js"), "export {};\n");
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![0]).toBe("npm");
  });

  it("fails closed when PM install exits nonzero for a pinned worktree", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const r = installWorktreePackages(root, {
      runner: () => ({ status: 1, stdout: "", stderr: "boom" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/boom|failed/i);
  });

  it("fails closed when install succeeds but runtime package is missing", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const r = installWorktreePackages(root, {
      runner: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/outer-visible pin missing/i);
  });

  it("refuses Yarn lockfiles", () => {
    const root = fixture({ name: "x" });
    writeFileSync(join(root, "yarn.lock"), "");
    const r = installWorktreePackages(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Yarn|Bun/i);
  });
});

describe("prepareLinkedWorktree (#6100)", () => {
  it("resolvePresenterSessionId prefers DEFT then GROK (#6100)", () => {
    expect(resolvePresenterSessionId("explicit", {})).toBe("explicit");
    expect(resolvePresenterSessionId(undefined, { DEFT_SESSION_ID: "d1" })).toBe("d1");
    expect(resolvePresenterSessionId(undefined, { GROK_SESSION_ID: "g1" })).toBe("g1");
    expect(
      resolvePresenterSessionId(undefined, { DEFT_SESSION_ID: "d1", GROK_SESSION_ID: "g1" }),
    ).toBe("d1");
    expect(resolvePresenterSessionId(undefined, {})).toBe("");
  });

  it("admits live owner when only GROK_SESSION_ID is set (#6100)", () => {
    const repo = mkdtempSync(join(tmpdir(), "prep-grok-owner-"));
    execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "prep-grok-owner",
        private: true,
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      }),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
    const wt = join(repo, "wt");
    execFileSync("git", ["worktree", "add", "--detach", "-q", wt], { cwd: repo, encoding: "utf8" });
    const now = new Date().toISOString();
    mkdirSync(join(wt, ".deft"), { recursive: true });
    writeFileSync(
      join(wt, ".deft", "occupancy.json"),
      JSON.stringify({
        session_id: "grok-owner-1",
        worktree_path: wt,
        claimed_at: now,
        heartbeat_at: now,
        intent: "mutation",
        host: "none",
        address: "none",
        grants: [],
      }),
    );
    const prevDeft = process.env.DEFT_SESSION_ID;
    const prevGrok = process.env.GROK_SESSION_ID;
    delete process.env.DEFT_SESSION_ID;
    process.env.GROK_SESSION_ID = "grok-owner-1";
    try {
      const r = prepareLinkedWorktree(wt, {
        repoRoot: repo,
        requirePinOnly: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("pin-missing");
    } finally {
      if (prevDeft === undefined) delete process.env.DEFT_SESSION_ID;
      else process.env.DEFT_SESSION_ID = prevDeft;
      if (prevGrok === undefined) delete process.env.GROK_SESSION_ID;
      else process.env.GROK_SESSION_ID = prevGrok;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses live stranger lease before any PM or deposit call", () => {
    const repo = mkdtempSync(join(tmpdir(), "prep-lease-"));
    execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "prep-lease",
        private: true,
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      }),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
    const wt = join(repo, "wt");
    execFileSync("git", ["worktree", "add", "--detach", "-q", wt], { cwd: repo, encoding: "utf8" });
    const now = new Date().toISOString();
    mkdirSync(join(wt, ".deft"), { recursive: true });
    writeFileSync(
      join(wt, ".deft", "occupancy.json"),
      JSON.stringify({
        session_id: "owner-other",
        worktree_path: wt,
        claimed_at: now,
        heartbeat_at: now,
        intent: "mutation",
        host: "none",
        address: "none",
        grants: [],
      }),
    );
    let pmCalls = 0;
    let depositCalls = 0;
    const r = prepareLinkedWorktree(wt, {
      repoRoot: repo,
      presenterSessionId: "stranger-me",
      reconstitute: () => {
        depositCalls += 1;
        return {
          status: "skipped",
          source: null,
          dest: join(wt, ".deft", "core"),
          message: "test",
        };
      },
      runner: () => {
        pmCalls += 1;
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("live-stranger-lease");
    expect(pmCalls).toBe(0);
    expect(depositCalls).toBe(0);
    rmSync(repo, { recursive: true, force: true });
  });
  it("does not skip install when outer pin exists but installed runtime mismatches request", () => {
    const repo = mkdtempSync(join(tmpdir(), "prep-stale-"));
    execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "prep-stale",
        private: true,
        devDependencies: { "@deftai/directive-runtime": "9.9.9" },
      }),
    );
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
    const wt = join(repo, "wt");
    execFileSync("git", ["worktree", "add", "--detach", "-q", wt], { cwd: repo, encoding: "utf8" });
    // Stale installed runtime 1.0.0 under outer-visible pin path tree
    const runtimePkg = join(wt, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(join(runtimePkg, "dist"), { recursive: true });
    writeFileSync(
      join(runtimePkg, "package.json"),
      JSON.stringify({ name: "@deftai/directive-runtime", version: "1.0.0" }),
    );
    writeFileSync(join(runtimePkg, "dist", "hook-bin.js"), "export {};\n");
    expect(runtimePinMatchesRequest(wt)).toBe(false);
    let pmCalls = 0;
    const r = prepareLinkedWorktree(wt, {
      repoRoot: repo,
      presenterSessionId: "owner",
      runner: () => {
        pmCalls += 1;
        // Simulate install refreshing to requested version + pin
        writeFileSync(
          join(runtimePkg, "package.json"),
          JSON.stringify({ name: "@deftai/directive-runtime", version: "9.9.9" }),
        );
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skippedInstall).toBe(false);
    expect(pmCalls).toBeGreaterThan(0);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when PM ok but outer-visible pin missing after retry-shaped install", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const r = installWorktreePackages(root, {
      runner: (_cmd, args) => {
        // npm ci fails then install succeeds without writing hook-bin
        if (args[0] === "ci") return { status: 1, stdout: "", stderr: "ci fail" };
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/outer-visible pin missing/i);
    expect(OUTER_VISIBLE_RUNTIME_PIN_REL).toContain("hook-bin.js");
  });
});
