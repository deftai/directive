import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
