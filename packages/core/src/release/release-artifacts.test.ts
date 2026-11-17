import { execFileSync } from "node:child_process";
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
import type { FragmentFs } from "../changelog/fragment.js";
import { EXIT_VIOLATION } from "./constants.js";
import { commitReleaseArtifacts } from "./git.js";
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
    breakGlass: true,
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

describe("changelog fragments in the release (#6315 / #6286 item 6)", () => {
  const BASE =
    "## [Unreleased]\n\n### Added\n\n- inline added (#1)\n\n## [0.20.0] - 2026-04-01\n\n- old\n";
  const FRAGMENTS: Record<string, string> = {
    "30-fix-b.md": "section: Fixed\n- fix b (#30)\n",
    "20-feat-a.md": "section: Added\n- feat a (#20)\n  continued line\n",
    "25-change.md": "section: Changed\n- change c (#25)\n- change d (#25)\n",
  };

  function git(root: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  }

  function fragmentRoot(fragments: Record<string, string> = FRAGMENTS): string {
    const root = tempRoot();
    writeFileSync(join(root, "CHANGELOG.md"), BASE);
    mkdirSync(join(root, "changelog.d"));
    for (const [name, text] of Object.entries(fragments)) {
      writeFileSync(join(root, "changelog.d", name), text);
    }
    return root;
  }

  function gitRoot(fragments: Record<string, string> = FRAGMENTS): string {
    const root = fragmentRoot(fragments);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
    git(root, ["config", "core.autocrlf", "false"]);
    // commitReleaseArtifacts runs plain `git commit`; CI runners have no global identity.
    git(root, ["config", "user.email", "ci@test"]);
    git(root, ["config", "user.name", "ci"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    return root;
  }

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  function promotedSection(text: string): string {
    const start = text.indexOf("## [0.21.0]");
    const end = text.indexOf("## [0.20.0]");
    return text.slice(start, end);
  }

  it("folds each entry once into its subsection and deletes every captured fragment", () => {
    const root = fragmentRoot();
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.fragments.map((f) => f.path)).toEqual([
      "changelog.d/20-feat-a.md",
      "changelog.d/25-change.md",
      "changelog.d/30-fix-b.md",
    ]);
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(written).toEqual({
      ok: true,
      deletedFragments: [
        "changelog.d/20-feat-a.md",
        "changelog.d/25-change.md",
        "changelog.d/30-fix-b.md",
      ],
    });
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const section = promotedSection(text);
    for (const entry of [
      "- inline added (#1)",
      "- feat a (#20)",
      "- change c (#25)",
      "- change d (#25)",
      "- fix b (#30)",
    ]) {
      expect(count(text, entry)).toBe(1);
      expect(section).toContain(entry);
    }
    expect(section).toContain("- feat a (#20)\n  continued line");
    // Subsection order: Added, Changed, Fixed.
    const added = section.indexOf("### Added");
    const changed = section.indexOf("### Changed");
    const fixed = section.indexOf("### Fixed");
    expect(added).toBeGreaterThan(-1);
    expect(added).toBeLessThan(section.indexOf("- feat a (#20)"));
    expect(changed).toBeLessThan(section.indexOf("- change c (#25)"));
    expect(fixed).toBeLessThan(section.indexOf("- fix b (#30)"));
    expect(added).toBeLessThan(changed);
    expect(changed).toBeLessThan(fixed);
    expect(count(text, "## [0.21.0]")).toBe(1);
    for (const name of Object.keys(FRAGMENTS)) {
      expect(existsSync(join(root, "changelog.d", name))).toBe(false);
    }
  });

  it("the release commit records the fragment deletions", () => {
    const root = gitRoot();
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    if (!prepared.ok) throw new Error(prepared.message);
    const written = writeReleaseArtifacts(prepared.prepared);
    if (!written.ok) throw new Error(written.message);
    const [ok, reason] = commitReleaseArtifacts(root, "0.21.0", {}, written.deletedFragments);
    expect(reason).toContain("committed release artifacts");
    expect(ok).toBe(true);
    const shown = git(root, ["show", "--name-status", "--format=", "HEAD"]);
    expect(shown).toContain("M\tCHANGELOG.md");
    for (const name of Object.keys(FRAGMENTS)) {
      expect(shown).toContain(`D\tchangelog.d/${name}`);
    }
    expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("refuses the release commit while a captured fragment is still on disk", () => {
    const root = gitRoot();
    const [ok, reason] = commitReleaseArtifacts(root, "0.21.0", {}, ["changelog.d/20-feat-a.md"]);
    expect(ok).toBe(false);
    expect(reason).toContain("still on disk: changelog.d/20-feat-a.md");
    expect(git(root, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
  });

  it("a dry run writes and deletes nothing", () => {
    const root = fragmentRoot();
    const prepared = prepareReleaseArtifacts(prepInput(root, true));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.fragments).toHaveLength(3);
      expect(prepared.prepared.changelogBytes.toString("utf8")).toContain("- fix b (#30)");
    }
    const cap = capture();
    try {
      expect(runPipeline(pipelineConfig(root, { dryRun: true, skipTag: false }), seams())).toBe(0);
      expect(cap.text()).toContain("then delete 3 captured changelog fragment(s)");
    } finally {
      cap.restore();
    }
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE);
    expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toBe(ROADMAP);
    for (const [name, text] of Object.entries(FRAGMENTS)) {
      expect(readFileSync(join(root, "changelog.d", name), "utf8")).toBe(text);
    }
  });

  it("refuses a changelog that already holds the version heading", () => {
    const root = fragmentRoot();
    writeFileSync(
      join(root, "CHANGELOG.md"),
      BASE.replace("## [0.20.0]", "## [0.21.0] - 2026-04-27\n\n- x\n\n## [0.20.0]"),
    );
    for (const dry of [true, false]) {
      const result = prepareReleaseArtifacts(prepInput(root, dry));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("version-exists");
        expect(result.exitCode).toBe(EXIT_VIOLATION);
        expect(result.message).toContain(
          "restore CHANGELOG.md, ROADMAP.md and changelog.d/ to HEAD",
        );
      }
    }
  });

  it("refuses two fragments with an identical entry line", () => {
    const root = fragmentRoot({
      "20-a.md": "section: Added\n- same text (#20)\n",
      "21-b.md": "section: Fixed\n- same text (#20)\n",
    });
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("fragment-duplicate");
      expect(result.message).toContain("changelog.d/20-a.md and changelog.d/21-b.md");
    }
  });

  it("refuses an invalid fragment and opens no destination", () => {
    const root = fragmentRoot({ "20-a.md": "# heading\n" });
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("fragment-invalid");
      expect(result.message).toContain("changelog.d/20-a.md");
    }
  });

  itPosix("refuses a symlinked fragment", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    const outside = mkdtempSync(join(tmpdir(), "rel-frag-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "x.md"), "section: Added\n- stolen (#21)\n");
    symlinkSync(join(outside, "x.md"), join(root, "changelog.d", "21-link.md"));
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("fragment-invalid");
      expect(result.message).toContain("symlink");
    }
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE);
  });

  it("refuses a hard-linked fragment (read-safety nlink rule)", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    linkSync(join(root, "changelog.d", "20-a.md"), join(root, "ROADMAP-copy.md"));
    const result = prepareReleaseArtifacts(prepInput(root, false));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("nlink");
  });

  it("refuses to delete a fragment replaced after capture", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    if (!prepared.ok) throw new Error(prepared.message);
    const path = join(root, "changelog.d", "20-a.md");
    renameSync(path, `${path}.moved`);
    writeFileSync(path, "section: Added\n- swapped (#20)\n");
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.code).toBe("fragment-identity");
      expect(written.changelogMutated).toBe(true);
    }
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a fragment edited in place after capture (same file identity)", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    if (!prepared.ok) throw new Error(prepared.message);
    const path = join(root, "changelog.d", "20-a.md");
    writeFileSync(path, "section: Added\n- a (#20)\n- late edit (#20)\n");
    const written = writeReleaseArtifacts(prepared.prepared);
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.code).toBe("fragment-changed");
      expect(written.changelogMutated).toBe(true);
    }
    expect(readFileSync(path, "utf8")).toContain("- late edit (#20)");
  });

  it("accepts repeated first lines inside one fragment", () => {
    const root = fragmentRoot({
      "20-a.md":
        "section: Added\n- same start (#20)\n  first detail\n- same start (#20)\n  second detail\n",
    });
    const result = prepareReleaseArtifacts(prepInput(root, true));
    expect(result.ok).toBe(true);
  });

  it("refuses when changelog.d/ cannot be listed (not silently skipped)", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    const dir = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
    const cases: FragmentFs[] = [
      {
        readdir: () => {
          throw new Error("EACCES: listing denied");
        },
        lstat: () => dir,
        readFile: () => "",
      },
      {
        readdir: () => [],
        lstat: () => {
          throw Object.assign(new Error("EACCES: stat denied"), { code: "EACCES" });
        },
        readFile: () => "",
      },
    ];
    for (const fragmentFs of cases) {
      const result = prepareReleaseArtifacts({ ...prepInput(root, true), fragmentFs });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("fragment-invalid");
        expect(result.message).toContain("changelog.d could not be listed");
      }
    }
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(BASE);
  });

  it("reports a failed fragment deletion", () => {
    const root = fragmentRoot({ "20-a.md": "section: Added\n- a (#20)\n" });
    const prepared = prepareReleaseArtifacts(prepInput(root, false));
    if (!prepared.ok) throw new Error(prepared.message);
    const written = writeReleaseArtifacts(prepared.prepared, {
      unlink: () => {
        throw new Error("EPERM injected");
      },
    });
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.code).toBe("fragment-delete");
      expect(written.message).toContain("EPERM injected");
    }
  });

  for (const order of [
    ["one", "two"],
    ["two", "one"],
  ] as const) {
    it(`two branches that each add a fragment merge (${order.join(" then ")}) with no conflict`, () => {
      const root = gitRoot({});
      for (const branch of ["one", "two"]) {
        git(root, ["checkout", "-q", "-b", branch, "master"]);
        mkdirSync(join(root, "changelog.d"), { recursive: true });
        writeFileSync(
          join(root, "changelog.d", `4${branch === "one" ? "1" : "2"}-${branch}.md`),
          `section: Added\n- ${branch} (#4)\n`,
        );
        git(root, ["add", "-A"]);
        git(root, ["commit", "-q", "-m", branch]);
      }
      git(root, ["checkout", "-q", "master"]);
      for (const branch of order) {
        git(root, ["merge", "-q", "--no-ff", "--no-edit", branch]);
      }
      expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
      expect(existsSync(join(root, "changelog.d", "41-one.md"))).toBe(true);
      expect(existsSync(join(root, "changelog.d", "42-two.md"))).toBe(true);
    });
  }
});
