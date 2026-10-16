/**
 * Wave4e RED: Autonomicon-like `_deft-run.sh` / `run_deft` hooks must rewrite to OVPR
 * (zero conflicts, remove obsolete helper). Foreign hooks still refuse overwrite.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitHooks } from "./setup-wiring.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-legacy-hooks-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function initGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
}

/** Minimal Autonomicon-like shared helper (sources `run_deft`). */
const LEGACY_DEFT_RUN = `#!/usr/bin/env sh
# Shared deft CLI resolver for .githooks/* (#2067).
run_deft() {
  if command -v deft >/dev/null 2>&1; then
    deft "$@"
    return $?
  fi
  echo "deft hooks: 'deft' not found on PATH." >&2
  exit 1
}
`;

const LEGACY_PRE_COMMIT = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_deft-run.sh"
run_deft verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
`;

const LEGACY_PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_deft-run.sh"
run_deft verify:branch --project-root "$REPO_ROOT" || exit $?
`;

const FOREIGN_PRETTIER_PRE_COMMIT = `#!/usr/bin/env sh
npx prettier --check .
`;

function seedLegacyDeftHooks(root: string): void {
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, ".githooks", "_deft-run.sh"), LEGACY_DEFT_RUN, "utf8");
  writeFileSync(join(root, ".githooks", "pre-commit"), LEGACY_PRE_COMMIT, "utf8");
  writeFileSync(join(root, ".githooks", "pre-push"), LEGACY_PRE_PUSH, "utf8");
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("ensureGitHooks legacy _deft-run / run_deft (wave4e)", () => {
  it("rewrites Autonomicon-like _deft-run hooks to OVPR with zero conflicts", () => {
    const root = tempRoot();
    initGit(root);
    seedLegacyDeftHooks(root);

    const result = ensureGitHooks(root);

    expect(result.conflicts).toEqual([]);
    expect(result.hooksPathActive).toBe(true);

    const preCommit = readFileSync(join(root, ".githooks", "pre-commit"), "utf8");
    const prePush = readFileSync(join(root, ".githooks", "pre-push"), "utf8");
    expect(preCommit).toContain("_directive-run.sh");
    expect(preCommit).toContain("run_directive");
    expect(preCommit).not.toContain("_deft-run.sh");
    expect(preCommit).not.toContain("run_deft");
    expect(prePush).toContain("_directive-run.sh");
    expect(prePush).not.toContain("_deft-run.sh");

    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(true);
    expect(existsSync(join(root, ".githooks", "_deft-run.sh"))).toBe(false);
  });

  it("refuses to overwrite a foreign pre-commit (prettier-only)", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "pre-commit"), FOREIGN_PRETTIER_PRE_COMMIT, "utf8");

    const result = ensureGitHooks(root);

    expect(result.conflicts.some((c) => c.includes(".githooks/pre-commit"))).toBe(true);
    expect(readFileSync(join(root, ".githooks", "pre-commit"), "utf8")).toBe(
      FOREIGN_PRETTIER_PRE_COMMIT,
    );
  });

  it("refuses to overwrite a hook that only mentions .deft/core in an ignore path", () => {
    const root = tempRoot();
    initGit(root);
    mkdirSync(join(root, ".githooks"), { recursive: true });
    const custom = `#!/usr/bin/env sh
# ignore path mention alone is not Directive ownership
rg --files -g '!.deft/core/**' | xargs eslint
`;
    writeFileSync(join(root, ".githooks", "pre-commit"), custom, "utf8");

    const result = ensureGitHooks(root);

    expect(result.conflicts.some((c) => c.includes(".githooks/pre-commit"))).toBe(true);
    expect(readFileSync(join(root, ".githooks", "pre-commit"), "utf8")).toBe(custom);
  });

  it("keeps _deft-run.sh when an unmanaged hook still sources it", () => {
    const root = tempRoot();
    initGit(root);
    seedLegacyDeftHooks(root);
    writeFileSync(
      join(root, ".githooks", "commit-msg"),
      `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_deft-run.sh"
run_deft verify:commit-msg --project-root "$REPO_ROOT" || exit $?
`,
      "utf8",
    );

    const result = ensureGitHooks(root);

    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(true);
    expect(existsSync(join(root, ".githooks", "_deft-run.sh"))).toBe(true);
    expect(readFileSync(join(root, ".githooks", "pre-commit"), "utf8")).toContain(
      "_directive-run.sh",
    );
    expect(readFileSync(join(root, ".githooks", "commit-msg"), "utf8")).toContain("_deft-run.sh");
  });
});
