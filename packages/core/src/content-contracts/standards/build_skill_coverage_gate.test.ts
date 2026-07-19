import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import { iterTaskBlocks, readRoot } from "./_taskfile-helpers.js";

const INCLUDE_LINE = /^\s{2}([A-Za-z][\w-]*):\s*$/;
const TASKFILE_LINE = /^\s{4}taskfile:\s+\.\/tasks\/([\w-]+\.ya?ml)\s*$/;
const BUILD_SKILL_PATH = join(repoRoot(), "content/skills/deft-directive-build/SKILL.md");
const REQUIRED_COVERAGE_TASK = "test:coverage";

function parseIncludes(text: string): Map<string, string> {
  const includes = new Map<string, string>();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inIncludes = false;
  let currentKey: string | null = null;
  for (const line of lines) {
    if (line.startsWith("includes:")) {
      inIncludes = true;
      continue;
    }
    if (inIncludes && line && !line.startsWith(" ") && !line.startsWith("\t")) {
      inIncludes = false;
      currentKey = null;
      continue;
    }
    if (!inIncludes) continue;
    const keyMatch = line.match(INCLUDE_LINE);
    if (keyMatch?.[1]) {
      currentKey = keyMatch[1];
      continue;
    }
    const fileMatch = line.match(TASKFILE_LINE);
    if (fileMatch?.[1] && currentKey) {
      includes.set(currentKey, fileMatch[1]);
      currentKey = null;
    }
  }
  return includes;
}

function collectTaskSurface(): Set<string> {
  const names = new Set<string>();
  const rootText = readRoot("Taskfile.yml");
  for (const { name } of iterTaskBlocks(rootText)) {
    names.add(name);
  }
  const includes = parseIncludes(rootText);
  for (const [namespace, fileName] of includes) {
    const fragmentPath = join(repoRoot(), "tasks", fileName);
    const fragmentText = readFileSync(fragmentPath, { encoding: "utf8" })
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    for (const { name, start, end } of iterTaskBlocks(fragmentText)) {
      const body = fragmentText.split("\n").slice(start, end).join("\n");
      if (/^\s+internal:\s*true\s*$/m.test(body)) {
        continue;
      }
      names.add(`${namespace}:${name}`);
    }
  }
  return names;
}

/** Extract bare `task namespace:verb` tokens from maintainer docs. */
function extractDocumentedTaskRefs(text: string): string[] {
  const refs: string[] = [];
  const re = /`task ([a-z][\w:-]*)`/g;
  for (const match of text.matchAll(re)) {
    const name = match[1];
    if (name && !name.includes("<") && !name.includes(">")) {
      refs.push(name);
    }
  }
  return refs;
}

/** Extract coverage-gate task refs from the build skill (backtick or code-block lines). */
function extractBuildSkillCoverageRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const name of extractDocumentedTaskRefs(text)) {
    if (name === REQUIRED_COVERAGE_TASK) refs.add(name);
  }
  const plainRe = /^task (test:coverage)\b/gm;
  for (const match of text.matchAll(plainRe)) {
    if (match[1]) refs.add(match[1]);
  }
  return [...refs];
}

describe("build skill coverage gate (#2528)", () => {
  it("registers test:coverage on the Taskfile surface", () => {
    const surface = collectTaskSurface();
    expect(surface.has(REQUIRED_COVERAGE_TASK), `missing task ${REQUIRED_COVERAGE_TASK}`).toBe(
      true,
    );
  });

  it("test:coverage aliases ts:test (canonical coverage path in task check)", () => {
    const rootText = readRoot("Taskfile.yml");
    const block = iterTaskBlocks(rootText).find((b) => b.name === REQUIRED_COVERAGE_TASK);
    expect(block).toBeDefined();
    const body = rootText.split("\n").slice(block?.start, block?.end).join("\n");
    expect(body).toContain("task: ts:test");
  });

  it("build skill coverage gate task references resolve on the Taskfile surface", () => {
    const skill = readFileSync(BUILD_SKILL_PATH, { encoding: "utf8" });
    const documented = extractBuildSkillCoverageRefs(skill);
    expect(documented.length).toBeGreaterThan(0);
    const surface = collectTaskSurface();
    for (const name of documented) {
      expect(surface.has(name), `build skill references missing task ${name}`).toBe(true);
    }
  });
});
