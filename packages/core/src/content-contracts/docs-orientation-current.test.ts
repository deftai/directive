import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./standards/_helpers.js";

/**
 * #4087 — content-contract over labeled-current trees in
 * docs/ARCHITECTURE.md, docs/CONCEPTS.md (Wave 1a), and docs/FILES.md (Wave 1b).
 * Same family as branch_gate.test.ts.
 *
 * Enforcement: FAIL-CLOSED. This vitest is in the packages/core check graph.
 * Covered surfaces: the three orientation files named above.
 * Relationship to #514: does not take #514's markdown-link allowlist. This pin
 * is a separate current-tense path check over labeled-current prose and
 * labeled-current FILES.md fences.
 * Allowlist: none. An allowlist addition in the same diff as the path it
 * exempts is forbidden by the #4087 recut.
 * Does not generate FILES.md. Does not reimplement C3.
 * Read-only against the tree under test (this worktree), not origin/master.
 * Path-class is declared in FILES.md comments, not in this test.
 */

const COVERED = ["docs/ARCHITECTURE.md", "docs/CONCEPTS.md"] as const;
const FILES_MD = "docs/FILES.md";
const COVERED_ALL = [...COVERED, FILES_MD] as const;

const HISTORICAL =
  /historical|legacy|retired|no longer|python\/run era|removed from the current tree|not current|not the current/i;

const RETIRED_LAUNCHER =
  /run\.py|run\.bat|preflight_branch\.py|scripts\/\*\.py|scripts\/[A-Za-z0-9_.-]+\.py|Python tooling/;

/** Hits in labeled-current (non-historical) lines. */
function retiredLauncherHits(markdown: string, rel: string): string[] {
  const hits: string[] = [];
  const lines = markdown.split("\n");
  let skipHeading = false;
  let skipHeadingLevel = 0;
  let skipQuote = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2] ?? "";
      if (HISTORICAL.test(title)) {
        skipHeading = true;
        skipHeadingLevel = level;
        continue;
      }
      if (skipHeading && level <= skipHeadingLevel) {
        skipHeading = false;
      }
    }
    if (line.startsWith(">")) {
      if (HISTORICAL.test(line) || skipQuote) {
        skipQuote = true;
        continue;
      }
    } else {
      skipQuote = false;
    }
    if (skipHeading) continue;
    if (RETIRED_LAUNCHER.test(line)) {
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  }
  return hits;
}

describe("docs orientation current-tense (#4087 Wave 1a) — FAIL-CLOSED", () => {
  it("unlabeled run.py in labeled-current prose is a hit", () => {
    expect(
      retiredLauncherHits("The launcher is `run.py`.\n", "docs/ARCHITECTURE.md").length,
    ).toBeGreaterThan(0);
  });

  it("historical-labeled run.py is not a hit", () => {
    expect(
      retiredLauncherHits(
        "> **Historical (Python/run era):** `run.py` and `run.bat`\n",
        "docs/ARCHITECTURE.md",
      ),
    ).toEqual([]);
  });

  it("mixed current prose with a historical keyword still hits run.py", () => {
    expect(
      retiredLauncherHits(
        "Do not invoke the legacy `run.py` launcher from current hooks.\n",
        "docs/ARCHITECTURE.md",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("covered orientation files exist", () => {
    for (const rel of COVERED) {
      expect(readText(rel).length).toBeGreaterThan(0);
    }
  });

  it("labeled-current ARCHITECTURE and CONCEPTS do not name retired Python launchers", () => {
    const hits: string[] = [];
    for (const rel of COVERED) {
      hits.push(...retiredLauncherHits(readText(rel), rel));
    }
    expect(hits).toEqual([]);
  });

  it("CONCEPTS MAP status claims rendering is shipped", () => {
    const concepts = readText("docs/CONCEPTS.md");
    expect(concepts).toMatch(/MAP rendering:\s*shipped/i);
    expect(concepts).not.toMatch(/MAP rendering:\s*planned/i);
  });

  it("ARCHITECTURE names runtime, Taskfile facade, consumer CLI, and hook entrypoints as separate lanes", () => {
    const arch = readText("docs/ARCHITECTURE.md");
    expect(arch).toMatch(/TypeScript packages/i);
    expect(arch).toMatch(/implementation and runtime owner/i);
    expect(arch).toMatch(/repository command facade/i);
    expect(arch).toMatch(/`deft`\s*\/\s*`directive`/);
    expect(arch).toMatch(/installed consumer CLI/i);
    expect(arch).toMatch(/deft-hook/);
    expect(arch).toMatch(/Git-hook/i);
    expect(arch).toMatch(/_directive-run\.sh/);
    expect(arch).toMatch(/agent-host/i);
  });
});

type PathClass = "repo-tracked" | "generated-on-demand" | "consumer-install" | "illustrative";

interface TreeEntry {
  path: string;
  comment: string;
  pathClass: PathClass;
}

const BOX_CHARS = /[│├└─┬┤┌┐┘┴]/;
const ROOT_GUIDANCE = /^(coding|skills|vbrief|packs)\/?$/;
const BANNED_ROOT_FILES = new Set([
  "run",
  "run.py",
  "run.bat",
  "pyproject.toml",
  "uv.lock",
  "LICENSE.md",
  "QUICK-START.md",
  "UPGRADING.md",
  "commands.md",
  "tasks/release.yml",
]);

function pathClassFromComment(comment: string): PathClass {
  if (/generated-on-demand/i.test(comment)) return "generated-on-demand";
  if (/consumer-install/i.test(comment)) return "consumer-install";
  if (/illustrative/i.test(comment)) return "illustrative";
  return "repo-tracked";
}

function labeledCurrentLines(markdown: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  const lines = markdown.split("\n");
  let skipHeading = false;
  let skipHeadingLevel = 0;
  let skipQuote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2] ?? "";
      if (HISTORICAL.test(title)) {
        skipHeading = true;
        skipHeadingLevel = level;
        continue;
      }
      if (skipHeading && level <= skipHeadingLevel) {
        skipHeading = false;
      }
    }
    if (line.startsWith(">")) {
      if (HISTORICAL.test(line) || skipQuote) {
        skipQuote = true;
        continue;
      }
    } else {
      skipQuote = false;
    }
    if (skipHeading) continue;
    out.push({ line, n: i + 1 });
  }
  return out;
}

function labeledCurrentTextFences(markdown: string): string[] {
  const current = labeledCurrentLines(markdown)
    .map((row) => row.line)
    .join("\n");
  const fences: string[] = [];
  const re = /```text\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = re.exec(current);
  while (match) {
    fences.push(match[1] ?? "");
    match = re.exec(current);
  }
  return fences;
}

function splitComment(raw: string): { code: string; comment: string } {
  const hash = raw.indexOf("#");
  if (hash < 0) return { code: raw, comment: "" };
  return { code: raw.slice(0, hash), comment: raw.slice(hash + 1) };
}

function lineToken(code: string): string {
  return (
    code
      .replace(/[│├└─┬┤┌┐┘┴]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")[0] ?? ""
  );
}

function normalizeTreePath(path: string): string {
  let rel = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel === "deft" || rel === "deft/") return "";
  if (rel.startsWith("deft/")) rel = rel.slice("deft/".length);
  return rel;
}

function extractTreeEntries(fence: string): TreeEntry[] {
  const rows = fence.split("\n").map((raw) => {
    const { code, comment } = splitComment(raw);
    return { raw, code, comment, token: lineToken(code), nested: BOX_CHARS.test(code) };
  });
  const useful = rows.filter((row) => row.token.length > 0);
  if (useful.length === 0) return [];

  const isNested = useful.some((row) => row.nested);
  if (!isNested) {
    return useful
      .map((row) => {
        const path = normalizeTreePath(row.token);
        return path
          ? { path, comment: row.comment, pathClass: pathClassFromComment(row.comment) }
          : null;
      })
      .filter((entry): entry is TreeEntry => entry !== null);
  }

  const entries: TreeEntry[] = [];
  let prefix = "";
  let seenRoot = false;
  for (const row of useful) {
    if (!seenRoot && !row.nested) {
      seenRoot = true;
      const root = normalizeTreePath(row.token);
      prefix = root === "" ? "" : root.endsWith("/") ? root : `${root}/`;
      if (root !== "") {
        entries.push({
          path: prefix,
          comment: row.comment,
          pathClass: pathClassFromComment(row.comment),
        });
      }
      continue;
    }
    const child = row.token.replace(/^\//, "");
    const path = normalizeTreePath(`${prefix}${child}`);
    if (!path) continue;
    entries.push({
      path,
      comment: row.comment,
      pathClass: pathClassFromComment(row.comment),
    });
  }
  return entries;
}

function isBannedCurrentPath(rel: string): boolean {
  const trimmed = rel.replace(/\/$/, "");
  if (BANNED_ROOT_FILES.has(rel) || BANNED_ROOT_FILES.has(trimmed)) return true;
  if (ROOT_GUIDANCE.test(rel) || ROOT_GUIDANCE.test(trimmed)) return true;
  if (/^(coding|skills|vbrief|packs)\//.test(rel) && !rel.startsWith("content/")) {
    return true;
  }
  return false;
}

function currentTreeGhostHits(markdown: string): string[] {
  const hits: string[] = [];
  for (const fence of labeledCurrentTextFences(markdown)) {
    for (const entry of extractTreeEntries(fence)) {
      if (isBannedCurrentPath(entry.path)) {
        hits.push(entry.path);
      }
    }
  }
  return hits;
}

let trackedFilesCache: Set<string> | null = null;

function trackedFiles(): Set<string> {
  if (trackedFilesCache) return trackedFilesCache;
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  trackedFilesCache = new Set(out.split("\0").filter((p) => p.length > 0));
  return trackedFilesCache;
}

function existsInTreeUnderTest(rel: string): boolean {
  const root = repoRoot();
  const abs = join(root, rel.replace(/\/$/, ""));
  if (existsSync(abs)) return true;
  const files = trackedFiles();
  const exact = rel.replace(/\/$/, "");
  if (files.has(exact) || files.has(rel)) return true;
  const prefix = exact === "" ? "" : `${exact}/`;
  if (prefix === "") return true;
  for (const file of files) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

function contentSkillNames(): string[] {
  const dir = join(repoRoot(), "content/skills");
  return readdirSync(dir)
    .filter((name) => {
      const abs = join(dir, name);
      return statSync(abs).isDirectory() && name.startsWith("deft-directive-");
    })
    .sort();
}

describe("docs orientation current-tense (#4087 Wave 1b FILES.md) — FAIL-CLOSED", () => {
  it("unlabeled run.py in a labeled-current FILES.md fence is a hit", () => {
    const sample = ["## Top Level", "", "```text", "run.py", "```", ""].join("\n");
    expect(currentTreeGhostHits(sample)).toContain("run.py");
  });

  it("historical-labeled run.py fence is not a hit", () => {
    const sample = [
      "## Historical Python/run era",
      "",
      "```text",
      "run.py",
      "run.bat",
      "```",
      "",
    ].join("\n");
    expect(currentTreeGhostHits(sample)).toEqual([]);
  });

  it("unlabeled root coding/ in a labeled-current fence is a hit", () => {
    const sample = ["## Framework Guidance", "", "```text", "coding/", "```", ""].join("\n");
    expect(currentTreeGhostHits(sample)).toContain("coding/");
  });

  it("content/coding/ in a labeled-current fence is not a ghost", () => {
    const sample = ["## Framework Guidance", "", "```text", "content/coding/", "```", ""].join(
      "\n",
    );
    expect(currentTreeGhostHits(sample)).toEqual([]);
  });

  it("FILES.md exists", () => {
    expect(readText(FILES_MD).length).toBeGreaterThan(0);
  });

  it("labeled-current FILES.md does not name retired Python launchers", () => {
    expect(retiredLauncherHits(readText(FILES_MD), FILES_MD)).toEqual([]);
  });

  it("labeled-current FILES.md trees do not list Python/run-era or root-guidance ghosts", () => {
    expect(currentTreeGhostHits(readText(FILES_MD))).toEqual([]);
  });

  it("labeled-current FILES.md does not name tasks/release.yml", () => {
    const current = labeledCurrentLines(readText(FILES_MD))
      .map((row) => row.line)
      .join("\n");
    expect(current).not.toMatch(/tasks\/release\.yml/);
  });

  it("FILES.md states the path-class axis", () => {
    const files = readText(FILES_MD);
    expect(files).toMatch(/repo-tracked/);
    expect(files).toMatch(/generated-on-demand/);
    expect(files).toMatch(/consumer-install/);
    expect(files).toMatch(/illustrative/);
  });

  it("repo-tracked paths in labeled-current FILES.md fences exist in the tree under test", () => {
    const missing: string[] = [];
    for (const fence of labeledCurrentTextFences(readText(FILES_MD))) {
      for (const entry of extractTreeEntries(fence)) {
        if (entry.pathClass !== "repo-tracked") continue;
        if (!existsInTreeUnderTest(entry.path)) missing.push(entry.path);
      }
    }
    expect(missing).toEqual([]);
  });

  it("MAP.md, .deft/core/, and USER.md are classified, not implied repo-tracked", () => {
    const files = readText(FILES_MD);
    expect(files).toMatch(/MAP\.md[^\n]*generated-on-demand/i);
    expect(files).toMatch(/\.deft\/core\/[^\n]*consumer-install/i);
    expect(files).toMatch(/USER\.md[^\n]*consumer-install/i);
  });

  it("labeled-current skills census names every content/skills directory", () => {
    const current = labeledCurrentLines(readText(FILES_MD))
      .map((row) => row.line)
      .join("\n");
    const missing = contentSkillNames().filter(
      (name) => !current.includes(`content/skills/${name}/`),
    );
    expect(missing).toEqual([]);
  });

  it("labeled-current consumer artifacts use xbrief/ not vbrief/ as live write paths", () => {
    const files = readText(FILES_MD);
    const start = files.indexOf("## Consumer Project Artifacts");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = files.slice(start);
    const next = rest.slice(2).search(/\n## /);
    const section = next >= 0 ? rest.slice(0, next + 2) : rest;
    const current = labeledCurrentLines(section)
      .map((row) => row.line)
      .join("\n");
    expect(current).toMatch(/xbrief\//);
    expect(current).not.toMatch(/vbrief\//);
    expect(current).not.toMatch(/skills\/deft-directive-/);
  });

  it("FILES.md does not present .planning/codebase STACK/CONVENTIONS as current authority", () => {
    const files = readText(FILES_MD);
    expect(files).toMatch(/STACK\.md[^\n]*residual/i);
    expect(files).toMatch(/CONVENTIONS\.md[^\n]*residual/i);
    expect(files).toMatch(/not current architecture authority/i);
  });

  it("covered orientation files including FILES.md exist", () => {
    for (const rel of COVERED_ALL) {
      expect(readText(rel).length).toBeGreaterThan(0);
    }
  });
});
