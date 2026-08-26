import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

/**
 * Runtime/session task dispatch must not depend on engine:_ts-build / pnpm (#2181).
 *
 * Session-start and sibling ritual commands run the already-built CLI, fall back
 * to global deft on unbuilt source (#2409), or fail fast — they must never invoke
 * package managers or compile TypeScript as a side effect of dispatch.
 */

const RUNTIME_SESSION_TASKFILES: Readonly<
  Record<string, readonly { task: string; mustNotDependOnBuild?: boolean }[]>
> = {
  "session.yml": [
    { task: "start", mustNotDependOnBuild: true },
    { task: "end", mustNotDependOnBuild: true },
  ],
  "occupancy.yml": [
    { task: "steal", mustNotDependOnBuild: true },
    { task: "release", mustNotDependOnBuild: true },
  ],
  "triage-summary.yml": [{ task: "summary", mustNotDependOnBuild: true }],
  "triage-welcome.yml": [{ task: "welcome", mustNotDependOnBuild: true }],
  "verify.yml": [
    { task: "session-ritual", mustNotDependOnBuild: true },
    { task: "tools", mustNotDependOnBuild: true },
    { task: "cache-fresh", mustNotDependOnBuild: true },
  ],
};

const RUNTIME_VERB_TOKENS = [
  "session:start",
  "session-start",
  "occupancy:steal",
  "occupancy-steal",
  "occupancy:release",
  "occupancy-release",
  "session:end",
  "session-end",
  "lifecycle:event",
  "lifecycle-event",
  "verify:session-ritual",
  "verify-session-ritual",
  "verify:tools",
  "verify-tools",
  "triage:summary",
  "triage-summary",
  "triage:welcome",
  "triage-welcome",
  "verify:cache-fresh",
  "verify-cache-fresh",
  "preflight-cache",
] as const;

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
  const invokeBlock = engine.slice(engine.indexOf("invoke:"));

  it("engine:invoke allowlists runtime/session verbs for global fallback (#2409)", () => {
    for (const token of RUNTIME_VERB_TOKENS) {
      expect(invokeBlock, `missing runtime verb token ${token}`).toContain(`" ${token} "`);
    }
    expect(invokeBlock).toMatch(/DEFT_USE_GLOBAL_CLI/);
    expect(invokeBlock).toMatch(/command -v directive/);
    expect(invokeBlock).toMatch(/using global/);
  });

  it("engine:invoke still fail-closes build-gated verbs when dist is missing", () => {
    expect(invokeBlock).toMatch(/CLI artifact missing/);
    expect(invokeBlock).toMatch(/task build/);
    expect(invokeBlock).toMatch(/is_runtime_verb=1/);
  });

  it("engine:invoke runs vendored bin.js when the artifact is present", () => {
    expect(engine).toMatch(
      /if \[ -f "\$bin" \]; then[\s\S]*node "\{\{\.TASKFILE_DIR\}\}\/engine-invoke\.cjs" vendored "\$bin"/m,
    );
    expect(engine).toMatch(/DEFT_ENGINE_CMD_JSON/);
  });

  it("engine:invoke checks Node via process.versions.node, not pnpm engine warnings", () => {
    expect(engine).toMatch(/process\.versions\.node/);
    expect(engine).toMatch(/engines\.node/);
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
