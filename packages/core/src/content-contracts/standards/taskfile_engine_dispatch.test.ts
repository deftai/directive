import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

/**
 * Consumer-safe engine-dispatch contract for the task surface (#2126).
 *
 * v0.65.0 shipped a half-finished #2022 Phase 3 flatten: dozens of task
 * fragments reached an UNGUARDED build or a direct vendored-CLI call. On a
 * vendored consumer install DEFT_ROOT is `.deft/core` = `@deftai/directive-
 * content`, which has NO `build` script and ships NO `packages/`/`dist/`, so any
 * consumer/operator task that reached one of those fragments died -- first with
 * `[ERR_PNPM_NO_SCRIPT] Missing script: build`, then (once guarded) with
 * `MODULE_NOT_FOUND` on the absent dist/bin.js. That broke `task check` for every
 * consumer refreshing to v0.65.0.
 *
 * The unguarded build appeared under several spellings that a name-scoped fix
 * would miss: a local `_ts-build`, a local `_ensure-ts` (`pnpm --dir DEFT_ROOT
 * run build`), and a `deps: [:ts:build]` on the unconditional maintainer build
 * primitive. The canonical guarded pattern lives in tasks/engine.yml:
 *   - `:engine:_ts-build` guards the build via engine-invoke.cjs
 *     `is-buildable-source` (#2142 / #3324): source checkouts still build;
 *     a consumer-deposit marker forces a no-op even when stray packages/ +
 *     a root build script are present. Runs from `{{.USER_WORKING_DIR}}` so
 *     an absolute `dir:` cannot double on a Windows `task -t <abs>`
 *     invocation (#2126), and
 *   - `:engine:invoke` runs the vendored bin.js when present, else falls back to
 *     the globally-installed `deft` command.
 *
 * Build PRIMITIVES are allowlisted: engine.yml owns the guard; ts.yml owns the
 * maintainer monorepo `ts:build`/`ts:test`/`ts:lint`; core.yml owns maintainer
 * packaging. Every OTHER task-verb must depend on the guarded `:engine:_ts-build`
 * and dispatch through `:engine:invoke`.
 */

// Build primitives + maintainer packaging -- allowed to run a real `pnpm build`.
const BUILD_PRIMITIVE_FILES = new Set(["engine.yml", "ts.yml", "core.yml"]);
// Only engine.yml may define/own a local build task + the direct dist/bin.js call.
const ENGINE_FILE = "engine.yml";
// Only core.yml may depend on the unconditional :ts:build primitive (packaging).
const TS_BUILD_DEP_ALLOWED = new Set(["core.yml"]);

function taskYmlNames(): string[] {
  return readdirSync(join(repoRoot(), "tasks"))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function readTask(name: string): string {
  return readFileSync(join(repoRoot(), "tasks", name), { encoding: "utf8" });
}

function nonCommentLines(text: string): string[] {
  return text.split("\n").filter((l) => !l.trim().startsWith("#"));
}

const DIRECT_NODE_CALL = /-\s*node\s+"\{\{\.[A-Z_]+\}\}\/packages\/cli\/dist\/bin\.js"/;
const LOCAL_BUILD_DEF = /^ {2}(_ts-build|_ensure-ts):/m;
const RAW_PNPM_BUILD = /pnpm\s+(?:--dir\s+"[^"]*"\s+|-C\s+"[^"]*"\s+)?run build/;
// The unconditional :ts:build primitive appears as a dep in THREE spellings that
// all break consumers (`:ts:build` = unguarded `pnpm run build` at DEFT_ROOT):
//   1. bare long form   `- task: :ts:build`
//   2. quoted long form `- task: ":ts:build"`   (packs.yml)
//   3. inline array      `deps: [":ts:build"]`   (swarm/triage/pr/session/issue)
// A name-scoped fix that only caught (1) left ~45 stragglers hidden (#2126, Greptile P1).
const TS_BUILD_DEP = /(?:-\s*task:\s*"?:ts:build\b)|(?:deps:\s*\[[^\]]*":ts:build"[^\]]*\])/;
const BARE_TS_BUILD_DEP = /^\s*-\s*(_ts-build|_ensure-ts)\s*$/m;

describe("task surface routes through the guarded :engine:* pattern (#2126)", () => {
  const names = taskYmlNames();

  for (const name of names) {
    describe(`tasks/${name}`, () => {
      const text = readTask(name);
      const body = nonCommentLines(text).join("\n");

      it("has no direct dist/bin.js node call (use :engine:invoke)", () => {
        if (name === ENGINE_FILE) return;
        expect(DIRECT_NODE_CALL.test(body)).toBe(false);
      });

      it("defines no local build task (use :engine:_ts-build)", () => {
        if (name === ENGINE_FILE) return;
        expect(LOCAL_BUILD_DEF.test(text)).toBe(false);
      });

      it("carries no bare local-build dependency", () => {
        expect(BARE_TS_BUILD_DEP.test(body)).toBe(false);
      });

      it("runs no unguarded `pnpm run build` (build primitives excepted)", () => {
        if (BUILD_PRIMITIVE_FILES.has(name)) return;
        expect(RAW_PNPM_BUILD.test(body)).toBe(false);
      });

      it("does not depend on the unconditional :ts:build (use :engine:_ts-build)", () => {
        if (TS_BUILD_DEP_ALLOWED.has(name)) return;
        expect(TS_BUILD_DEP.test(body)).toBe(false);
      });
    });
  }

  it("engine.yml still owns the guarded build + runtime invoke dispatch", () => {
    const engine = readTask(ENGINE_FILE);
    expect(engine).toMatch(/_ts-build:/);
    // #3324: buildability lives in engine-invoke.cjs (deposit marker forces
    // false). Cold source still builds; marked deposits never self-build.
    expect(engine).toMatch(/engine-invoke\.cjs" is-buildable-source/);
    expect(engine).toMatch(/deftConsumerDeposit/);
    expect(engine).toMatch(/process\.argv\[1\]/);
    expect(engine).toMatch(/readFileSync\(process\.argv\[1\]/);
    expect(engine).toMatch(/pm-run:/);
    expect(engine).toMatch(/engine-pm-run\.cjs/);
    expect(engine).not.toMatch(/execFileSync\(cmd,args,\{cwd:root,stdio:'inherit',shell:true/);
    expect(engine).toMatch(/invoke:/);
    expect(engine).toMatch(/command -v deft/);
    expect(engine).toMatch(/command -v directive/);
    expect(engine).toMatch(/DEFT_ENGINE_CMD_JSON/);
    expect(engine).toMatch(/engine-invoke\.cjs/);
    expect(engine).not.toMatch(/deft \{\{\.ENGINE_CMD\}\}/);
    // #2409: runtime verbs may fall back to global deft; build-gated verbs fail closed.
    expect(engine).toMatch(/CLI artifact missing/);
    expect(engine).toMatch(/is_runtime_verb/);
    expect(engine).toMatch(/process\.versions\.node/);
  });

  it("treats command transport as one-hop so nested Task commands win (#2554)", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "deft-engine-invoke-"));
    const helper = join(repoRoot(), "tasks", "engine-invoke.cjs");
    const recorder = join(fixtureDir, "record-child.cjs");
    const nestedTask = join(fixtureDir, "nested-task.cjs");
    const nestedOut = join(fixtureDir, "nested-out.json");
    const outerOut = join(fixtureDir, "outer-out.json");

    try {
      // File sinks: engine-invoke uses stdio inherit (#2554), so spawnSync cannot
      // capture child stdout through the helper — record payloads on disk instead.
      writeFileSync(
        recorder,
        `const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TEST_ENGINE_NESTED_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  jsonTransport: process.env.DEFT_ENGINE_CMD_JSON ?? null,
  legacyTransport: process.env.DEFT_ENGINE_CMD ?? null,
}));\n`,
        "utf8",
      );
      writeFileSync(
        nestedTask,
        `const { spawnSync } = require("node:child_process");
const { writeFileSync, readFileSync } = require("node:fs");
const env = { ...process.env };
// Mirrors go-task's inherited-environment precedence: set the nested command
// only when no stale parent transport value is present.
env.DEFT_ENGINE_CMD_JSON ??= JSON.stringify("verify:tools --nested");
const nested = spawnSync(process.execPath, [process.env.TEST_ENGINE_HELPER, "vendored", process.env.TEST_ENGINE_RECORDER], {
  encoding: "utf8",
  env,
});
if (nested.stderr) process.stderr.write(nested.stderr);
if (nested.status !== 0) process.exit(nested.status ?? 1);
writeFileSync(process.env.TEST_ENGINE_OUTER_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  jsonTransport: process.env.DEFT_ENGINE_CMD_JSON ?? null,
  legacyTransport: process.env.DEFT_ENGINE_CMD ?? null,
  nested: JSON.parse(readFileSync(process.env.TEST_ENGINE_NESTED_OUT, "utf8")),
}));\n`,
        "utf8",
      );

      const result = spawnSync(process.execPath, [helper, "vendored", nestedTask], {
        encoding: "utf8",
        env: {
          ...process.env,
          DEFT_ENGINE_CMD_JSON: JSON.stringify('check:consumer --flag "value with spaces"'),
          DEFT_ENGINE_CMD: "legacy-stale-command",
          TEST_ENGINE_HELPER: helper,
          TEST_ENGINE_RECORDER: recorder,
          TEST_ENGINE_NESTED_OUT: nestedOut,
          TEST_ENGINE_OUTER_OUT: outerOut,
        },
      });

      expect(result.stderr ?? "").toBe("");
      expect(result.status).toBe(0);
      const payload = JSON.parse(readFileSync(outerOut, "utf8")) as {
        argv: string[];
        jsonTransport: string | null;
        legacyTransport: string | null;
        nested: {
          argv: string[];
          jsonTransport: string | null;
          legacyTransport: string | null;
        };
      };
      expect(payload.argv).toEqual(["check:consumer", "--flag", "value with spaces"]);
      expect(payload.jsonTransport).toBeNull();
      expect(payload.legacyTransport).toBeNull();
      expect(payload.nested.argv).toEqual(["verify:tools", "--nested"]);
      expect(payload.nested.jsonTransport).toBeNull();
      expect(payload.nested.legacyTransport).toBeNull();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("pm-run / _ts-build hasCmd is cross-platform (no Unix sh/command -v) (#2415)", () => {
    const helper = readFileSync(join(repoRoot(), "tasks", "engine-pm-run.cjs"), {
      encoding: "utf8",
    });
    // Windows-native Task often has no `sh` on PATH; #2411's probe never saw Corepack.cmd.
    expect(helper).not.toMatch(/execFileSync\('sh',\s*\['-c',\s*'command -v/);
    // Direct --version first (POSIX); shell:true fallback resolves .cmd/.exe on win32.
    // #2563: probes go through spawnOpts() with windowsHide (not bare {stdio:'ignore'}).
    expect(helper).toMatch(/execFn\(name,\s*\["--version"\],\s*spawnOpts\(\{\}\)/);
    expect(helper).toMatch(/execFn\(name,\s*\["--version"\],\s*spawnOpts\(\{ shell: true \}\)/);
    expect(helper).toMatch(/windowsHide:\s*true/);
    // #2765: execution path must not use shell:true.
    expect(helper).toMatch(/shell:\s*false/);
    expect(helper).not.toMatch(/stdio:\s*['"]inherit['"][\s\S]*shell:\s*true/);
    // #2411 step order preserved: bare pnpm → corepack@pin → corepack → fail.
    const pnpmIdx = helper.indexOf('cmd: "pnpm"');
    const pinIdx = helper.search(/pnpm@\$\{input\.semver\}/);
    const bareCorepackIdx = helper.lastIndexOf('args: ["pnpm", "run", input.script]');
    expect(pnpmIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeGreaterThan(pnpmIdx);
    expect(bareCorepackIdx).toBeGreaterThan(pinIdx);
    expect(existsSync(join(repoRoot(), "tasks", "engine-pm-run.cjs"))).toBe(true);
    expect(existsSync(join(repoRoot(), "tasks", "engine-pm-run.test.cjs"))).toBe(true);
  });

  it("_ts-build skips rebuild when dist is warm (#2563)", () => {
    const engine = readTask(ENGINE_FILE);
    expect(engine).toMatch(/ts-build-fresh\.cjs/);
    expect(engine).toMatch(/DEFT_FORCE_TS_BUILD/);
    expect(engine).toMatch(/DEFT_SKIP_TS_BUILD/);
    expect(existsSync(join(repoRoot(), "tasks", "ts-build-fresh.cjs"))).toBe(true);
  });

  it("_ts-build guard no-ops on stray packages/ without root build script (#2142 / #3324)", () => {
    const engine = readTask(ENGINE_FILE);
    const scriptMatch = engine.match(
      /if node "\{\{\.TASKFILE_DIR\}\}\/engine-invoke\.cjs" is-buildable-source "\{\{\.DEFT_ROOT\}\}"; then[\s\S]*?fi/m,
    );
    expect(scriptMatch, "engine _ts-build is-buildable-source guard").not.toBeNull();
    const guardBlock = scriptMatch?.[0] ?? "";
    expect(guardBlock).toMatch(/ts-build-fresh\.cjs/);
    expect(engine).toMatch(/engine-pm-run\.cjs/);
    expect(guardBlock).not.toMatch(/\[ -f "\{\{\.DEFT_ROOT\}\}\/packages\/cli\/dist\/bin\.js" \]/);
  });

  it("_ts-build ends with a trailing no-op after the outer if/fi (#3381)", () => {
    const engine = readTask(ENGINE_FILE);
    const tsBuild = engine.match(/  _ts-build:\n[\s\S]*?(?=\n  [a-zA-Z_])/);
    expect(tsBuild, "engine _ts-build task").not.toBeNull();
    const body = tsBuild?.[0] ?? "";
    expect(body).toMatch(
      /fi\s*\n\s*: # no-op -- go-task <3\.52\.0 treats untaken last if\/fi as exit 1 \(#3381\)/,
    );
    expect(body).toMatch(/is-buildable-source/);
    expect(body).not.toMatch(/is-buildable-source \|\| exit 0/);
  });

  it("ts.yml routes monorepo scripts through Corepack-aware :engine:pm-run (#2410)", () => {
    const ts = readTask("ts.yml");
    expect(ts).toMatch(/:engine:pm-run/);
    expect(ts).not.toMatch(/^\s*-\s*pnpm run/m);
  });

  it("TS_BUILD_DEP catches all three :ts:build spellings (regex self-test, #2126 Greptile P1)", () => {
    // Guards against the first-pass regex that only matched the bare long form
    // and silently let ~45 inline-array / quoted stragglers through.
    expect(TS_BUILD_DEP.test("      - task: :ts:build")).toBe(true);
    expect(TS_BUILD_DEP.test('      - task: ":ts:build"')).toBe(true);
    expect(TS_BUILD_DEP.test('    deps: [":ts:build"]')).toBe(true);
    // Must NOT false-positive on the guarded engine build.
    expect(TS_BUILD_DEP.test('    deps: [":engine:_ts-build"]')).toBe(false);
    expect(TS_BUILD_DEP.test("      - task: :engine:_ts-build")).toBe(false);
  });

  it("root Taskfile.yml carries no straggler build/dispatch fragments", () => {
    const root = readFileSync(join(repoRoot(), "Taskfile.yml"), { encoding: "utf8" });
    const body = nonCommentLines(root).join("\n");
    // No direct vendored-CLI call and no reference to the deleted verify:_ts-build.
    expect(DIRECT_NODE_CALL.test(body)).toBe(false);
    expect(/verify:_ts-build/.test(body)).toBe(false);
  });

  it("the known straggler files were migrated (regression floor)", () => {
    // The #2126 maintainer comment + the wider audit named these families; assert
    // none re-introduces an unguarded build or a direct dist/bin.js call.
    const named = [
      "verify.yml",
      "vbrief.yml",
      "commit.yml",
      "prd.yml",
      "project.yml",
      "spec.yml",
      "scope.yml",
      "policy.yml",
      "scm.yml",
      "cache.yml",
      "codebase.yml",
      "issue.yml",
      "reconcile.yml",
      "umbrella.yml",
      // Second wave: the inline-array `deps: [":ts:build"]` + quoted long-form
      // `- task: ":ts:build"` families the first-pass regex missed (#2126, Greptile P1).
      "swarm.yml",
      "packs.yml",
      "session.yml",
      "pr.yml",
      "triage-actions.yml",
      "triage-queue.yml",
      "triage-bulk.yml",
      "triage-bootstrap.yml",
      "triage-classify.yml",
      "triage-reconcile.yml",
      "triage-scope.yml",
      "triage-scope-drift.yml",
      "triage-smoketest.yml",
      "triage-subscribe.yml",
      "triage-summary.yml",
      "triage-welcome.yml",
    ];
    for (const name of named) {
      expect(names, `${name} should exist`).toContain(name);
      const body = nonCommentLines(readTask(name)).join("\n");
      expect(DIRECT_NODE_CALL.test(body), `${name} has a direct node call`).toBe(false);
      expect(RAW_PNPM_BUILD.test(body), `${name} has raw pnpm build`).toBe(false);
      expect(TS_BUILD_DEP.test(body), `${name} deps on :ts:build`).toBe(false);
      expect(LOCAL_BUILD_DEF.test(readTask(name)), `${name} defines local build`).toBe(false);
    }
  });
});
