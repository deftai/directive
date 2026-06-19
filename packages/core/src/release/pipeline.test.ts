import { describe, expect, it } from "vitest";
import { prependUpgradeBanner } from "./changelog.js";
import { formatReleaseHelp } from "./flags.js";
import { checkTagAvailable } from "./gh.js";
import { cmdRelease } from "./main.js";
import { emit, runPipeline } from "./pipeline.js";
import { syncPyprojectForRelease } from "./pyproject-sync.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

describe("cmdRelease", () => {
  it("returns 2 for invalid version", () => {
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(cmdRelease(["not-a-version"])).toBe(2);
      expect(err.join("")).toContain("Invalid version");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("prints help on --help", () => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(cmdRelease(["--help"])).toBe(0);
      expect(out.join("")).toBe(formatReleaseHelp());
    } finally {
      process.stdout.write = orig;
    }
  });

  it("returns 2 when version missing", () => {
    expect(cmdRelease(["--dry-run"])).toBe(2);
  });
});

describe("runPipeline dry-run", () => {
  const baseConfig: ReleaseConfig = {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot: "/tmp/proj",
    dryRun: true,
    skipTag: true,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: true,
    skipBuild: false,
    summary: null,
    allowVbriefDrift: true,
  };

  it("emits DRYRUN steps and returns 0", () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const seams: ReleaseSeams = {
      todayIso: () => "2026-04-28",
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => `## [Unreleased]\n\n### Added\n`,
    };

    try {
      expect(runPipeline(baseConfig, seams)).toBe(0);
      const err = lines.join("");
      expect(err).toContain("DRYRUN");
      expect(err).toContain("SKIP (--skip-tag)");
      expect(err).toContain("pipeline complete");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("returns config error when CHANGELOG missing", () => {
    const seams: ReleaseSeams = {
      fileExists: () => false,
    };
    expect(runPipeline(baseConfig, seams)).toBe(2);
  });
});

describe("emit", () => {
  it("formats step label", () => {
    const chunks: string[] = [];
    const target = { write: (s: string) => chunks.push(s) };
    emit(1, "Test step", "OK", target as unknown as NodeJS.WriteStream);
    expect(chunks[0]).toBe("[1/13] Test step... OK\n");
  });
});

describe("prependUpgradeBanner", () => {
  it("no-ops for consumer repo", () => {
    expect(prependUpgradeBanner("notes", "other/repo", "/root", () => "banner")).toBe("notes");
  });

  it("prepends banner for maintainer repo", () => {
    const out = prependUpgradeBanner("notes", "deftai/directive", "/root", () => "Upgrade me");
    expect(out).toBe("Upgrade me\n\nnotes");
  });

  it("returns notes when banner is whitespace only", () => {
    expect(prependUpgradeBanner("notes", "deftai/directive", "/r", () => "   \n")).toBe("notes");
  });
});

describe("syncPyprojectForRelease", () => {
  it("skips when pyproject absent", () => {
    const [note] = syncPyprojectForRelease(
      "/no/file",
      "0.21.0",
      { dryRun: true },
      {
        fileExists: () => false,
      },
    );
    expect(note).toContain("skipping sync");
  });
});

describe("checkTagAvailable", () => {
  it("detects local tag conflict", () => {
    const seams: ReleaseSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("tag") && args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => null,
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "deftai/directive", "/proj", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("local tag");
  });
});
