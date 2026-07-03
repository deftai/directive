import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

/**
 * Runtime/session task dispatch must not depend on engine:_ts-build / pnpm (#2181).
 *
 * Session-start and sibling ritual commands run the already-built CLI or fail fast
 * with an actionable message -- they must never invoke package managers or compile
 * TypeScript as a side effect of dispatch.
 */

const RUNTIME_SESSION_TASKFILES: Readonly<
  Record<string, readonly { task: string; mustNotDependOnBuild?: boolean }[]>
> = {
  "session.yml": [{ task: "start", mustNotDependOnBuild: true }],
  "triage-summary.yml": [{ task: "summary", mustNotDependOnBuild: true }],
  "triage-welcome.yml": [{ task: "welcome", mustNotDependOnBuild: true }],
  "verify.yml": [
    { task: "session-ritual", mustNotDependOnBuild: true },
    { task: "tools", mustNotDependOnBuild: true },
    { task: "cache-fresh", mustNotDependOnBuild: true },
  ],
};

const TS_BUILD_DEP =
  /(?:deps:\s*\[[^\]]*":engine:_ts-build"[^\]]*\])|(?:-\s*task:\s*:engine:_ts-build\b)/;
const RAW_PNPM_BUILD = /pnpm\s+(?:--dir\s+"[^"]*"\s+|-C\s+"[^"]*"\s+)?run build/;

function readTask(name: string): string {
  return readFileSync(join(repoRoot(), "tasks", name), { encoding: "utf8" });
}

function taskBlock(text: string, taskName: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(`${taskName}:`));
  expect(start, `task ${taskName}`).toBeGreaterThan(-1);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {2}\S/.test(line) && !line.startsWith("    ")) break;
    block.push(line);
  }
  return block.join("\n");
}

describe("runtime/session task dispatch (#2181)", () => {
  const engine = readTask("engine.yml");

  it("engine:invoke fails fast on buildable source checkout without dist/bin.js", () => {
    expect(engine).toMatch(/is_buildable_source=1/);
    expect(engine).toMatch(/CLI artifact missing/);
    expect(engine).toMatch(/task build/);
    // Must not fall through to global deft when source is buildable but dist is absent.
    const invokeBlock = engine.slice(engine.indexOf("invoke:"));
    const failFastBranch = invokeBlock.match(
      /elif \[ "\$is_buildable_source" = 1 \]; then[\s\S]*?exit 2/m,
    );
    expect(failFastBranch, "fail-fast branch for missing artifact").not.toBeNull();
    expect(failFastBranch?.[0]).not.toMatch(/command -v deft/);
  });

  it("engine:invoke runs vendored bin.js when the artifact is present", () => {
    expect(engine).toMatch(/if \[ -f "\$bin" \]; then[\s\S]*node "\$bin" \{\{\.ENGINE_CMD\}\}/m);
  });

  it("engine:invoke checks Node via process.versions.node, not pnpm engine warnings", () => {
    expect(engine).toMatch(/process\.versions\.node/);
    expect(engine).toMatch(/engines\.node/);
    const invokeBlock = engine.slice(engine.indexOf("invoke:"));
    expect(invokeBlock).not.toMatch(RAW_PNPM_BUILD);
  });

  for (const [file, tasks] of Object.entries(RUNTIME_SESSION_TASKFILES)) {
    describe(`tasks/${file}`, () => {
      const text = readTask(file);

      for (const { task, mustNotDependOnBuild } of tasks) {
        it(`${task} dispatches through :engine:invoke`, () => {
          const block = taskBlock(text, task);
          expect(block).toMatch(/:engine:invoke/);
        });

        if (mustNotDependOnBuild) {
          it(`${task} does not depend on engine:_ts-build or raw pnpm build`, () => {
            const block = taskBlock(text, task);
            expect(TS_BUILD_DEP.test(block), `${task} has engine:_ts-build dep`).toBe(false);
            expect(RAW_PNPM_BUILD.test(block), `${task} has raw pnpm build`).toBe(false);
          });
        }
      }
    });
  }
});
