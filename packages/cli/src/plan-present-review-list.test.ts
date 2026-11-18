/**
 * #6006 / AC5.16: "Review and commit" lists every path install, repair or upgrade
 * created or changed (grouped by folder), and never node_modules or readiness markers.
 */
import { describe, expect, it } from "vitest";
import {
  collectReviewPaths,
  type PresentIo,
  presentInstallSuccess,
  presentRepairSuccess,
  presentUpgradeSuccess,
} from "./plan-present.js";

function capture(): { io: PresentIo; out: () => string } {
  const buf: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        buf.push(t);
      },
      writeErr: () => {},
    },
    out: () => buf.join(""),
  };
}

describe("#6006 Review and commit lists every changed path", () => {
  const skills = Array.from({ length: 12 }, (_, i) => `.agents/skills/skill-${i}/SKILL.md`);
  const summary = {
    created: [
      "AGENTS.md",
      ".deft/GENERATION.json",
      ...skills,
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      ".claude/settings.json",
      ".claude/deft-hook-1a2b3c4d.mjs",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
      ".deft/directive/wiring-ready.1.2.3.json",
      "node_modules/@deftai/directive-runtime/package.json",
    ],
    modified: [".gitignore", "Taskfile.yml"],
    removed: [],
  };

  function reviewBlock(text: string): string {
    const start = text.indexOf("Review and commit:");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start);
    const end = rest.indexOf("\n\n");
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("install success covers every created and modified path, grouped by folder", () => {
    const c = capture();
    presentInstallSuccess(c.io, {
      version: "1.2.3",
      projectRoot: "/tmp/shop",
      pm: "npm",
      summary,
      verbosity: 0,
    });
    const block = reviewBlock(c.out());
    const lines = block
      .split("\n")
      .slice(1)
      .map((l) => l.trim());
    // Headline files first, after the package files.
    expect(lines.slice(0, 6)).toEqual([
      "package.json",
      "package-lock.json",
      "AGENTS.md",
      ".gitignore",
      "Taskfile.yml",
      ".deft/GENERATION.json",
    ]);
    expect(lines).toContain(".agents/skills/ (12 files)");
    for (const p of [
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      ".claude/settings.json",
      ".claude/deft-hook-1a2b3c4d.mjs",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
    ]) {
      expect(lines, p).toContain(p);
    }
    expect(block).not.toMatch(/node_modules/);
    expect(block).not.toMatch(/wiring-ready/);
    // No duplicates.
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("every summary path is covered directly or under a grouped folder line", () => {
    const review = collectReviewPaths([summary]);
    const groups = review
      .filter((l) => / \(\d+ files\)$/.test(l))
      .map((l) => l.replace(/ \(\d+ files\)$/, ""));
    for (const p of [...summary.created, ...summary.modified]) {
      if (p.startsWith("node_modules/") || p.includes("wiring-ready.")) continue;
      const covered = review.includes(p) || groups.some((g) => p.startsWith(g));
      expect(covered, p).toBe(true);
    }
  });

  it("small folders are listed file by file; no 16-path cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => `file-${i}.md`);
    const review = collectReviewPaths([{ created: many, modified: [], removed: [] }]);
    expect(review).toEqual(many);
  });

  it("repair and upgrade success use the same complete list", () => {
    const r = capture();
    presentRepairSuccess(r.io, {
      version: "1.2.3",
      restoredPackage: false,
      summary,
      verbosity: 0,
    });
    expect(reviewBlock(r.out())).toContain(".agents/skills/ (12 files)");
    expect(reviewBlock(r.out())).toContain(".githooks/pre-commit");

    const u = capture();
    presentUpgradeSuccess(u.io, {
      version: "1.2.3",
      versionChange: true,
      pm: "pnpm",
      summary,
      migrateSummary: {
        created: [],
        modified: [],
        removed: [],
        migrated: ["xbrief/data-schema.json", "AGENTS.md"],
      },
      verbosity: 0,
    });
    const block = reviewBlock(u.out());
    expect(block).toContain("pnpm-lock.yaml");
    expect(block).toContain(".agents/skills/ (12 files)");
    expect(block).toContain("xbrief/data-schema.json");
    expect(block).not.toMatch(/node_modules|wiring-ready/);
    const lines = block.split("\n").slice(1);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
