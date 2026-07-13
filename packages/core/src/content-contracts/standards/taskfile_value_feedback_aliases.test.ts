import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import { iterTaskBlocks, readRoot, readTaskfile } from "./_taskfile-helpers.js";

/** Documented value-feedback / metrics `task` forms that must resolve (#2337). */
const REQUIRED_VALUE_TASK_ALIASES = [
  "policy:enable-value-feedback",
  "value:show",
  "triage:metrics",
  "feedback:file",
  "policy:show",
] as const;

const INCLUDE_LINE = /^\s{2}([A-Za-z][\w-]*):\s*$/;
const TASKFILE_LINE = /^\s{4}taskfile:\s+\.\/tasks\/([\w-]+\.ya?ml)\s*$/;

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

const VALUE_DOC_MARKERS = ["policy:enable-value-feedback", "value:show", "triage:metrics"] as const;

describe("taskfile value-feedback aliases (#2337)", () => {
  it("registers required value-feedback / metrics task names on the Taskfile surface", () => {
    const surface = collectTaskSurface();
    for (const name of REQUIRED_VALUE_TASK_ALIASES) {
      expect(surface.has(name), `missing task ${name}`).toBe(true);
    }
  });

  it("policy.yml forwards enable-value-feedback via engine:invoke", () => {
    const text = readTaskfile("policy.yml");
    const block = iterTaskBlocks(text).find((b) => b.name === "enable-value-feedback");
    expect(block).toBeDefined();
    const body = text.split("\n").slice(block?.start, block?.end).join("\n");
    expect(body).toContain("policy enable-value-feedback");
    expect(body).toContain("{{.CLI_ARGS}}");
  });

  it("value.yml and triage-metrics.yml forward CLI_ARGS without caching keys", () => {
    for (const file of ["value.yml", "triage-metrics.yml"]) {
      const text = readTaskfile(file);
      expect(text).toContain("{{.CLI_ARGS}}");
      expect(text).not.toMatch(/^\s{4}(sources|generates)\s*:/m);
    }
  });

  it("AGENTS.md value-feedback task references resolve on the Taskfile surface", () => {
    const agents = readFileSync(join(repoRoot(), "AGENTS.md"), { encoding: "utf8" });
    const documented = extractDocumentedTaskRefs(agents).filter((name) =>
      VALUE_DOC_MARKERS.some((marker) => name === marker),
    );
    expect(documented.length).toBeGreaterThan(0);
    const surface = collectTaskSurface();
    for (const name of documented) {
      expect(surface.has(name), `AGENTS.md references missing task ${name}`).toBe(true);
    }
  });
});
