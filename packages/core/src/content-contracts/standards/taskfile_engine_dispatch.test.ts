import { readdirSync, readFileSync } from "node:fs";
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
 *   - `:engine:_ts-build` guards the build behind packages/cli/package.json
 *     AND a root `build` script (#2142) so it builds on a cold framework
 *     checkout (dist/ is gitignored) yet no-ops on a consumer deposit or a
 *     git-vendored stray packages/ tree without a root build script -- and runs
 *     from `{{.USER_WORKING_DIR}}` so an absolute `dir:` cannot double on a
 *     Windows `task -t <abs>` invocation (#2126), and
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

  it("engine.yml still owns the guarded build + global-deft fallback", () => {
    const engine = readTask(ENGINE_FILE);
    expect(engine).toMatch(/_ts-build:/);
    // Guard requires packages/cli/package.json AND a root build script (#2142)
    // so cold framework checkouts still build while stray consumer packages/
    // trees without a root build script no-op instead of ERR_PNPM_NO_SCRIPT.
    expect(engine).toMatch(/\[ -f "\{\{\.DEFT_ROOT\}\}\/packages\/cli\/package\.json" \]/);
    expect(engine).toMatch(/process\.argv\[1\]/);
    expect(engine).toMatch(/readFileSync\(process\.argv\[1\]/);
    expect(engine).toMatch(RAW_PNPM_BUILD);
    expect(engine).toMatch(/invoke:/);
    expect(engine).toMatch(/command -v deft/);
    expect(engine).toMatch(/deft \{\{\.ENGINE_CMD\}\}/);
  });

  it("_ts-build guard no-ops on stray packages/ without root build script (#2142)", () => {
    const engine = readTask(ENGINE_FILE);
    const scriptMatch = engine.match(
      /if \[ -f "\{\{\.DEFT_ROOT\}\}\/packages\/cli\/package\.json" \][\s\S]*?fi/m,
    );
    expect(scriptMatch, "engine _ts-build guard block").not.toBeNull();
    const guardBlock = scriptMatch?.[0] ?? "";
    expect(guardBlock).toMatch(/process\.argv\[1\]/);
    expect(guardBlock).not.toMatch(/\[ -f "\{\{\.DEFT_ROOT\}\}\/packages\/cli\/dist\/bin\.js" \]/);
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
