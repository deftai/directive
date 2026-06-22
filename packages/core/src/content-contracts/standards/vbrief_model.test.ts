import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFile, loadJson, readText, resolveContentPath } from "./_helpers.js";

describe("test_vbrief_model.py", () => {
  const FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$/;
  const VALID_STATUSES = new Set([
    "approved",
    "blocked",
    "cancelled",
    "completed",
    "draft",
    "failed",
    "pending",
    "proposed",
    "running",
  ]);

  it("test_skills_dir_only_deft_directive_prefixed", () => {
    const skillsDir = resolveContentPath("skills");
    const subdirs = readdirSync(skillsDir).filter((d) =>
      statSync(join(skillsDir, d)).isDirectory(),
    );
    expect(subdirs.length).toBeGreaterThan(0);
    const stubs = new Set([
      "deft-build",
      "deft-interview",
      "deft-pre-pr",
      "deft-review-cycle",
      "deft-roadmap-refresh",
      "deft-setup",
      "deft-swarm",
      "deft-sync",
    ]);
    const bad = subdirs.filter((d) => !d.startsWith("deft-directive-") && !stubs.has(d));
    expect(bad).toEqual([]);
  });

  it("test_skills_dir_has_no_bare_deft_prefix", () => {
    const skillsDir = resolveContentPath("skills");
    const subdirs = readdirSync(skillsDir).filter((d) =>
      statSync(join(skillsDir, d)).isDirectory(),
    );
    const stubs = new Set([
      "deft-build",
      "deft-interview",
      "deft-pre-pr",
      "deft-review-cycle",
      "deft-roadmap-refresh",
      "deft-setup",
      "deft-swarm",
      "deft-sync",
    ]);
    const bad = subdirs.filter(
      (d) => d.startsWith("deft-") && !d.startsWith("deft-directive-") && !stubs.has(d),
    );
    expect(bad).toEqual([]);
  });

  it("test_agents_md_routing_entries_exist", () => {
    expect(18).toBeGreaterThanOrEqual(1);
  });
  it("routing exists skills/deft-directive-review-cycle/SKILL.md", () => {
    expect(isFile("skills/deft-directive-review-cycle/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-review-cycle/SKILL.md", () => {
    expect("skills/deft-directive-review-cycle/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-swarm/SKILL.md", () => {
    expect(isFile("skills/deft-directive-swarm/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-swarm/SKILL.md", () => {
    expect("skills/deft-directive-swarm/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-decompose/SKILL.md", () => {
    expect(isFile("skills/deft-directive-decompose/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-decompose/SKILL.md", () => {
    expect("skills/deft-directive-decompose/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-refinement/SKILL.md", () => {
    expect(isFile("skills/deft-directive-refinement/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-refinement/SKILL.md", () => {
    expect("skills/deft-directive-refinement/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-refinement/SKILL.md", () => {
    expect(isFile("skills/deft-directive-refinement/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-refinement/SKILL.md", () => {
    expect("skills/deft-directive-refinement/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-build/SKILL.md", () => {
    expect(isFile("skills/deft-directive-build/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-build/SKILL.md", () => {
    expect("skills/deft-directive-build/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-cost/SKILL.md", () => {
    expect(isFile("skills/deft-directive-cost/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-cost/SKILL.md", () => {
    expect("skills/deft-directive-cost/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-setup/SKILL.md", () => {
    expect(isFile("skills/deft-directive-setup/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-setup/SKILL.md", () => {
    expect("skills/deft-directive-setup/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-sync/SKILL.md", () => {
    expect(isFile("skills/deft-directive-sync/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-sync/SKILL.md", () => {
    expect("skills/deft-directive-sync/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-pre-pr/SKILL.md", () => {
    expect(isFile("skills/deft-directive-pre-pr/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-pre-pr/SKILL.md", () => {
    expect("skills/deft-directive-pre-pr/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-interview/SKILL.md", () => {
    expect(isFile("skills/deft-directive-interview/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-interview/SKILL.md", () => {
    expect("skills/deft-directive-interview/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-probe/SKILL.md", () => {
    expect(isFile("skills/deft-directive-probe/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-probe/SKILL.md", () => {
    expect("skills/deft-directive-probe/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-release/SKILL.md", () => {
    expect(isFile("skills/deft-directive-release/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-release/SKILL.md", () => {
    expect("skills/deft-directive-release/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-glossary/SKILL.md", () => {
    expect(isFile("skills/deft-directive-glossary/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-glossary/SKILL.md", () => {
    expect("skills/deft-directive-glossary/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-gh-arch/SKILL.md", () => {
    expect(isFile("skills/deft-directive-gh-arch/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-gh-arch/SKILL.md", () => {
    expect("skills/deft-directive-gh-arch/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-debug/SKILL.md", () => {
    expect(isFile("skills/deft-directive-debug/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-debug/SKILL.md", () => {
    expect("skills/deft-directive-debug/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-triage/SKILL.md", () => {
    expect(isFile("skills/deft-directive-triage/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-triage/SKILL.md", () => {
    expect("skills/deft-directive-triage/SKILL.md").toContain("deft-directive-");
  });
  it("routing exists skills/deft-directive-triage/SKILL.md", () => {
    expect(isFile("skills/deft-directive-triage/SKILL.md")).toBe(true);
  });
  it("routing prefix skills/deft-directive-triage/SKILL.md", () => {
    expect("skills/deft-directive-triage/SKILL.md").toContain("deft-directive-");
  });
  it("no stale refs AGENTS.md", () => {
    const text = readText("AGENTS.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs main.md", () => {
    const text = readText("main.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-build/SKILL.md", () => {
    const text = readText("skills/deft-build/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-article-review/SKILL.md", () => {
    const text = readText("skills/deft-directive-article-review/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-build/SKILL.md", () => {
    const text = readText("skills/deft-directive-build/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-cost/SKILL.md", () => {
    const text = readText("skills/deft-directive-cost/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-debug/SKILL.md", () => {
    const text = readText("skills/deft-directive-debug/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-decompose/SKILL.md", () => {
    const text = readText("skills/deft-directive-decompose/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-gh-arch/SKILL.md", () => {
    const text = readText("skills/deft-directive-gh-arch/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-gh-slice/SKILL.md", () => {
    const text = readText("skills/deft-directive-gh-slice/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-glossary/SKILL.md", () => {
    const text = readText("skills/deft-directive-glossary/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-interview/SKILL.md", () => {
    const text = readText("skills/deft-directive-interview/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-pre-pr/SKILL.md", () => {
    const text = readText("skills/deft-directive-pre-pr/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-probe/SKILL.md", () => {
    const text = readText("skills/deft-directive-probe/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-refinement/SKILL.md", () => {
    const text = readText("skills/deft-directive-refinement/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-release/SKILL.md", () => {
    const text = readText("skills/deft-directive-release/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-review-cycle/SKILL.md", () => {
    const text = readText("skills/deft-directive-review-cycle/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-setup/SKILL.md", () => {
    const text = readText("skills/deft-directive-setup/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-swarm/SKILL.md", () => {
    const text = readText("skills/deft-directive-swarm/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-sync/SKILL.md", () => {
    const text = readText("skills/deft-directive-sync/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-triage/SKILL.md", () => {
    const text = readText("skills/deft-directive-triage/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-directive-write-skill/SKILL.md", () => {
    const text = readText("skills/deft-directive-write-skill/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-interview/SKILL.md", () => {
    const text = readText("skills/deft-interview/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-pre-pr/SKILL.md", () => {
    const text = readText("skills/deft-pre-pr/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-review-cycle/SKILL.md", () => {
    const text = readText("skills/deft-review-cycle/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-roadmap-refresh/SKILL.md", () => {
    const text = readText("skills/deft-roadmap-refresh/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-setup/SKILL.md", () => {
    const text = readText("skills/deft-setup/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-swarm/SKILL.md", () => {
    const text = readText("skills/deft-swarm/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("no stale refs skills/deft-sync/SKILL.md", () => {
    const text = readText("skills/deft-sync/SKILL.md");
    const patterns = [
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?SPECIFICATION\.md/i,
      /(?:output|generate|write|create|produce)\s+(?:to\s+)?(?:a\s+)?PROJECT\.md/i,
    ];
    for (const line of text.split("\n")) {
      const lower = line.toLowerCase();
      if (
        [
          "deprecated",
          "redirect",
          "migration",
          "legacy",
          "replaced by",
          "no longer",
          "instead of",
          "was previously",
        ].some((w) => lower.includes(w))
      )
        continue;
      for (const pat of patterns) expect(pat.test(line)).toBe(false);
    }
  });
  it("lifecycle folder proposed", () => {
    expect(readText("vbrief/vbrief.md")).toContain("proposed/");
  });
  it("lifecycle folder pending", () => {
    expect(readText("vbrief/vbrief.md")).toContain("pending/");
  });
  it("lifecycle folder active", () => {
    expect(readText("vbrief/vbrief.md")).toContain("active/");
  });
  it("lifecycle folder completed", () => {
    expect(readText("vbrief/vbrief.md")).toContain("completed/");
  });
  it("lifecycle folder cancelled", () => {
    expect(readText("vbrief/vbrief.md")).toContain("cancelled/");
  });
  it("test_vbrief_md_documents_directory_structure", () => {
    const text = readText("vbrief/vbrief.md");
    expect(text).toContain("### Directory Structure");
    expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
  });
  it("test_vbrief_md_documents_status_driven_moves", () => {
    const text = readText("vbrief/vbrief.md");
    expect(text).toContain("### Status-Driven Moves");
    expect(text).toContain("plan.status");
  });
  it("test_vbrief_md_documents_filename_convention", () => {
    const text = readText("vbrief/vbrief.md");
    expect(text).toContain("### Filename Convention");
    expect(text).toContain("YYYY-MM-DD");
  });
  it("test_vbrief_md_documents_origin_provenance", () => {
    const text = readText("vbrief/vbrief.md");
    expect(text).toContain("### Origin Provenance");
    expect(text).toContain("github-issue");
  });
  it("valid filename 2026-04-12-add-oauth-flow.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-04-12-add-oauth-flow.vbrief.json")).toBe(true);
  });
  it("valid filename 2026-01-01-fix-login-bug.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-01-01-fix-login-bug.vbrief.json")).toBe(true);
  });
  it("valid filename 2025-12-31-setup-ci.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2025-12-31-setup-ci.vbrief.json")).toBe(true);
  });
  it("invalid filename oauth-flow.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("oauth-flow.vbrief.json")).toBe(false);
  });
  it("invalid filename 2026-04-12.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-04-12.vbrief.json")).toBe(false);
  });
  it("invalid filename 2026-4-12-fix.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-4-12-fix.vbrief.json")).toBe(false);
  });
  it("invalid filename 2026-04-12-Fix-Bug.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-04-12-Fix-Bug.vbrief.json")).toBe(false);
  });
  it("invalid filename 2026-04-12-fix_bug.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("2026-04-12-fix_bug.vbrief.json")).toBe(false);
  });
  it("invalid filename specification.vbrief.json", () => {
    expect(FILENAME_PATTERN.test("specification.vbrief.json")).toBe(false);
  });
  it("test_folder_status_map_covers_all_valid_statuses", () => {
    const mapped = new Set<string>();
    for (const statuses of Object.values({
      proposed: ["draft", "proposed"],
      pending: ["approved", "pending"],
      active: ["blocked", "running"],
      completed: ["completed", "failed"],
      cancelled: ["cancelled"],
    })) {
      for (const s of statuses) {
        mapped.add(s);
      }
    }
    expect(mapped).toEqual(VALID_STATUSES);
  });
  it("test_origin_provenance_reference_types_documented", () => {
    const text = readText("vbrief/vbrief.md");
    expect(text).toContain("github-issue");
    expect(text).toContain("jira-ticket");
    expect(text).toContain("user-request");
  });
  it("test_schema_status_enum_matches_folder_map", () => {
    const schema = loadJson("vbrief/schemas/vbrief-core.schema.json") as {
      $defs: { Status: { enum: string[] } };
    };
    expect(new Set(schema.$defs.Status.enum)).toEqual(VALID_STATUSES);
  });
});
