import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_VIOLATION } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { paidSkipCiLedgerSeam } from "./pipeline-fixture.js";
import {
  closePreparedArtifacts,
  prepareReleaseArtifacts,
  writeReleaseArtifacts,
} from "./release-artifacts.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const CHANGELOG = "## [Unreleased]\n\n### Added\n- x\n";
const ROADMAP = "# Roadmap\n";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rel-art-"));
  roots.push(root);
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
  writeFileSync(join(root, "ROADMAP.md"), ROADMAP);
  return root;
}

const itPosix = it.skipIf(process.platform === "win32");

function prepInput(root: string, dryRun = false) {
  return {
    projectRoot: root,
    version: "0.21.0",
    repo: "deftai/directive",
    today: "2026-04-28",
    summary: null as string | null,
    dryRun,
  };
}

function pipelineConfig(root: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot: root,
    dryRun: false,
    skipTag: true,
    skipRelease: true,
    allowDirty: true,
    draft: true,
    skipCi: true,
    skipBuild: true,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: 716,
    ...overrides,
  };
}

function seams(): ReleaseSeams {
  return {
    validateReleaseInputs: passReleaseInputs,
    probeSkipCiIncidentLedger: paidSkipCiLedgerSeam,
    todayIso: () => "2026-04-28",
    spawnText: (_c, a) => {
      if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
      if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
  };
}

function capture(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

describe("prepareReleaseArtifacts", () => {
  it("dry-run prepares buffers and does not open destinations or write", () => {
    const root = tempRoot();
    const beforeCl = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const beforeRm = readFileSync(join(root, "ROADMAP.md"), "utf8");
    const result = prepareReleaseArtifacts(prepInput(root, true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.changelogFd).toBeNull();
    expect(result.prepared.roadmapFd).toBeNull();
    expect(result.prepared.changelogBytes.includes(Buffer.from("0.21.0"))).toBe(true);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(beforeCl);
    expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toBe(beforeRm);
  });

  it("successful preparation writes nothing", () => {
    const root = tempRoot();
    const beforeCl = readFileSync(join(root, "CHANGELOG.md"));
    const beforeRm = readFileSync(join(root, "ROADMAP.md"));
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.changelogFd).not.toBeNull();
    expect(readFileSync(join(root, "CHANGELOG.md"))).toEqual(beforeCl);
    expect(readFileSync(join(root, "ROADMAP.md"))).toEqual(beforeRm);
    closePreparedArtifacts(result.prepared);
  });

  it("non-dry-run CHANGELOG payload read uses the retained descriptor", () => {
    const src = readFileSync(
      join(process.cwd(), "packages/core/src/release/release-artifacts.ts"),
      "utf8",
    );
    expect(src).toContain("readFileSync(openedCl.fd");
    const afterOpen = src.split("const openedCl = openExisting(changelogPath)")[1] ?? "";
    expect(afterOpen).toContain("readFileSync(openedCl.fd");
    const beforeOpen = src.split("const openedCl = openExisting(changelogPath)")[0] ?? "";
    expect(beforeOpen).not.toContain("readFileSync(changelogPath");
  });

  itPosix("refuses nlink!=1 on an existing ROADMAP hard-linked to an external file", () => {
    const root = tempRoot();
    const alias = join(root, "alias-roadmap.md");
    linkSync(join(root, "ROADMAP.md"), alias);
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(result.code).toBe("nlink");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toBe(ROADMAP);
  });

  itPosix("refuses a hard-linked ROADMAP/CHANGELOG pair", () => {
    const root = mkdtempSync(join(tmpdir(), "rel-art-pair-"));
    roots.push(root);
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    linkSync(join(root, "CHANGELOG.md"), join(root, "ROADMAP.md"));
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(["nlink", "pair-identity"]).toContain(result.code);
  });

  it("refuses a directory ROADMAP destination", () => {
    const root = tempRoot();
    rmSync(join(root, "ROADMAP.md"));
    mkdirSync(join(root, "ROADMAP.md"));
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });
});

describe("writeReleaseArtifacts", () => {
  it("writes ROADMAP then CHANGELOG through retained descriptors", () => {
    const root = tempRoot();
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(written.ok).toBe(true);
    const cl = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(cl).toContain("## [0.21.0] - 2026-04-28");
    expect(cl).toContain("## [Unreleased]");
    const rm = readFileSync(join(root, "ROADMAP.md"), "utf8");
    expect(rm).toContain("# Roadmap");
    expect(rm).not.toBe(ROADMAP);
  });

  it("ROADMAP write fault leaves CHANGELOG byte-identical", () => {
    const root = tempRoot();
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    if (prepared.prepared.roadmapFd === null) {
      closePreparedArtifacts(prepared.prepared);
      expect.fail("expected ROADMAP fd");
      return;
    }
    closeSync(prepared.prepared.roadmapFd);
    const beforeCl = readFileSync(join(root, "CHANGELOG.md"));
    const written = writeReleaseArtifacts({
      ...prepared.prepared,
      roadmapFd: prepared.prepared.roadmapFd,
    });
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.changelogMutated).toBe(false);
    expect(written.message).toContain("CHANGELOG.md is byte-identical");
    expect(readFileSync(join(root, "CHANGELOG.md"))).toEqual(beforeCl);
  });

  it("creates missing ROADMAP through retained parent fd or containedOpenExclusive", () => {
    const root = tempRoot();
    rmSync(join(root, "ROADMAP.md"));
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.roadmapFd).toBeNull();
    expect(prepared.prepared.missingRoadmapParentFd).not.toBeNull();
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(written.ok).toBe(true);
    expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toContain("# Roadmap");
  });

  itPosix("refuses ROADMAP create when the parent directory is replaced with a symlink", () => {
    const root = tempRoot();
    rmSync(join(root, "ROADMAP.md"));
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const moved = `${root}.moved`;
    const outside = mkdtempSync(join(tmpdir(), "rel-art-out-"));
    roots.push(moved);
    roots.push(outside);
    writeFileSync(join(outside, "CHANGELOG.md"), CHANGELOG);
    renameSync(root, moved);
    symlinkSync(outside, root);
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(existsSync(join(outside, "ROADMAP.md"))).toBe(false);
    if (written.ok) {
      expect(existsSync(join(moved, "ROADMAP.md"))).toBe(true);
    } else {
      expect(["symlink", "pair-identity", "unsafe", "open", "roadmap-create"]).toContain(
        written.code,
      );
      expect(written.changelogMutated).toBe(false);
    }
  });
});

describe("runPipeline artifact steps (#4318)", () => {
  it("emits Prepare then Write labels and mutates ROADMAP then CHANGELOG", () => {
    const root = tempRoot();
    const cap = capture();
    try {
      const rc = runPipeline(pipelineConfig(root), seams());
      expect(rc).toBe(0);
      const err = cap.text();
      expect(err).toContain("[6/13] Prepare release artifacts");
      expect(err).toContain("[7/13] Write release artifacts");
      expect(err).not.toContain("CHANGELOG promotion");
      expect(err).not.toContain("ROADMAP refresh");
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("## [0.21.0]");
    } finally {
      cap.restore();
    }
  });

  it("dry-run does not write or write-open", () => {
    const root = tempRoot();
    const beforeCl = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const beforeRm = readFileSync(join(root, "ROADMAP.md"), "utf8");
    const cap = capture();
    try {
      const rc = runPipeline(pipelineConfig(root, { dryRun: true }), seams());
      expect(rc).toBe(0);
      expect(cap.text()).toContain("no destination write-open");
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(beforeCl);
      expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toBe(beforeRm);
    } finally {
      cap.restore();
    }
  });

  itPosix("hard-linked pair is refused before either write", () => {
    const root = mkdtempSync(join(tmpdir(), "rel-pipe-pair-"));
    roots.push(root);
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    linkSync(join(root, "CHANGELOG.md"), join(root, "ROADMAP.md"));
    const before = readFileSync(join(root, "CHANGELOG.md"));
    const rc = runPipeline(pipelineConfig(root), seams());
    expect(rc).toBe(EXIT_VIOLATION);
    expect(readFileSync(join(root, "CHANGELOG.md"))).toEqual(before);
  });
});
