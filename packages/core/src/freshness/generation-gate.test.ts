import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExecFn, GitExecResult } from "../init-deposit/update-git-preflight.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { bindSessionGeneration } from "./bind.js";
import {
  inspectLocalGeneration,
  liveGenerationPath,
  nextLiveGenerationNumber,
  stampLiveGeneration,
} from "./generation.js";
import {
  decideGenerationStamp,
  describeDryRunGenerationGate,
  evaluateGenerationGate,
  evaluateGenerationMonotonicVsBase,
  GENERATION_GIT_PATH,
  GENERATION_REWIND_ERROR_CODE,
  generationFetchArgs,
  listRemotes,
  pinDeliveryTipOid,
  probeGenerationAtOid,
  recheckGenerationGateLocal,
  retiredSingletonTipRef,
} from "./generation-gate.js";
import type { LiveGeneration } from "./types.js";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-b", "master"]);
  git(cwd, ["config", "user.email", "4120@example.test"]);
  git(cwd, ["config", "user.name", "4120 fixture"]);
}

function token(generation: number, contentVersion = "0.110.0"): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      generation,
      contentVersion,
      stampedAt: "2026-09-24T00:00:00Z",
      stampedBy: "fixture",
      surfaces: { payload: contentVersion },
    },
    null,
    2,
  )}\n`;
}

function commitGeneration(cwd: string, generation: number, message: string): string {
  mkdirSync(join(cwd, ".deft"), { recursive: true });
  writeFileSync(join(cwd, GENERATION_GIT_PATH), token(generation));
  git(cwd, ["add", GENERATION_GIT_PATH]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function validLocal(generation: number, contentVersion = "0.110.0"): LiveGeneration {
  return {
    schemaVersion: 1,
    generation,
    contentVersion,
    stampedAt: "2026-09-24T00:00:00Z",
    stampedBy: "local",
    surfaces: { payload: contentVersion },
  };
}

afterEach(() => {
  while (temps.length > 0) {
    const p = temps.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("decideGenerationStamp (#4120 R1)", () => {
  it("refuses increment unless proposed > tip", () => {
    const decision = decideGenerationStamp({
      local: { kind: "valid", token: validLocal(2), raw: token(2) },
      tip: { kind: "known-at-oid", generation: 4, oid: "abc" },
      increment: true,
      contentVersion: "0.111.0",
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error_code).toBe(GENERATION_REWIND_ERROR_CODE);
      expect(decision.recovery).toMatch(/pull or rebase/);
    }
  });

  it("stamps tip+1 when local token is absent against a known tip", () => {
    expect(
      decideGenerationStamp({
        local: { kind: "absent" },
        tip: { kind: "known-at-oid", generation: 4, oid: "abc" },
        increment: true,
        contentVersion: "0.110.0",
      }),
    ).toEqual({ action: "stamp", generation: 5 });
  });

  it("allows increment when proposed > tip", () => {
    const decision = decideGenerationStamp({
      local: { kind: "valid", token: validLocal(4), raw: token(4) },
      tip: { kind: "known-at-oid", generation: 4, oid: "abc" },
      increment: true,
      contentVersion: "0.111.0",
    });
    expect(decision).toEqual({ action: "stamp", generation: 5 });
  });

  it("keeps a sufficient matching token byte-stable (no-write arm)", () => {
    const raw = token(5);
    const decision = decideGenerationStamp({
      local: { kind: "valid", token: validLocal(5), raw },
      tip: { kind: "known-at-oid", generation: 4, oid: "abc" },
      increment: false,
      contentVersion: "0.110.0",
    });
    expect(decision.action).toBe("keep-prior");
  });

  it("refuses a matching but insufficient token instead of silent write", () => {
    const decision = decideGenerationStamp({
      local: { kind: "valid", token: validLocal(2), raw: token(2) },
      tip: { kind: "known-at-oid", generation: 4, oid: "abc" },
      increment: false,
      contentVersion: "0.110.0",
    });
    expect(decision.action).toBe("refuse");
  });

  it("refuses an invalid local token and never treats it as absence", () => {
    const decision = decideGenerationStamp({
      local: { kind: "unreadable", reason: "invalid-json" },
      tip: { kind: "proven-absent-at-oid", oid: "abc" },
      increment: true,
      contentVersion: "0.110.0",
    });
    expect(decision.action).toBe("refuse");
    expect(nextLiveGenerationNumber(null, { increment: true, contentVersion: "1.0.0" })).toBe(1);
  });

  it("bootstraps generation 1 when the tip is proven absent", () => {
    const decision = decideGenerationStamp({
      local: { kind: "absent" },
      tip: { kind: "proven-absent-at-oid", oid: "abc" },
      increment: true,
      contentVersion: "0.110.0",
    });
    expect(decision).toEqual({ action: "stamp", generation: 1 });
  });

  it("rechecks a stale cached stamp against a newer local token", () => {
    const root = tempDir("deft-gen-recheck-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    stampLiveGeneration(root, {
      contentVersion: "0.110.0",
      stampedBy: "concurrent",
      increment: true,
      forcedGeneration: 5,
    });
    const cached = {
      action: "stamp" as const,
      generation: 2,
      tip: { kind: "known-at-oid" as const, generation: 1, oid: "abc" },
      local: { kind: "absent" as const },
    };
    const gate = recheckGenerationGateLocal(cached, root, {
      increment: true,
      contentVersion: "0.111.0",
    });
    expect(gate).toEqual(expect.objectContaining({ action: "stamp", generation: 6 }));
  });

  it("keeps a sufficient newer local token on already-current recheck", () => {
    const root = tempDir("deft-gen-recheck-keep-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    stampLiveGeneration(root, {
      contentVersion: "0.110.0",
      stampedBy: "concurrent",
      increment: true,
      forcedGeneration: 5,
    });
    const cached = {
      action: "stamp" as const,
      generation: 2,
      tip: { kind: "known-at-oid" as const, generation: 1, oid: "abc" },
      local: { kind: "absent" as const },
    };
    const gate = recheckGenerationGateLocal(cached, root, {
      increment: false,
      contentVersion: "0.110.0",
    });
    expect(gate.action).toBe("keep-prior");
  });

  it("allows local arithmetic only on no-remote or remote-asserted absence", () => {
    expect(
      decideGenerationStamp({
        local: { kind: "absent" },
        tip: { kind: "no-remote" },
        increment: true,
        contentVersion: "1.0.0",
      }),
    ).toEqual({ action: "stamp", generation: 1 });
    expect(
      decideGenerationStamp({
        local: { kind: "absent" },
        tip: { kind: "delivery-ref-absent-on-remote" },
        increment: true,
        contentVersion: "1.0.0",
      }),
    ).toEqual({ action: "stamp", generation: 1 });
  });
});

describe("inspectLocalGeneration (#4120 R1)", () => {
  it("distinguishes absent, invalid, and valid tokens", () => {
    const root = tempDir("deft-gen-inspect-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    expect(inspectLocalGeneration(root).kind).toBe("absent");
    writeFileSync(liveGenerationPath(root), "{not json");
    expect(inspectLocalGeneration(root)).toEqual({ kind: "unreadable", reason: "invalid-json" });
    writeFileSync(liveGenerationPath(root), `${JSON.stringify({ generation: "nope" })}\n`);
    expect(inspectLocalGeneration(root)).toEqual({ kind: "unreadable", reason: "invalid-record" });
    stampLiveGeneration(root, {
      contentVersion: "1.2.3",
      stampedBy: "test",
      increment: true,
    });
    expect(inspectLocalGeneration(root).kind).toBe("valid");
  });
});

describe("pinDeliveryTipOid (#4120 R0)", () => {
  it("uses the invocation-owned fetch argv and never reads the retired singleton ref", () => {
    const calls: string[][] = [];
    const execGit: GitExecFn = (args) => {
      calls.push([...args]);
      if (args.includes("fetch")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { status: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = pinDeliveryTipOid({
      projectDir: "/proj",
      remote: "origin",
      branch: "master",
      runId: "run-a",
      execGit,
    });
    expect(result.ok).toBe(true);
    expect(generationFetchArgs("origin", "master", "run-a")).toEqual([
      "--no-optional-locks",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--refmap=",
      "origin",
      "+refs/heads/master:refs/deft/update/run-a/delivery-tip",
    ]);
    expect(calls.some((args) => args.includes("fetch"))).toBe(true);
    expect(calls.some((args) => args.includes("update-ref") && args.includes("-d"))).toBe(true);
    expect(calls.every((args) => !args.includes(retiredSingletonTipRef()))).toBe(true);
  });
});

function enoentGit(): GitExecResult {
  return { status: 127, stdout: "", stderr: "", errorCode: "ENOENT" };
}

describe("listRemotes (#4120 R3)", () => {
  it("treats not-a-git-repository as no remotes", () => {
    const root = tempDir("deft-gen-nongit-");
    const execGit: GitExecFn = () => ({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });
    expect(listRemotes(execGit, root).kind).toBe("no-remotes");
  });

  it("treats git-binary ENOENT on an empty directory as no remotes and allows stamp", () => {
    const root = tempDir("deft-gen-enoent-empty-");
    const execGit: GitExecFn = () => enoentGit();
    expect(listRemotes(execGit, root)).toEqual({ kind: "no-remotes", remotes: [] });
    expect(
      decideGenerationStamp({
        local: { kind: "absent" },
        tip: { kind: "no-remote" },
        increment: true,
        contentVersion: "1.0.0",
      }),
    ).toEqual({ action: "stamp", generation: 1 });
    const gate = evaluateGenerationGate({
      projectDir: root,
      contentVersion: "1.0.0",
      increment: true,
      execGit,
    });
    expect(gate.action).toBe("stamp");
    if (gate.action === "stamp") {
      expect(gate.generation).toBe(1);
    }
  });

  it(
    "does not treat an ancestor git checkout as remote-free on ENOENT",
    destContentionItTimeout(),
    () => {
      const root = tempDir("deft-gen-enoent-ancestor-");
      initRepo(root);
      git(root, ["remote", "add", "origin", "https://example.test/repo.git"]);
      const sub = join(root, "packages", "app");
      mkdirSync(sub, { recursive: true });
      const execGit: GitExecFn = () => enoentGit();
      expect(listRemotes(execGit, sub)).toEqual({
        kind: "unreadable",
        remotes: [],
        detail: "git binary not found",
      });
      const gate = evaluateGenerationGate({
        projectDir: sub,
        contentVersion: "1.0.0",
        increment: true,
        execGit,
      });
      expect(gate.action).toBe("refuse");
    },
  );

  it("keeps git-binary ENOENT unreadable when the dest has a git directory", () => {
    const root = tempDir("deft-gen-enoent-gitdir-");
    mkdirSync(join(root, ".git"));
    const execGit: GitExecFn = () => enoentGit();
    expect(listRemotes(execGit, root)).toEqual({
      kind: "unreadable",
      remotes: [],
      detail: "git binary not found",
    });
    const gate = evaluateGenerationGate({
      projectDir: root,
      contentVersion: "1.0.0",
      increment: true,
      execGit,
    });
    expect(gate.action).toBe("refuse");
  });
});

describe("git fixtures (#4120 R0/R3)", destContentionItTimeout(), () => {
  it("reads through git replace with --no-replace-objects", () => {
    const root = tempDir("deft-gen-replace-");
    initRepo(root);
    const gen4 = commitGeneration(root, 4, "gen4");
    const gen1 = commitGeneration(root, 1, "gen1");
    git(root, ["replace", gen4, gen1]);
    const aware = git(root, ["show", `${gen4}:${GENERATION_GIT_PATH}`]);
    expect(JSON.parse(aware).generation).toBe(1);
    const raw = git(root, ["--no-replace-objects", "show", `${gen4}:${GENERATION_GIT_PATH}`]);
    expect(JSON.parse(raw).generation).toBe(4);
    const execGit: GitExecFn = (args, options) => {
      try {
        const stdout = execFileSync("git", [...args], {
          cwd: options.cwd,
          encoding: "utf8",
        });
        return { status: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stderr?: string };
        return {
          status: typeof e.status === "number" ? e.status : 1,
          stdout: "",
          stderr: e.stderr ?? "",
        };
      }
    };
    const probe = probeGenerationAtOid(execGit, root, gen4);
    expect(probe.kind).toBe("present");
    if (probe.kind === "present") {
      expect(probe.generation).toBe(4);
    }
    const decision = decideGenerationStamp({
      local: { kind: "absent" },
      tip: { kind: "known-at-oid", generation: 4, oid: gen4 },
      increment: true,
      contentVersion: "0.110.0",
    });
    // Raw OID generation is 4 (not the replaced 1); missing local stamps tip+1.
    expect(decision).toEqual({ action: "stamp", generation: 5 });
  });

  it("tri-state ls-tree distinguishes present, absent, and unreadable", () => {
    const root = tempDir("deft-gen-lstree-");
    initRepo(root);
    writeFileSync(join(root, "README"), "x\n");
    git(root, ["add", "README"]);
    git(root, ["commit", "-m", "readme"]);
    const oid = commitGeneration(root, 4, "with-token");
    const present = execFileSync(
      "git",
      ["--no-replace-objects", "ls-tree", oid, "--", GENERATION_GIT_PATH],
      { cwd: root, encoding: "utf8" },
    );
    expect(present.length).toBeGreaterThan(0);
    const missingPath = execFileSync(
      "git",
      ["--no-replace-objects", "ls-tree", oid, "--", ".deft/NOPE.json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(missingPath.trim()).toBe("");
    let missingTreeStatus = 0;
    try {
      execFileSync(
        "git",
        ["--no-replace-objects", "ls-tree", "not-a-tree", "--", GENERATION_GIT_PATH],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
    } catch (err) {
      missingTreeStatus = (err as { status?: number }).status ?? 0;
    }
    expect(missingTreeStatus).toBe(128);
  });

  it(
    "pins distinct OIDs for concurrent writers with distinct run ids",
    destContentionItTimeout(),
    () => {
      const bare = tempDir("deft-gen-bare-");
      git(bare, ["init", "--bare", "-b", "master"]);
      const seed = tempDir("deft-gen-seed-");
      initRepo(seed);
      git(seed, ["remote", "add", "origin", bare]);
      const masterOid = commitGeneration(seed, 4, "master-gen4");
      git(seed, ["push", "-u", "origin", "master"]);
      git(seed, ["checkout", "-b", "older"]);
      const olderOid = commitGeneration(seed, 1, "older-gen1");
      git(seed, ["push", "-u", "origin", "older"]);

      const parent = tempDir("deft-gen-wt-parent-");
      const a = join(parent, "a");
      const b = join(parent, "b");
      execFileSync("git", ["clone", bare, a], { encoding: "utf8" });
      execFileSync("git", ["clone", "-b", "older", bare, b], { encoding: "utf8" });
      git(a, ["config", "remote.origin.fetch", "+refs/heads/master:refs/remotes/origin/master"]);
      git(b, ["config", "remote.origin.fetch", "+refs/heads/older:refs/remotes/origin/older"]);

      const pinA = pinDeliveryTipOid({
        projectDir: a,
        remote: "origin",
        branch: "master",
        runId: "run-a",
      });
      const pinB = pinDeliveryTipOid({
        projectDir: b,
        remote: "origin",
        branch: "older",
        runId: "run-b",
      });
      expect(pinA.ok).toBe(true);
      expect(pinB.ok).toBe(true);
      if (pinA.ok && pinB.ok) {
        expect(pinA.oid).toBe(masterOid);
        expect(pinB.oid).toBe(olderOid);
      }
      expect(() =>
        git(a, ["rev-parse", "--verify", "refs/deft/update/run-a/delivery-tip"]),
      ).toThrow();
      expect(() =>
        git(b, ["rev-parse", "--verify", "refs/deft/update/run-b/delivery-tip"]),
      ).toThrow();
    },
  );

  it("does not treat empty ls-remote of fallback master as absence when upstream has main", () => {
    const bare = tempDir("deft-gen-fallback-bare-");
    git(bare, ["init", "--bare", "-b", "main"]);
    const seed = tempDir("deft-gen-fallback-seed-");
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.email", "4120@example.test"]);
    git(seed, ["config", "user.name", "4120 fixture"]);
    git(seed, ["remote", "add", "origin", bare]);
    commitGeneration(seed, 4, "main-gen4");
    git(seed, ["push", "-u", "origin", "main"]);

    const dest = tempDir("deft-gen-fallback-dest-");
    git(dest, ["init", "-b", "feature"]);
    git(dest, ["config", "user.email", "4120@example.test"]);
    git(dest, ["config", "user.name", "4120 fixture"]);
    git(dest, ["remote", "add", "upstream", bare]);
    writeFileSync(join(dest, "README"), "x\n");
    git(dest, ["add", "README"]);
    git(dest, ["commit", "-m", "local-feature"]);

    const delivery = resolveDeliveryBranch(dest);
    expect(delivery.source).toBe("default-fallback");
    expect(delivery.branch).toBe("master");

    const gate = evaluateGenerationGate({
      projectDir: dest,
      contentVersion: "0.110.0",
      increment: true,
    });
    expect(gate.action).toBe("refuse");
    expect(gate.tip.kind).toBe("remote-configured-unreadable");
    if (gate.tip.kind === "remote-configured-unreadable") {
      expect(gate.tip.detail).toMatch(/fallback name is not absence/);
    }
  });

  it("classifies missing remote ref as absence only when ls-remote is empty", () => {
    const bare = tempDir("deft-gen-absent-bare-");
    git(bare, ["init", "--bare", "-b", "master"]);
    const clone = tempDir("deft-gen-absent-clone-");
    initRepo(clone);
    git(clone, ["remote", "add", "origin", bare]);
    writeFileSync(join(clone, "README"), "x\n");
    git(clone, ["add", "README"]);
    git(clone, ["commit", "-m", "seed"]);
    git(clone, ["push", "-u", "origin", "master"]);
    let fetchStatus = 0;
    try {
      git(clone, ["fetch", "origin", "no-such-branch"]);
    } catch (err) {
      fetchStatus = (err as { status?: number }).status ?? 0;
    }
    expect(fetchStatus).toBe(128);
    const ls = git(clone, ["ls-remote", "origin", "refs/heads/no-such-branch"]);
    expect(ls.trim()).toBe("");
  });
});

describe("evaluateGenerationGate / dry-run (#4120 R4)", () => {
  it("dry-run does not fetch and reports invocation-owned live apply", () => {
    const root = tempDir("deft-gen-dry-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    const calls: string[][] = [];
    const execGit: GitExecFn = (args): GitExecResult => {
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const dry = describeDryRunGenerationGate({
      projectDir: root,
      contentVersion: "1.0.0",
      increment: true,
      execGit,
    });
    expect(dry.fetches).toBe(false);
    expect(dry.writes_refs).toBe(false);
    expect(dry.live_apply).toBe("invocation-owned-refresh");
    expect(calls.every((args) => !args.includes("fetch"))).toBe(true);
  });

  it("no-remote live apply stamps locally without fetch", () => {
    const root = tempDir("deft-gen-noremote-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    const gate = evaluateGenerationGate({
      projectDir: root,
      contentVersion: "1.0.0",
      increment: true,
      execGit: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(gate.action).toBe("stamp");
    if (gate.action === "stamp") {
      expect(gate.generation).toBe(1);
    }
  });
});

describe("bindSessionGeneration (#4120 R2)", () => {
  it("does not mint a live token when none exists", () => {
    const root = tempDir("deft-gen-bind-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    expect(() => bindSessionGeneration(root, { sessionId: "sid", payloadLoaded: true })).toThrow(
      /no live generation token/,
    );
    expect(inspectLocalGeneration(root).kind).toBe("absent");
  });
});

describe("evaluateGenerationMonotonicVsBase (#4120 R5)", () => {
  const base = token(4);
  const head = token(5);
  it("passes when GENERATION.json did not change", () => {
    expect(
      evaluateGenerationMonotonicVsBase({ changed: false, baseBlob: base, headBlob: token(2) }).ok,
    ).toBe(true);
  });
  it("requires head.generation > origin base blob", () => {
    expect(
      evaluateGenerationMonotonicVsBase({ changed: true, baseBlob: base, headBlob: head }).ok,
    ).toBe(true);
    expect(
      evaluateGenerationMonotonicVsBase({ changed: true, baseBlob: base, headBlob: token(4) }).ok,
    ).toBe(false);
    expect(
      evaluateGenerationMonotonicVsBase({ changed: true, baseBlob: base, headBlob: token(2) }).ok,
    ).toBe(false);
  });
  it("allows bootstrap when the origin base blob is absent", () => {
    expect(
      evaluateGenerationMonotonicVsBase({ changed: true, baseBlob: null, headBlob: token(1) }).ok,
    ).toBe(true);
  });
  it("refuses bootstrap generation 0 when the origin base blob is absent", () => {
    expect(
      evaluateGenerationMonotonicVsBase({ changed: true, baseBlob: null, headBlob: token(0) }).ok,
    ).toBe(false);
  });
});
