import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockBody,
  cachingKeyOnLine,
  iterTaskBlocks,
  nonCommentLines,
  taskYamlFiles,
} from "./_taskfile-helpers.js";

// Regression guard for #2302 item 2 (cache:fetch-all arg passthrough).
//
// The passthrough itself is NOT reproducible on master: go-task forwards
// unquoted `{{.CLI_ARGS}}` to `node "$bin" {{.ENGINE_CMD}}` preserving flag
// order and values across space, equals, and reversed forms. What made the
// report plausible is a coverage gap: the existing caching guard
// (taskfile_caching.test.ts) only inspects tasks whose body contains
// `uv run python`. After the #2022 engine:invoke migration, CLI_ARGS-forwarding
// tasks (cache.yml, ...) route through `task: :engine:invoke` with an
// `ENGINE_CMD: '<verb> {{.CLI_ARGS}}'` var and no longer mention `uv run
// python`, so a stray `sources:` / `generates:` on such a task would be
// SILENTLY UNGUARDED -- and a go-task fingerprint short-circuit is exactly what
// drops user-facing recovery flags (--force, --no-refresh-closed, ...).
//
// This guard is engine-agnostic: any task that forwards `{{.CLI_ARGS}}`
// (whether via `uv run python`, `ENGINE_CMD`, or a raw command) MUST NOT
// declare `sources:` / `generates:`.

interface Offender {
  readonly file: string;
  readonly task: string;
  readonly keys: string[];
}

function findCachingOffenders(text: string): Array<{ task: string; keys: string[] }> {
  const offenders: Array<{ task: string; keys: string[] }> = [];
  for (const { name, start, end } of iterTaskBlocks(text)) {
    const body = blockBody(text, start, end);
    const lines = nonCommentLines(body);
    if (!lines.join("\n").includes("{{.CLI_ARGS}}")) continue;
    const keys: string[] = [];
    for (const line of lines) {
      const key = cachingKeyOnLine(line);
      if (key) keys.push(key);
    }
    if (keys.length) offenders.push({ task: name, keys });
  }
  return offenders;
}

describe("taskfile CLI_ARGS passthrough guard (#2302)", () => {
  it("no CLI_ARGS-forwarding task in any tasks/*.yml declares sources/generates", () => {
    const offenders: Offender[] = [];
    for (const file of taskYamlFiles()) {
      const text = readFileSync(file, { encoding: "utf8" });
      for (const o of findCachingOffenders(text)) {
        offenders.push({ file: basename(file), task: o.task, keys: o.keys });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("cache:fetch-all forwards CLI_ARGS via engine:invoke and declares no caching", () => {
    const cacheFile = taskYamlFiles().find((f) => basename(f) === "cache.yml");
    expect(cacheFile).toBeDefined();
    const text = readFileSync(cacheFile as string, { encoding: "utf8" });
    const fetchAll = iterTaskBlocks(text).find((b) => b.name === "fetch-all");
    expect(fetchAll).toBeDefined();
    const body = blockBody(
      text,
      (fetchAll as { start: number }).start,
      (fetchAll as { end: number }).end,
    );
    const nonComment = nonCommentLines(body).join("\n");
    // The task genuinely forwards user flags and does so unquoted.
    expect(nonComment).toContain("{{.CLI_ARGS}}");
    expect(nonComment).toContain("cache fetch-all {{.CLI_ARGS}}");
    // ...and carries no fingerprint short-circuit that would drop them.
    expect(findCachingOffenders(text).map((o) => o.task)).not.toContain("fetch-all");
  });
});
