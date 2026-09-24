import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXIT_VIOLATION } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { passReleaseInputs, type ReleaseInputPhase } from "./release-input.js";
import type { ReleaseConfig } from "./types.js";

const sharedTemps: string[] = [];
let sharedRepo: { root: string; head: string } | null = null;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function resetSharedRepo(): void {
  if (sharedRepo === null) return;
  const { root, head } = sharedRepo;
  git(root, ["checkout", "-q", "-f", "master"]);
  git(root, ["reset", "--hard", "-q", head]);
  git(root, ["clean", "-fdq"]);
}

afterEach(() => {
  resetSharedRepo();
});

afterAll(() => {
  for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
  sharedRepo = null;
});

const MINIMAL = `{
  "xBRIEFInfo": { "version": "0.8" },
  "plan": { "title": "t", "status": "proposed" }
}
`;

function buildSeededRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "release-input-pipe-"));
  sharedTemps.push(root);
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
  writeFileSync(join(root, "xbrief", "pending", "story.xbrief.json"), MINIMAL);
  writeFileSync(join(root, "CHANGELOG.md"), "## [Unreleased]\n\n### Added\n- x\n");
  writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

function seededRepo(): string {
  if (sharedRepo === null) sharedRepo = buildSeededRepo();
  return sharedRepo.root;
}

beforeAll(() => {
  seededRepo();
});

function config(root: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
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

describe("pipeline release-input hook sites (#4317)", () => {
  it("dry-run does not invoke Git probes and says not run; would validate", () => {
    const phases: ReleaseInputPhase[] = [];
    const cap = capture();
    try {
      const rc = runPipeline(config(seededRepo(), { dryRun: true, skipCi: true }), {
        todayIso: () => "2026-04-28",
        fileExists: (p) => p.endsWith("CHANGELOG.md"),
        readFile: () => "## [Unreleased]\n\n### Added\n",
        validateReleaseInputs: (_root, phase) => {
          phases.push(phase);
          return passReleaseInputs();
        },
      });
      expect(rc).toBe(0);
      expect(phases).toEqual([]);
      expect(cap.text()).toContain("[release-input] scanner not run; would validate");
      expect(cap.text()).toContain("[release-input] roadmap not run; would validate");
    } finally {
      cap.restore();
    }
  });

  it("runs five-folder validation before mismatch skip; flags do not bypass it", () => {
    const phases: ReleaseInputPhase[] = [];
    let vbriefCalled = false;
    const cap = capture();
    const root = seededRepo();
    try {
      const rc = runPipeline(config(root, { allowVbriefDrift: true, allowDirty: true }), {
        todayIso: () => "2026-04-28",
        spawnText: (_c, a) => {
          if (a.includes("status")) return { status: 0, stdout: " M x\n", stderr: "" };
          if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        checkTagAvailable: () => [true, "ok"],
        checkVbriefLifecycleSync: () => {
          vbriefCalled = true;
          return [true, 0, "no mismatches"];
        },
        fileExists: (p) => p.endsWith(".md"),
        readFile: () => "## [Unreleased]\n\n### Added\n- x\n",
        writeFile: () => undefined,
        validateReleaseInputs: (_root, phase) => {
          phases.push(phase);
          return passReleaseInputs();
        },
      });
      expect(rc).toBe(0);
      expect(phases).toEqual(["scanner", "roadmap"]);
      expect(vbriefCalled).toBe(false);
      expect(cap.text()).toContain("mismatch policy only");
      expect(cap.text()).toContain("input validation already ran");
      expect(cap.text()).not.toMatch(/\[3\/13\].*SKIP \(--allow-vbrief-drift\)\s*$/m);
    } finally {
      cap.restore();
    }
  });

  it("phase 2 still runs after --skip-ci and before CHANGELOG write", () => {
    const order: string[] = [];
    const cap = capture();
    const root = seededRepo();
    const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    try {
      const rc = runPipeline(config(root, { skipCi: true }), {
        todayIso: () => "2026-04-28",
        spawnText: (_c, a) => {
          if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
          if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        checkTagAvailable: () => [true, "ok"],
        validateReleaseInputs: (_root, phase) => {
          order.push(phase);
          expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(before);
          return passReleaseInputs();
        },
      });
      expect(rc).toBe(0);
      expect(order).toEqual(["scanner", "roadmap"]);
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("## [0.21.0]");
    } finally {
      cap.restore();
    }
  });

  it("CI mutation of a ROADMAP candidate is caught after CI; CHANGELOG is not written", () => {
    const root = seededRepo();
    let wrote = false;
    const cap = capture();
    try {
      const rc = runPipeline(config(root, { skipCi: false, allowVbriefDrift: true }), {
        todayIso: () => "2026-04-28",
        spawnText: (_c, a) => {
          if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
          if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        checkTagAvailable: () => [true, "ok"],
        runCi: () => {
          writeFileSync(join(root, "xbrief", "pending", "story.xbrief.json"), `${MINIMAL}\n`);
          return [true, "ci"];
        },
        writeFile: () => {
          wrote = true;
        },
      });
      expect(rc).toBe(EXIT_VIOLATION);
      expect(wrote).toBe(false);
      expect(cap.text()).toContain("[release-input]");
      expect(cap.text()).toContain("did not promote CHANGELOG");
      expect(cap.text()).toMatch(/\[6\/13\].*FAIL/);
    } finally {
      cap.restore();
    }
  });

  it("escapes a newline-bearing Step 3 mismatch reason onto one line", () => {
    const cap = capture();
    const root = seededRepo();
    try {
      const rc = runPipeline(config(root, { allowVbriefDrift: false }), {
        todayIso: () => "2026-04-28",
        spawnText: (_c, a) => {
          if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
          if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        checkTagAvailable: () => [true, "ok"],
        checkVbriefLifecycleSync: () => [
          false,
          1,
          "1 closed-issue vBRIEF(s) not in completed/ or cancelled/: pending/foo\n[3/13] Pre-flight vBRIEF lifecycle sync... OK (no mismatches)",
        ],
        fileExists: () => true,
        readFile: () => "## [Unreleased]\n\n### Added\n- x\n",
        validateReleaseInputs: passReleaseInputs,
      });
      expect(rc).toBe(EXIT_VIOLATION);
      const text = cap.text();
      expect(text).toContain("\\n");
      expect(
        text
          .split("\n")
          .some((l) =>
            /^\[3\/13\] Pre-flight vBRIEF lifecycle sync\.\.\. OK \(no mismatches\)/.test(l),
          ),
      ).toBe(false);
    } finally {
      cap.restore();
    }
  });
});
