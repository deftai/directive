import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";

// #5841: every Taskfile gate that reaches engine:invoke must name a verb the
// runtime dispatch table registers, so a gate cannot land without its verb.
// Scans root Taskfile.yml plus tasks/*.yml. Fail closed: an ENGINE_CMD this
// parser cannot read, or whose first token is templated, is a failure, not a skip.

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

interface EngineCmd {
  where: string;
  verb: string;
}

function taskfiles(): string[] {
  const tasks = readdirSync(join(REPO_ROOT, "tasks"))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `tasks/${name}`);
  return ["Taskfile.yml", ...tasks];
}

function collectEngineCmds(): { cmds: EngineCmd[]; unparseable: string[] } {
  const cmds: EngineCmd[] = [];
  const unparseable: string[] = [];
  for (const rel of taskfiles()) {
    const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const key = /^(\s*)ENGINE_CMD:\s*(.*)$/.exec(line);
      if (key === null) return;
      const where = `${rel}:${index + 1}`;
      const rest = (key[2] ?? "").trim();
      let value: string | null = null;
      const quoted = /^(['"])(.*)\1\s*(#.*)?$/.exec(rest);
      if (quoted !== null) {
        value = quoted[2] ?? "";
      } else if (/^[>|][-+]?$/.test(rest)) {
        const indent = (key[1] ?? "").length;
        const next = lines.slice(index + 1).find((l) => l.trim() !== "");
        if (next !== undefined && next.length - next.trimStart().length > indent) {
          value = next.trim();
        }
      }
      const verb = value?.trim().split(/\s+/)[0] ?? "";
      if (verb === "" || verb.includes("{{")) {
        unparseable.push(`${where}: ${line.trim()}`);
        return;
      }
      cmds.push({ where, verb });
    });
  }
  return { cmds, unparseable };
}

describe("ENGINE_CMD verbs resolve in runtime dispatch (#5841)", () => {
  const { cmds, unparseable } = collectEngineCmds();

  it("parses every ENGINE_CMD in Taskfile.yml and tasks/*.yml", () => {
    expect(unparseable).toEqual([]);
    expect(cmds.length).toBeGreaterThan(0);
  });

  it("every ENGINE_CMD first token is a registered verb or alias", () => {
    const missing = cmds
      .filter((cmd) => resolveCanonicalVerb(cmd.verb) === null)
      .map((cmd) => `${cmd.where}: ${cmd.verb}`);
    expect(missing).toEqual([]);
  });

  it("covers the docs:capability-map:check gate verb", () => {
    expect(cmds.some((cmd) => cmd.verb === "capability-map")).toBe(true);
  });
});
