import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchProviderFromRuntime,
  loadRoutingFile,
  ROUTING_MODE_HARNESS_DEFAULT,
  ROUTING_MODE_PINNED,
  type RoutingFile,
  resolveModelRoute,
  resolveRoutingPath,
  SWARM_WORKER_ROLES,
  writeModelDecision,
} from "./routing.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "routing-"));
}

describe("resolveModelRoute (tri-state by key presence)", () => {
  const file: RoutingFile = {
    cursor: {
      "leaf-implementation": { model: "composer-2.5-fast", mode: ROUTING_MODE_PINNED },
      "review-monitor": { model: null, mode: ROUTING_MODE_HARNESS_DEFAULT },
      "bad-object": "nope" as unknown as { model: null },
      "bad-model": { model: "" },
    },
  };

  it("pinned: key present with a model slug", () => {
    const r = resolveModelRoute(file, "cursor", "leaf-implementation");
    expect(r.decided).toBe(true);
    expect(r.model).toBe("composer-2.5-fast");
    expect(r.mode).toBe(ROUTING_MODE_PINNED);
    expect(r.source).toBe("cursor-route");
    expect(r.error).toBeNull();
  });

  it("explicit harness-default: key present with model null is a decision, not absence", () => {
    const r = resolveModelRoute(file, "cursor", "review-monitor");
    expect(r.decided).toBe(true);
    expect(r.model).toBeNull();
    expect(r.mode).toBe(ROUTING_MODE_HARNESS_DEFAULT);
    expect(r.source).toBe("harness-default explicit");
  });

  it("undecided: key absent (role)", () => {
    const r = resolveModelRoute(file, "cursor", "orchestrator");
    expect(r.decided).toBe(false);
    expect(r.source).toBe("undecided");
    expect(r.error).toBeNull();
  });

  it("undecided: provider absent", () => {
    const r = resolveModelRoute(file, "grok", "leaf-implementation");
    expect(r.decided).toBe(false);
    expect(r.source).toBe("undecided");
  });

  it("undecided: null routing file", () => {
    expect(resolveModelRoute(null, "cursor", "leaf-implementation").decided).toBe(false);
  });

  it("invalid: decision is not an object", () => {
    const r = resolveModelRoute(file, "cursor", "bad-object");
    expect(r.decided).toBe(true);
    expect(r.source).toBe("invalid");
    expect(r.error).not.toBeNull();
  });

  it("invalid: empty-string model", () => {
    const r = resolveModelRoute(file, "cursor", "bad-model");
    expect(r.source).toBe("invalid");
  });
});

describe("dispatchProviderFromRuntime", () => {
  it("maps grok and cursor variants", () => {
    expect(dispatchProviderFromRuntime("grok-build")).toBe("grok");
    expect(dispatchProviderFromRuntime("cursor-cloud")).toBe("cursor");
    expect(dispatchProviderFromRuntime("CURSOR")).toBe("cursor");
  });
  it("passes through unknown and defaults empty", () => {
    expect(dispatchProviderFromRuntime("warp")).toBe("warp");
    expect(dispatchProviderFromRuntime("")).toBe("unknown");
  });
});

describe("resolveRoutingPath", () => {
  const saved = process.env.DEFT_ROUTING_PATH;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.DEFT_ROUTING_PATH;
    } else {
      process.env.DEFT_ROUTING_PATH = saved;
    }
  });

  it("honors DEFT_ROUTING_PATH override first", () => {
    const dir = tmp();
    const override = join(dir, "custom-routes.json");
    expect(resolveRoutingPath(dir, { DEFT_ROUTING_PATH: override })).toBe(override);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads from the MAIN worktree root via git-common-dir (shared across worktrees)", () => {
    const repo = tmp();
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "f.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    const resolvedFromNested = resolveRoutingPath(nested, {});
    expect(resolvedFromNested).toBe(join(repo, ".deft", "routing.local.json"));
    rmSync(repo, { recursive: true, force: true });
  });

  it("falls back to startDir when not a git work tree", () => {
    const dir = tmp();
    expect(resolveRoutingPath(dir, {})).toBe(join(dir, ".deft", "routing.local.json"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadRoutingFile", () => {
  it("returns null data (no error) when absent", () => {
    const dir = tmp();
    const r = loadRoutingFile(join(dir, "routing.local.json"));
    expect(r.data).toBeNull();
    expect(r.error).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns config error on malformed JSON", () => {
    const dir = tmp();
    const path = join(dir, "routing.local.json");
    writeFileSync(path, "{not json");
    expect(loadRoutingFile(path).error).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-object top level", () => {
    const dir = tmp();
    const path = join(dir, "routing.local.json");
    writeFileSync(path, "[]");
    expect(loadRoutingFile(path).error).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeModelDecision", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = tmp();
    path = join(dir, ".deft", "routing.local.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file + parent dir and stamps decidedAt", () => {
    writeModelDecision(path, "cursor", "leaf-implementation", { model: "composer-2.5-fast" });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["leaf-implementation"]?.model).toBe("composer-2.5-fast");
    expect(data?.cursor?.["leaf-implementation"]?.mode).toBe(ROUTING_MODE_PINNED);
    expect(typeof data?.cursor?.["leaf-implementation"]?.decidedAt).toBe("string");
  });

  it("records an explicit harness default (model null)", () => {
    writeModelDecision(path, "cursor", "review-monitor", { model: null });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["review-monitor"]?.model).toBeNull();
    expect(data?.cursor?.["review-monitor"]?.mode).toBe(ROUTING_MODE_HARNESS_DEFAULT);
  });

  it("merges additional roles without clobbering existing ones", () => {
    writeModelDecision(path, "cursor", "leaf-implementation", { model: "composer-2.5-fast" });
    writeModelDecision(path, "cursor", "orchestrator", { model: "gpt-5.5-medium" });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["leaf-implementation"]?.model).toBe("composer-2.5-fast");
    expect(data?.cursor?.["orchestrator"]?.model).toBe("gpt-5.5-medium");
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("SWARM_WORKER_ROLES", () => {
  it("carries the fixed four-role vocabulary", () => {
    expect([...SWARM_WORKER_ROLES]).toEqual([
      "leaf-implementation",
      "orchestrator",
      "review-monitor",
      "merge-release",
    ]);
  });
});
