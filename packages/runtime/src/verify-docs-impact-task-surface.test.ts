import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";

function taskBlock(text: string, taskName: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(`${taskName}:`));
  expect(start, `task ${taskName}`).toBeGreaterThan(-1);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^ {2}\S/.test(line) && !line.startsWith("    ")) break;
    if (line !== undefined) block.push(line);
  }
  return block.join("\n");
}

describe("verify:docs-impact consumer task surface (#4356)", () => {
  it("routes verify:docs-impact through the docs-impact core verb", () => {
    expect(resolveCanonicalVerb("verify:docs-impact")).toBe("docs-impact");
    expect(resolveCanonicalVerb("docs-impact")).toBe("docs-impact");
  });

  it("verify.yml docs-impact uses engine:invoke, not a source-tree node path", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "verify.yml"), "utf8");
    const block = taskBlock(text, "docs-impact");
    expect(block).toContain(":engine:invoke");
    expect(block).toContain("ENGINE_CMD: 'docs-impact");
    expect(block).not.toContain("packages/core/dist/docs/docs-impact.js");
    expect(block).not.toMatch(/node\s+"\{\{\.DEFT_ROOT\}\}\/packages\//);
  });

  it("consumer-facing verify.yml node paths are engine:invoke or marked framework-source-only", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "verify.yml"), "utf8");
    const nodePath = /node\s+"\{\{\.DEFT_ROOT\}\}\/packages\//;
    const lines = text.split("\n");
    let current = "";
    let block: string[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const body = block.join("\n");
      if (!nodePath.test(body)) return;
      expect(body, current).toMatch(/framework-source/i);
    };
    for (const line of lines) {
      if (/^ {2}[A-Za-z_][\w:-]*\s*:/.test(line)) {
        flush();
        current = line.trim().replace(/:$/, "");
        block = [line];
        continue;
      }
      if (current.length > 0) block.push(line);
    }
    flush();
  });
});
