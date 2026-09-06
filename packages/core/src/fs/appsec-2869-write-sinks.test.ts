/**
 * Regression: AppSec #2869 — five MEDIUM symlink-follow write sinks.
 * Leaf and/or parent-dir escapes must fail closed with no outside overwrite.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeVbrief } from "../intake/issue-emit.js";
import { ingestOne } from "../intake/issue-ingest.js";
import { probeSessionReleaseAvailability } from "../session/release-availability.js";
import { coveragePath, writeCoverageDenominator } from "../triage/scope/coverage.js";
import { VBRIEF_DEPRECATION_MARKER_FILENAME } from "../xbrief-migrate/constants.js";
import { convergeLegacyVbriefRoot } from "../xbrief-migrate/migrate-project.js";
import { ProjectionContainmentError } from "./projection-containment.js";

const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("AppSec write sinks symlink containment (#2869)", () => {
  itSymlink("coverage denominator refuses a leaf coverage.json symlink escape", () => {
    const root = temp("deft-2869-cov-root-");
    const outsideDir = temp("deft-2869-cov-escape-");
    const victim = join(outsideDir, "outside-coverage.json");
    writeFileSync(victim, "KEEP\n", "utf8");

    mkdirSync(join(root, ".deft-cache", "github-issue", "owner", "repo"), { recursive: true });
    const path = coveragePath("github-issue", "owner/repo", { projectRoot: root });
    symlinkSync(victim, path);

    expect(() =>
      writeCoverageDenominator(path, {
        count: 9,
        subscriptionHashValue: "abc",
        projectRoot: root,
      }),
    ).toThrow(ProjectionContainmentError);
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  itSymlink("coverage denominator refuses a parent-dir .deft-cache symlink escape", () => {
    const root = temp("deft-2869-cov-parent-root-");
    const outsideDir = temp("deft-2869-cov-parent-escape-");
    writeFileSync(join(outsideDir, "poisoned.json"), "KEEP\n", "utf8");
    symlinkSync(outsideDir, join(root, ".deft-cache"), "dir");

    const path = coveragePath("github-issue", "owner/repo", { projectRoot: root });
    expect(() =>
      writeCoverageDenominator(path, {
        count: 3,
        subscriptionHashValue: "hash",
        projectRoot: root,
      }),
    ).toThrow(/projection write refused|symlink/);
    expect(readFileSync(join(outsideDir, "poisoned.json"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, "github-issue"))).toBe(false);
  });

  itSymlink("ingestOne refuses an escaping xbrief/proposed folder symlink", () => {
    const root = temp("deft-2869-ingest-root-");
    const outsideDir = temp("deft-2869-ingest-escape-");
    writeFileSync(join(outsideDir, "secret.txt"), "KEEP\n", "utf8");

    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    symlinkSync(outsideDir, join(xbrief, "proposed"), "dir");

    expect(() =>
      ingestOne(
        {
          number: 2869,
          title: "Symlink sink",
          url: "https://github.com/o/r/issues/2869",
          body: "",
          labels: [],
        },
        {
          vbriefDir: xbrief,
          status: "proposed",
          repoUrl: "https://github.com/o/r",
          cwd: root,
          scmCall: () => ({ stdout: "[]", stderr: "", returncode: 0 }),
        },
      ),
    ).toThrow(/projection write refused|symlink/);
    expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("KEEP\n");
    // No xBRIEF JSON written through the escape folder.
    const escapedNames = readdirSync(outsideDir).filter((n) => n.endsWith(".json"));
    expect(escapedNames).toEqual([]);
  });

  itSymlink("writeVbrief refuses a leaf xBRIEF symlink escape", () => {
    const root = temp("deft-2869-emit-root-");
    const outsideDir = temp("deft-2869-emit-escape-");
    const victim = join(outsideDir, "victim.xbrief.json");
    writeFileSync(victim, '{"plan":{"title":"KEEP"}}\n', "utf8");

    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const path = join(root, "xbrief", "pending", "story.xbrief.json");
    symlinkSync(victim, path);

    expect(() => writeVbrief(path, { plan: { title: "overwrite" } }, root)).toThrow(
      ProjectionContainmentError,
    );
    expect(readFileSync(victim, "utf8")).toBe('{"plan":{"title":"KEEP"}}\n');
  });

  it("writeVbrief refuses when project root cannot be resolved (no dirname fallback)", () => {
    const bare = temp("deft-2869-emit-no-root-");
    const path = join(bare, "story.xbrief.json");
    // Force unresolvable root via env (walk-up may hit filesystem ancestors on win32).
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = join(tmpdir(), "deft-2869-missing-project-root");
    try {
      expect(() => writeVbrief(path, { plan: { title: "no root" } })).toThrow(
        ProjectionContainmentError,
      );
      expect(existsSync(path)).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_PROJECT_ROOT;
      } else {
        process.env.DEFT_PROJECT_ROOT = prev;
      }
    }
  });

  itSymlink("release-availability state path refuses a parent .triage-cache symlink escape", () => {
    const root = temp("deft-2869-rel-root-");
    const outsideDir = temp("deft-2869-rel-escape-");
    writeFileSync(join(outsideDir, "keep.txt"), "KEEP\n", "utf8");

    mkdirSync(join(root, "xbrief"), { recursive: true });
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "VERSION"),
      `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n`,
      "utf8",
    );
    symlinkSync(outsideDir, join(root, "xbrief", ".triage-cache"), "dir");

    let wroteOutside = false;
    const result = probeSessionReleaseAvailability(root, {
      env: {},
      isFile: (p) => p === join(root, ".deft", "core", "VERSION") || existsSync(p),
      readText: (p) => {
        if (p.endsWith("VERSION")) {
          return `sha: ${"a".repeat(40)}\nref: v1.0.0\ntag: v1.0.0\n`;
        }
        try {
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      runNpmView: () => ({ ok: true, version: "9.9.9" }),
      writeState: () => {
        wroteOutside = true;
      },
    });

    // Containment refusal skips throttle state; advisory still surfaces.
    expect(wroteOutside).toBe(false);
    expect(result.lines.some((l) => l.includes("Newer Directive release"))).toBe(true);
    expect(readFileSync(join(outsideDir, "keep.txt"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, "release-availability-state.json"))).toBe(false);
  });

  itSymlink("converge deprecation marker refuses a leaf DEPRECATED.md symlink escape", () => {
    const root = temp("deft-2869-mig-root-");
    const outsideDir = temp("deft-2869-mig-escape-");
    const victim = join(outsideDir, "DEPRECATED.md");
    writeFileSync(victim, "KEEP\n", "utf8");

    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "story.vbrief.json"), "{}\n", "utf8");
    symlinkSync(victim, join(root, "vbrief", VBRIEF_DEPRECATION_MARKER_FILENAME));

    expect(() => convergeLegacyVbriefRoot(root, { retain: true })).toThrow(
      /projection write refused|symlink/,
    );
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  itSymlink("converge deprecation marker refuses a parent vbrief/ dir symlink escape", () => {
    const root = temp("deft-2869-mig-parent-root-");
    const outsideDir = temp("deft-2869-mig-parent-escape-");
    writeFileSync(join(outsideDir, "keep.txt"), "KEEP\n", "utf8");
    // Real content so converge marks rather than removes.
    writeFileSync(join(outsideDir, "story.vbrief.json"), "{}\n", "utf8");
    symlinkSync(outsideDir, join(root, "vbrief"), "dir");

    expect(() => convergeLegacyVbriefRoot(root, { retain: true })).toThrow(
      /projection write refused|symlink/,
    );
    expect(readFileSync(join(outsideDir, "keep.txt"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, VBRIEF_DEPRECATION_MARKER_FILENAME))).toBe(false);
  });
});
