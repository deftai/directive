import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

const PRUNED_CURRENT = [
  /scripts\/triage_help\.py/,
  /python -m scripts\.triage_help/,
  /uv run python run\b/,
  /from triage_help import intercept_help/,
] as const;

const HISTORICAL = /retired|vacuous|gone|dropped|no generator|python-purge|is gone|no \.py files/i;

function currentProcedureHits(source: string, relativePath: string): string[] {
  const hits: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (HISTORICAL.test(line)) continue;
    for (const pattern of PRUNED_CURRENT) {
      if (pattern.test(line)) {
        hits.push(`${relativePath}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe("maintainer instructor surfaces (#4091)", () => {
  it("does not name removed Python helpers as a current procedure", () => {
    const files: Array<[string, string]> = [
      ["CONTRIBUTING.md", readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8")],
      ["Taskfile.yml", readFileSync(join(repoRoot, "Taskfile.yml"), "utf8")],
      [
        "packages/core/src/triage/help/index.ts",
        readFileSync(join(repoRoot, "packages/core/src/triage/help/index.ts"), "utf8"),
      ],
    ];
    const tasksDir = join(repoRoot, "tasks");
    for (const name of readdirSync(tasksDir).sort()) {
      if (!name.endsWith(".yml")) continue;
      const rel = `tasks/${name}`;
      files.push([rel, readFileSync(join(tasksDir, name), "utf8")]);
    }

    const hits = files.flatMap(([rel, src]) => currentProcedureHits(src, rel));
    expect(hits).toEqual([]);
  });

  it("CONTRIBUTING recipe names TypeScript dispatch, help, and engine:invoke", () => {
    const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
    for (const token of [
      "CLI_MODULE_VERBS",
      "CORE_MODULE_VERBS",
      "VERB_ALIASES",
      "SUBCOMMAND_ROUTES",
      "TRIAGE_ACTION_ALIAS_SUBCOMMANDS",
      "interceptHelp",
      "packages/core/src/triage/help/registry-data.ts",
      "packages/cli/src/dispatch.test.ts",
      "verify:forward-coverage",
      "engine:invoke",
      "packages/cli/dist",
      "packages/core/src/scm/call.ts",
      "task verify:scm-boundary",
      "containedWrite",
    ]) {
      expect(contributing).toContain(token);
    }
    expect(contributing).toContain("### Slow tests (#975)");
    expect(contributing).toContain("\u2297 Regenerate help from Python");
  });
});
