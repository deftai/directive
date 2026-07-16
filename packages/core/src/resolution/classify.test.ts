import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readCorePackageVersionMock = vi.hoisted(() => vi.fn(() => "0.78.0"));
const existsSyncMock = vi.hoisted(() =>
  vi.fn<(path: Parameters<typeof import("node:fs").existsSync>[0]) => boolean>(),
);
const actualExistsSync = vi.hoisted(() => ({
  fn: null as typeof import("node:fs").existsSync | null,
}));

vi.mock("../engine-version.js", () => ({
  readCorePackageVersion: readCorePackageVersionMock,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  actualExistsSync.fn = actual.existsSync;
  existsSyncMock.mockImplementation(actual.existsSync);
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => existsSyncMock(path),
  };
});

import * as commandSpawn from "../verify-env/command-spawn.js";
import { type ClassifySeams, classify, defaultEngineProbe } from "./classify.js";

const CWD = "/proj";

interface VirtualFs {
  dirs: Set<string>;
  files: Map<string, string>;
}

function seams(vfs: VirtualFs, extra: Partial<ClassifySeams> = {}): ClassifySeams {
  return {
    isDir: (p: string) => vfs.dirs.has(p),
    isFile: (p: string) => vfs.files.has(p),
    readText: (p: string) => vfs.files.get(p) ?? null,
    engineProbe: () => ({ reachable: false, version: null }),
    preCutoverProbe: () => false,
    ...extra,
  };
}

function emptyFs(): VirtualFs {
  return { dirs: new Set(), files: new Map() };
}

const AGENTS_WITH_SHA =
  "# AGENTS\n<!-- deft:managed-section v3 sha=abc123def456 refreshed=2026-07-03T00:00:00Z session=deadbeef -->\nbody\n<!-- /deft:managed-section -->\n";

describe("resolution/classify orthogonal fact-set (#2264 a1)", () => {
  it("classifies a matched project (deft core + managed section + pin + reachable engine)", () => {
    const vfs = emptyFs();
    vfs.dirs.add(join(CWD, ".deft/core"));
    vfs.dirs.add(join(CWD, ".git"));
    vfs.dirs.add(join(CWD, "xbrief"));
    vfs.files.set(join(CWD, "AGENTS.md"), AGENTS_WITH_SHA);
    vfs.files.set(join(CWD, ".deft/core", "VERSION"), "tag: 'v0.65.0'\n");
    vfs.files.set(
      join(CWD, "package.json"),
      JSON.stringify({ private: true, devDependencies: { "@deftai/directive": "0.65.0" } }),
    );

    const facts = classify(
      CWD,
      seams(vfs, { engineProbe: () => ({ reachable: true, version: "0.65.0" }) }),
    );

    expect(facts).toEqual({
      hasGit: true,
      hasAppCode: true,
      hasDeftCore: true,
      deftCorePayloadVersion: "0.65.0",
      hasManagedSection: true,
      managedSectionSha: "abc123def456",
      hasVbrief: false,
      hasXbrief: true,
      preCutoverArtifacts: false,
      engineReachable: true,
      engineVersion: "0.65.0",
      pinVersion: "0.65.0",
    });
  });

  it("classifies a brownfield + pre-cutover project", () => {
    const vfs = emptyFs();
    vfs.dirs.add(join(CWD, ".git"));
    vfs.files.set(join(CWD, "package.json"), JSON.stringify({ name: "app" }));
    const facts = classify(CWD, seams(vfs, { preCutoverProbe: () => true }));
    expect(facts.hasAppCode).toBe(true);
    expect(facts.hasGit).toBe(true);
    expect(facts.hasDeftCore).toBe(false);
    expect(facts.preCutoverArtifacts).toBe(true);
    expect(facts.pinVersion).toBeNull();
  });

  it("classifies an initialized-stale + legacy-vbrief project", () => {
    const vfs = emptyFs();
    vfs.dirs.add(join(CWD, ".deft/core"));
    vfs.dirs.add(join(CWD, "vbrief"));
    vfs.files.set(join(CWD, "AGENTS.md"), AGENTS_WITH_SHA);
    vfs.files.set(join(CWD, ".deft/core", "VERSION"), "tag: 'v0.63.0'\n");
    vfs.files.set(
      join(CWD, "package.json"),
      JSON.stringify({ private: true, devDependencies: { "@deftai/directive": "0.65.0" } }),
    );
    const facts = classify(CWD, seams(vfs));
    expect(facts.hasVbrief).toBe(true);
    expect(facts.hasXbrief).toBe(false);
    expect(facts.deftCorePayloadVersion).toBe("0.63.0");
    expect(facts.pinVersion).toBe("0.65.0");
  });

  it("returns null payload version when the deposit is absent", () => {
    const facts = classify(CWD, seams(emptyFs()));
    expect(facts.hasDeftCore).toBe(false);
    expect(facts.deftCorePayloadVersion).toBeNull();
    expect(facts.hasManagedSection).toBe(false);
    expect(facts.managedSectionSha).toBeNull();
  });

  it("detects a git worktree via a .git file (submodule/worktree)", () => {
    const vfs = emptyFs();
    vfs.files.set(join(CWD, ".git"), "gitdir: /elsewhere\n");
    const facts = classify(CWD, seams(vfs));
    expect(facts.hasGit).toBe(true);
  });

  it("reports no managed sha when AGENTS.md has a section without sha attr", () => {
    const vfs = emptyFs();
    vfs.dirs.add(join(CWD, ".deft/core"));
    vfs.files.set(
      join(CWD, "AGENTS.md"),
      "# A\n<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
    );
    const facts = classify(CWD, seams(vfs));
    expect(facts.hasManagedSection).toBe(true);
    expect(facts.managedSectionSha).toBeNull();
  });

  it("exposes a default engine probe that never throws", () => {
    const result = defaultEngineProbe();
    expect(typeof result.reachable).toBe("boolean");
    expect(result.version === null || typeof result.version === "string").toBe(true);
  });
});

describe("resolution/classify defaultEngineProbe (#2606)", () => {
  const resolveSpy = vi.spyOn(commandSpawn, "resolveCommandOnPath");
  const spawnSpy = vi.spyOn(commandSpawn, "spawnCommandText");

  beforeEach(() => {
    resolveSpy.mockReset();
    spawnSpy.mockReset();
    readCorePackageVersionMock.mockReset();
    readCorePackageVersionMock.mockReturnValue("0.78.0");
    existsSyncMock.mockReset();
    if (actualExistsSync.fn) {
      existsSyncMock.mockImplementation(actualExistsSync.fn);
    }
    delete process.env.DEFT_RELEASE_VERSION;
  });

  afterEach(() => {
    delete process.env.DEFT_RELEASE_VERSION;
  });

  it("prefers in-process core identity when already inside the CLI", () => {
    readCorePackageVersionMock.mockReturnValue("0.78.0");

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: true, version: "0.78.0" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("accepts dev-checkout 0.0.0 in-process without subprocess probing", () => {
    readCorePackageVersionMock.mockReturnValue("0.0.0");

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: true, version: "0.0.0" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("prefers DEFT_RELEASE_VERSION over subprocess probing", () => {
    process.env.DEFT_RELEASE_VERSION = "9.9.9";
    readCorePackageVersionMock.mockReturnValue("0.78.0");

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: true, version: "9.9.9" });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("resolves Windows npm .cmd shims via PATHEXT before shell fallback", () => {
    existsSyncMock.mockImplementation((path) => {
      const normalized = String(path).replace(/\\/g, "/");
      if (normalized.endsWith("/packages/core/package.json")) {
        return false;
      }
      return actualExistsSync.fn?.(path) ?? false;
    });
    readCorePackageVersionMock.mockReturnValue("0.0.0");
    const shim = "C:\\Users\\test\\AppData\\Roaming\\npm\\directive.CMD";
    resolveSpy.mockImplementation((cmd) => (cmd === "directive" ? shim : null));
    spawnSpy.mockReturnValueOnce({
      status: 0,
      stdout: "@deftai/directive (engine: @deftai/directive-core@0.78.0)\n",
      stderr: "",
    });

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: true, version: "0.78.0" });
    expect(resolveSpy).toHaveBeenCalledWith("directive");
    expect(spawnSpy).toHaveBeenCalledWith(shim, ["--version"], { timeoutMs: 5000 });
  });

  it("falls back to shell:true bare-name probe when PATH resolution misses", () => {
    existsSyncMock.mockImplementation((path) => {
      const normalized = String(path).replace(/\\/g, "/");
      if (normalized.endsWith("/packages/core/package.json")) {
        return false;
      }
      return actualExistsSync.fn?.(path) ?? false;
    });
    readCorePackageVersionMock.mockReturnValue("0.0.0");
    resolveSpy.mockReturnValue(null);
    spawnSpy.mockReturnValueOnce({ status: 1, stdout: "", stderr: "ENOENT" }).mockReturnValueOnce({
      status: 0,
      stdout: "@deftai/directive (engine: @deftai/directive-core@0.78.0)\n",
      stderr: "",
    });

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: true, version: "0.78.0" });
    expect(spawnSpy).toHaveBeenNthCalledWith(1, "directive", ["--version"], { timeoutMs: 5000 });
    expect(spawnSpy).toHaveBeenNthCalledWith(2, "deft", ["--version"], { timeoutMs: 5000 });
  });

  it("reports unreachable when in-process and subprocess probes both fail", () => {
    existsSyncMock.mockImplementation((path) => {
      const normalized = String(path).replace(/\\/g, "/");
      if (normalized.endsWith("/packages/core/package.json")) {
        return false;
      }
      return actualExistsSync.fn?.(path) ?? false;
    });
    readCorePackageVersionMock.mockReturnValue("0.0.0");
    resolveSpy.mockReturnValue(null);
    spawnSpy.mockReturnValue({ status: 1, stdout: "", stderr: "ENOENT" });

    const result = defaultEngineProbe();

    expect(result).toEqual({ reachable: false, version: null });
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("resolution/classify default (real filesystem) seams", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("classifies a real directory using only the default fs seams (engine injected)", () => {
    const root = mkdtempSync(join(tmpdir(), "classify-real-"));
    created.push(root);
    mkdirSync(join(root, ".deft/core"), { recursive: true });
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), AGENTS_WITH_SHA, "utf8");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, devDependencies: { "@deftai/directive": "0.65.0" } }),
      "utf8",
    );

    // Only the engine probe is injected (offline determinism); all filesystem
    // + pre-cutover reads exercise the real default seams.
    const facts = classify(root, {
      engineProbe: () => ({ reachable: true, version: "0.65.0" }),
    });

    expect(facts.hasDeftCore).toBe(true);
    expect(facts.hasXbrief).toBe(true);
    expect(facts.hasVbrief).toBe(false);
    expect(facts.hasAppCode).toBe(true);
    expect(facts.hasManagedSection).toBe(true);
    expect(facts.managedSectionSha).toBe("abc123def456");
    expect(facts.pinVersion).toBe("0.65.0");
    expect(facts.engineReachable).toBe(true);
  });

  it("classifies an empty real directory as an un-initialized project", () => {
    const root = mkdtempSync(join(tmpdir(), "classify-empty-"));
    created.push(root);
    const facts = classify(root, {
      engineProbe: () => ({ reachable: false, version: null }),
    });
    expect(facts.hasDeftCore).toBe(false);
    expect(facts.hasAppCode).toBe(false);
    expect(facts.hasManagedSection).toBe(false);
    expect(facts.pinVersion).toBeNull();
    expect(facts.preCutoverArtifacts).toBe(false);
  });
});
