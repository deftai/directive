import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { loadRoutingFile, resolveRoutingPath, writeModelDecision } from "./routing.js";
import { routingSetMain } from "./routing-set-cli.js";
import { routingVerifyMain } from "./routing-verify-cli.js";

describe("routing-set + routing-verify CLIs", () => {
  const saved = process.env.DEFT_ROUTING_PATH;
  const cleanups: string[] = [];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.DEFT_ROUTING_PATH;
    } else {
      process.env.DEFT_ROUTING_PATH = saved;
    }
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function freshRoute(): string {
    const dir = mkdtempSync(join(tmpdir(), "routing-cli-"));
    cleanups.push(dir);
    const path = join(dir, "routing.local.json");
    process.env.DEFT_ROUTING_PATH = path;
    return dir;
  }

  it("set then verify round-trips a pinned model (exit 0)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--",
        "--provider",
        "cursor",
        "--role",
        "leaf-implementation",
        "--model",
        "composer-2.5-fast",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
    const path = resolveRoutingPath(dir, process.env);
    expect(loadRoutingFile(path).data?.cursor?.["leaf-implementation"]?.model).toBe(
      "composer-2.5-fast",
    );
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor"])).toBe(0);
  });

  it("set --harness-default records an explicit default (exit 0)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "cursor",
        "--role",
        "review-monitor",
        "--harness-default",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
  });

  it("set rejects a missing role (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--model", "x"])).toBe(2);
  });

  it("set rejects an unknown role (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--role", "nonsense", "--model", "x"])).toBe(2);
  });

  it("set rejects pin with neither --model nor --harness-default (exit 2)", () => {
    freshRoute();
    expect(routingSetMain(["--provider", "cursor", "--role", "leaf-implementation"])).toBe(2);
  });

  it("set rejects pinning a harness-bound provider (exit 2)", () => {
    freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "grok",
        "--role",
        "leaf-implementation",
        "--model",
        "grok-build",
      ]),
    ).toBe(2);
  });

  it("set ignores --model when --harness-default is also passed (exit 0, records default)", () => {
    const dir = freshRoute();
    expect(
      routingSetMain([
        "--provider",
        "cursor",
        "--role",
        "leaf-implementation",
        "--model",
        "composer-2.5-fast",
        "--harness-default",
        "--project-root",
        dir,
      ]),
    ).toBe(0);
    const path = resolveRoutingPath(dir, process.env);
    expect(loadRoutingFile(path).data?.cursor?.["leaf-implementation"]?.model).toBeNull();
  });

  it("verify rejects an unknown --roles entry (exit 2)", () => {
    const dir = freshRoute();
    expect(
      routingVerifyMain([
        "--project-root",
        dir,
        "--provider",
        "cursor",
        "--roles",
        "leaf-implemenation",
      ]),
    ).toBe(2);
  });

  it("verify --advise never blocks on undecided (exit 0)", () => {
    const dir = freshRoute();
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor", "--advise"])).toBe(0);
  });

  it("verify enforce blocks on undecided (exit 1)", () => {
    const dir = freshRoute();
    expect(routingVerifyMain(["--project-root", dir, "--provider", "cursor"])).toBe(1);
  });

  it("records a linked-worktree routing-set onto the shared main-tree file (#3827)", () => {
    const base = mkdtempSync(join(tmpdir(), "routing-wt-"));
    cleanups.push(base);
    const primary = join(base, "primary");
    const linked = join(base, "linked");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q", "-b", "master", primary]);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "--detach", "-q", linked], { cwd: primary });

    const stderrChunks: string[] = [];
    const prevStderr = process.stderr.write.bind(process.stderr);
    const prevStdout = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number;
    try {
      code = routingSetMain(
        [
          "--project-root",
          linked,
          "--provider",
          "codex",
          "--role",
          "review-monitor",
          "--model",
          "gpt-5.6-sol",
        ],
        {},
      );
    } finally {
      process.stderr.write = prevStderr;
      process.stdout.write = prevStdout;
    }

    expect(code).toBe(0);
    expect(stderrChunks.join("")).not.toMatch(/projection write refused/);
    const shared = join(primary, ".deft", "routing.local.json");
    expect(loadRoutingFile(shared).data?.codex?.["review-monitor"]?.model).toBe("gpt-5.6-sol");
    expect(existsSync(join(linked, ".deft", "routing.local.json"))).toBe(false);
  });

  it("still names the linked-vs-main mismatch when write root and path disagree (#3827)", () => {
    const base = mkdtempSync(join(tmpdir(), "routing-wt-mismatch-"));
    cleanups.push(base);
    const primary = join(base, "primary");
    const linked = join(base, "linked");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q", "-b", "master", primary]);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "--detach", "-q", linked], { cwd: primary });

    const path = resolveRoutingPath(linked, {});
    expect(path).toBe(join(primary, ".deft", "routing.local.json"));
    try {
      writeModelDecision(linked, path, "codex", "review-monitor", { model: "gpt-5.6-sol" });
      expect.fail("expected ProjectionContainmentError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectionContainmentError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("projection write refused: target ");
      expect(message).toContain(path);
      expect(message).toContain("is not nested under the project tree");
      expect(message).toContain(linked);
    }
  });

  it("routing-set with DEFT_ROUTING_PATH inside the linked worktree records that file (#3827)", () => {
    const base = mkdtempSync(join(tmpdir(), "routing-wt-override-in-"));
    cleanups.push(base);
    const primary = join(base, "primary");
    const linked = join(base, "linked");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q", "-b", "master", primary]);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "--detach", "-q", linked], { cwd: primary });

    const inside = join(linked, "routing.local.json");
    const prevStderr = process.stderr.write.bind(process.stderr);
    const prevStdout = process.stdout.write.bind(process.stdout);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number;
    try {
      code = routingSetMain(
        [
          "--project-root",
          linked,
          "--provider",
          "codex",
          "--role",
          "review-monitor",
          "--model",
          "gpt-5.6-sol",
        ],
        { DEFT_ROUTING_PATH: inside },
      );
    } finally {
      process.stderr.write = prevStderr;
      process.stdout.write = prevStdout;
    }

    expect(code).toBe(0);
    expect(loadRoutingFile(inside).data?.codex?.["review-monitor"]?.model).toBe("gpt-5.6-sol");
    expect(existsSync(join(primary, ".deft", "routing.local.json"))).toBe(false);
  });

  it("routing-set with DEFT_ROUTING_PATH outside the linked worktree exits 2 without writing (#3827)", () => {
    const base = mkdtempSync(join(tmpdir(), "routing-wt-override-out-"));
    cleanups.push(base);
    const primary = join(base, "primary");
    const linked = join(base, "linked");
    const outsideDir = join(base, "outside");
    mkdirSync(primary);
    mkdirSync(outsideDir);
    execFileSync("git", ["init", "-q", "-b", "master", primary]);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "--detach", "-q", linked], { cwd: primary });

    const outside = join(outsideDir, "routing.local.json");
    const stderrChunks: string[] = [];
    const prevStderr = process.stderr.write.bind(process.stderr);
    const prevStdout = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number;
    try {
      code = routingSetMain(
        [
          "--project-root",
          linked,
          "--provider",
          "codex",
          "--role",
          "review-monitor",
          "--model",
          "gpt-5.6-sol",
        ],
        { DEFT_ROUTING_PATH: outside },
      );
    } finally {
      process.stderr.write = prevStderr;
      process.stdout.write = prevStdout;
    }

    expect(code).toBe(2);
    expect(stderrChunks.join("")).toMatch(/projection write refused/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(primary, ".deft", "routing.local.json"))).toBe(false);
    expect(existsSync(join(linked, ".deft", "routing.local.json"))).toBe(false);
  });
});
