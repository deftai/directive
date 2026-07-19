import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import { iterTaskBlocks, readTaskfile } from "./_taskfile-helpers.js";

const REVIEW_CYCLE_SKILL = "skills/deft-directive-review-cycle/SKILL.md";
const REQUIRED_TASK = "lifecycle:event";

function parseIncludes(text: string): Map<string, string> {
  const includes = new Map<string, string>();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inIncludes = false;
  let currentKey: string | null = null;
  const includeLine = /^\s{2}([A-Za-z][\w-]*):\s*$/;
  const taskfileLine = /^\s{4}taskfile:\s+\.\/tasks\/([\w-]+\.ya?ml)\s*$/;
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
    const keyMatch = line.match(includeLine);
    if (keyMatch?.[1]) {
      currentKey = keyMatch[1];
      continue;
    }
    const fileMatch = line.match(taskfileLine);
    if (fileMatch?.[1] && currentKey) {
      includes.set(currentKey, fileMatch[1]);
      currentKey = null;
    }
  }
  return includes;
}

function collectTaskSurface(): Set<string> {
  const names = new Set<string>();
  const rootText = readFileSync(join(repoRoot(), "Taskfile.yml"), { encoding: "utf8" })
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  for (const { name } of iterTaskBlocks(rootText)) {
    names.add(name);
  }
  for (const [namespace, fileName] of parseIncludes(rootText)) {
    const fragmentText = readFileSync(join(repoRoot(), "tasks", fileName), { encoding: "utf8" })
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

describe("taskfile lifecycle:event approval recorder (#2631)", () => {
  it("registers lifecycle:event on the deposited Taskfile surface", () => {
    expect(collectTaskSurface().has(REQUIRED_TASK)).toBe(true);
  });

  it("lifecycle.yml forwards review-cycle args through engine:invoke", () => {
    const text = readTaskfile("lifecycle.yml");
    const block = iterTaskBlocks(text).find((entry) => entry.name === "event");
    expect(block).toBeDefined();
    const body = text.split("\n").slice(block?.start, block?.end).join("\n");
    expect(body).toContain(":engine:invoke");
    expect(body).toContain("lifecycle:event");
    expect(body).toContain("{{.CLI_ARGS}}");
    expect(body).not.toMatch(/^\s{4}(sources|generates)\s*:/m);
  });

  it("directive lifecycle:event resolves to lifecycle-event handler", () => {
    const dispatchText = readFileSync(join(repoRoot(), "packages/cli/src/dispatch.ts"), {
      encoding: "utf8",
    });
    expect(dispatchText).toContain('"lifecycle-event"');
    expect(dispatchText).toContain('"lifecycle:event": "lifecycle-event"');
  });

  it("review-cycle skill documents the same task spelling", () => {
    const text = readFileSync(join(repoRoot(), "content", REVIEW_CYCLE_SKILL), {
      encoding: "utf8",
    });
    expect(text).toContain("task lifecycle:event");
    expect(text).toContain("emit plan:approved");
    expect(text).toContain("--plan-ref");
    expect(text).toContain("--approver");
    expect(text).toContain("--approval-phrase");
    expect(text).toContain("--pr-number");
  });
});
