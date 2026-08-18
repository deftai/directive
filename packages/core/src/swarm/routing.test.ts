import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  dispatchProviderFromRuntime,
  emptyHostDetectProbes,
  HOST_DETECT_PROBE_NAMES,
  loadRoutingFile,
  ROUTING_MODE_HARNESS_DEFAULT,
  ROUTING_MODE_PINNED,
  type RoutingFile,
  resolveDispatchProvider,
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

  it("reads grok-build harness-default as grok without blocking (#3469)", () => {
    const grokBuildFile: RoutingFile = {
      "grok-build": {
        "leaf-implementation": { model: null, mode: ROUTING_MODE_HARNESS_DEFAULT },
      },
    };
    const r = resolveModelRoute(grokBuildFile, "grok", "leaf-implementation");
    expect(r.decided).toBe(true);
    expect(r.model).toBeNull();
    expect(r.mode).toBe(ROUTING_MODE_HARNESS_DEFAULT);
    expect(r.source).toBe("harness-default explicit");
  });

  it("ignores a grok-build pin so the dead key cannot fail-close grok (#3469)", () => {
    const grokBuildFile: RoutingFile = {
      "grok-build": {
        "leaf-implementation": { model: "grok-4.6", mode: ROUTING_MODE_PINNED },
      },
    };
    const r = resolveModelRoute(grokBuildFile, "grok", "leaf-implementation");
    expect(r.decided).toBe(false);
    expect(r.source).toBe("undecided");
    expect(r.error).toBeNull();
  });

  it("prefers the live grok key over a grok-build file key (#3469)", () => {
    const both: RoutingFile = {
      grok: {
        "leaf-implementation": { model: null, mode: ROUTING_MODE_HARNESS_DEFAULT },
      },
      "grok-build": {
        "leaf-implementation": { model: "grok-4.6", mode: ROUTING_MODE_PINNED },
      },
    };
    const r = resolveModelRoute(both, "grok", "leaf-implementation");
    expect(r.decided).toBe(true);
    expect(r.model).toBeNull();
    expect(r.source).toBe("harness-default explicit");
  });
});

describe("dispatchProviderFromRuntime", () => {
  it("maps grok, cursor, openclaw, and claude variants", () => {
    expect(dispatchProviderFromRuntime("grok-build")).toBe("grok");
    expect(dispatchProviderFromRuntime("cursor-cloud")).toBe("cursor");
    expect(dispatchProviderFromRuntime("CURSOR")).toBe("cursor");
    expect(dispatchProviderFromRuntime("openclaw")).toBe("openclaw");
    expect(dispatchProviderFromRuntime("OPENCLAW-main")).toBe("openclaw");
    expect(dispatchProviderFromRuntime("claude-code")).toBe("claude");
    expect(dispatchProviderFromRuntime("CLAUDE")).toBe("claude");
  });
  it("passes through unknown and defaults empty", () => {
    expect(dispatchProviderFromRuntime("warp")).toBe("warp");
    expect(dispatchProviderFromRuntime("")).toBe("unknown");
  });
});

describe("resolveDispatchProvider (#1877 / #2875)", () => {
  it("maps Cursor env signals to cursor even when runtime_mode would be cloud-headless", () => {
    expect(resolveDispatchProvider({ CURSOR_AGENT: "1", CI: "true" })).toBe("cursor");
    expect(resolveDispatchProvider({ CURSOR_COMPOSER: "1" })).toBe("cursor");
  });

  it("maps Claude Code signals to claude (#3134)", () => {
    expect(resolveDispatchProvider({ DEFT_PROBE_CLAUDE_CODE: "1" })).toBe("claude");
    expect(resolveDispatchProvider({ DEFT_HAS_CLAUDE_AGENT: "true" })).toBe("claude");
    expect(resolveDispatchProvider({ CLAUDECODE: "1" })).toBe("claude");
    expect(resolveDispatchProvider({ CLAUDE_CODE: "yes" })).toBe("claude");
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "claude-code" })).toBe("claude");
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "claude" })).toBe("claude");
  });

  it("prefers claude over CI cloud-headless when Claude signals are set (#3134)", () => {
    expect(resolveDispatchProvider({ CI: "true", CLAUDECODE: "1" })).toBe("claude");
    expect(resolveDispatchProvider({ CI: "true", DEFT_PROBE_CLAUDE_CODE: "1" })).toBe("claude");
  });

  it("Cursor still wins over Claude env when CURSOR_* is set (#3134)", () => {
    expect(resolveDispatchProvider({ CURSOR_COMPOSER: "1", CLAUDECODE: "1" })).toBe("cursor");
  });

  it("maps OpenClaw sessions_spawn signals to openclaw (#2875)", () => {
    expect(resolveDispatchProvider({ OPENCLAW: "1" })).toBe("openclaw");
    expect(resolveDispatchProvider({ DEFT_HAS_SESSIONS_SPAWN: "true" })).toBe("openclaw");
    expect(resolveDispatchProvider({ DEFT_PROBE_SESSIONS_SPAWN: "yes" })).toBe("openclaw");
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "openclaw" })).toBe("openclaw");
  });

  it("prefers openclaw over CI cloud-headless when sessions_spawn signals are set (#2875)", () => {
    expect(resolveDispatchProvider({ CI: "true", OPENCLAW: "1" })).toBe("openclaw");
    expect(resolveDispatchProvider({ CI: "true", DEFT_HAS_SESSIONS_SPAWN: "true" })).toBe(
      "openclaw",
    );
  });

  it("maps grok-build signals to grok", () => {
    expect(resolveDispatchProvider({ GROK_BUILD: "true" })).toBe("grok");
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "grok-build" })).toBe("grok");
  });

  it("maps the same grok probes probeMonitoringTier already uses (#3469)", () => {
    expect(resolveDispatchProvider({ DEFT_HAS_SPAWN_SUBAGENT: "1" })).toBe("grok");
    expect(resolveDispatchProvider({ DEFT_PROBE_GROK_BUILD: "true" })).toBe("grok");
    expect(resolveDispatchProvider({ DEFT_PROBE_SPAWN_SUBAGENT: "yes" })).toBe("grok");
  });

  it("lists empty host-detect probes for the honesty line (#3469)", () => {
    expect(emptyHostDetectProbes({})).toEqual([...HOST_DETECT_PROBE_NAMES]);
    expect(emptyHostDetectProbes({ GROK_BUILD: "1" })).not.toContain("GROK_BUILD");
    expect(emptyHostDetectProbes({ DEFT_HAS_SPAWN_SUBAGENT: "true" })).not.toContain(
      "DEFT_HAS_SPAWN_SUBAGENT",
    );
  });

  it("maps DEFT_AGENT_RUNTIME cloud/headless to cloud-headless", () => {
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "cloud" })).toBe("cloud-headless");
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "headless" })).toBe("cloud-headless");
  });

  it("maps CI without Cursor composer to cloud-headless", () => {
    expect(resolveDispatchProvider({ CI: "true" })).toBe("cloud-headless");
    expect(resolveDispatchProvider({ GITHUB_ACTIONS: "true" })).toBe("cloud-headless");
    expect(resolveDispatchProvider({ BUILDKITE: "1" })).toBe("cloud-headless");
  });

  it("returns unknown for a plain local shell", () => {
    expect(resolveDispatchProvider({})).toBe("unknown");
  });

  it("treats whitespace-only DEFT_AGENT_RUNTIME as non-openclaw", () => {
    expect(resolveDispatchProvider({ DEFT_AGENT_RUNTIME: "   " })).toBe("unknown");
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
    writeModelDecision(dir, path, "cursor", "leaf-implementation", { model: "composer-2.5-fast" });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["leaf-implementation"]?.model).toBe("composer-2.5-fast");
    expect(data?.cursor?.["leaf-implementation"]?.mode).toBe(ROUTING_MODE_PINNED);
    expect(typeof data?.cursor?.["leaf-implementation"]?.decidedAt).toBe("string");
  });

  it("records an explicit harness default (model null)", () => {
    writeModelDecision(dir, path, "cursor", "review-monitor", { model: null });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["review-monitor"]?.model).toBeNull();
    expect(data?.cursor?.["review-monitor"]?.mode).toBe(ROUTING_MODE_HARNESS_DEFAULT);
  });

  it("merges additional roles without clobbering existing ones", () => {
    writeModelDecision(dir, path, "cursor", "leaf-implementation", { model: "composer-2.5-fast" });
    writeModelDecision(dir, path, "cursor", "orchestrator", { model: "gpt-5.5-medium" });
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["leaf-implementation"]?.model).toBe("composer-2.5-fast");
    expect(data?.cursor?.orchestrator?.model).toBe("gpt-5.5-medium");
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("rejects prototype-polluting provider/role keys (CodeQL #52)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        writeModelDecision(dir, path, key, "leaf-implementation", { model: "x" }),
      ).toThrow();
      expect(() => writeModelDecision(dir, path, "cursor", key, { model: "x" })).toThrow();
    }
    // Object.prototype must be untouched by the attempted injection.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("does not pollute via a hostile on-disk __proto__ key on a later write (CodeQL #52)", () => {
    mkdirSync(join(dir, ".deft"), { recursive: true });
    // JSON.parse creates an own "__proto__" property (it does not pollute the
    // prototype), so a hostile routing file on disk can carry one. A later
    // legitimate write must land on the null-prototype targets, never reach
    // Object.prototype, and must preserve the real providers.
    writeFileSync(path, JSON.stringify({ __proto__: { polluted: true }, cursor: {} }), "utf8");
    writeModelDecision(dir, path, "cursor", "leaf-implementation", { model: "composer-2.5-fast" });
    expect(Object.prototype).not.toHaveProperty("polluted");
    const data = loadRoutingFile(path).data;
    expect(data?.cursor?.["leaf-implementation"]?.model).toBe("composer-2.5-fast");
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("writeModelDecision symlink containment (#2781)", () => {
  itSymlink("refuses routing.local.json when it is a symlink to an external victim file", () => {
    const root = mkdtempSync(join(tmpdir(), "routing-symlink-target-"));
    const escapeDir = mkdtempSync(join(tmpdir(), "routing-symlink-victim-"));
    const victim = join(escapeDir, "routing.local.json");
    writeFileSync(victim, "victim\n", "utf8");
    mkdirSync(join(root, ".deft"), { recursive: true });
    const routePath = join(root, ".deft", "routing.local.json");
    symlinkSync(victim, routePath);
    expect(() =>
      writeModelDecision(root, routePath, "cursor", "leaf-implementation", {
        model: "composer-2.5-fast",
      }),
    ).toThrow(ProjectionContainmentError);
    // assertWriteTargetSafe fires before containedWrite on this path.
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    rmSync(root, { recursive: true, force: true });
    rmSync(escapeDir, { recursive: true, force: true });
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
