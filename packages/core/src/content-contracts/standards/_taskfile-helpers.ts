import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./_helpers.js";

const TASK_HEADER = /^ {2}([A-Za-z_][\w:-]*)\s*:\s*(?:#.*)?$/;
const CACHING_KEY = /^ {4}(sources|generates)\s*:\s*(?:#.*)?$/;

export function taskYamlFiles(): string[] {
  const dir = join(repoRoot(), "tasks");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(dir, f))
    .sort();
}

export function iterTaskBlocks(text: string): Array<{ name: string; start: number; end: number }> {
  const lines = text.split("\n");
  const taskPositions: Array<{ name: string; start: number }> = [];
  let inTasksSection = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    if (line.startsWith("tasks:")) {
      inTasksSection = true;
      continue;
    }
    if (inTasksSection && line && !line.startsWith(" ") && line.trim() !== "tasks:") {
      inTasksSection = false;
    }
    if (!inTasksSection) {
      continue;
    }
    const m = line.match(TASK_HEADER);
    if (m?.[1]) {
      taskPositions.push({ name: m[1], start: idx });
    }
  }
  const blocks: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < taskPositions.length; i += 1) {
    const cur = taskPositions[i];
    const next = taskPositions[i + 1];
    if (!cur) {
      continue;
    }
    blocks.push({ name: cur.name, start: cur.start, end: next?.start ?? lines.length });
  }
  return blocks;
}

export function blockBody(text: string, start: number, end: number): string {
  return text.split("\n").slice(start, end).join("\n");
}

export function nonCommentLines(block: string): string[] {
  return block.split("\n").filter((ln) => !ln.trimStart().startsWith("#"));
}

export function cachingKeyOnLine(line: string): string | null {
  const m = line.match(CACHING_KEY);
  return m?.[1] ?? null;
}

export function readTaskfile(name: string): string {
  return readFileSync(join(repoRoot(), "tasks", name), { encoding: "utf8" });
}

export function readRoot(name: string): string {
  return readFileSync(join(repoRoot(), "tasks", "..", name), { encoding: "utf8" });
}
