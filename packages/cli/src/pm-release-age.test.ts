/**
 * #5854 (Outcome B): Directive never writes pnpm-workspace.yaml. pnpm's release-age
 * refusal gets pnpm's own recovery; a file pnpm itself changed is listed for review.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type InstallDeps, runInstall, runUpgrade, type UpgradeDeps } from "./bookends.js";
import { EXIT_CODES } from "./constants.js";
import { readProjectInstallState } from "./pin.js";
import { PNPM_WORKSPACE_REVIEW_LINE } from "./plan-present.js";
import { formatPnpmReleaseAgeRecovery, isPnpmReleaseAgeFailure } from "./pm.js";

const TEMPS: string[] = [];
afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

// Strict policy with a stale runtime row: the #5860 heal would have rewritten this file.
const WS =
  "packages:\n  - .\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n" +
  "  - '@deftai/directive-runtime@1.2.3'\n  - '@deftai/directive-runtime@1.2.2'\n" +
  "allowBuilds:\n  esbuild: true\n";

function writeRuntime(root: string, version: string): void {
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version, directive: { contract: 1 } }, null, 2)}\n`,
  );
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
}

function writePin(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
        private: true,
        devDependencies: { "@deftai/directive-runtime": version },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '@deftai/directive-runtime':\n        specifier: ${version}\n        version: ${version}\n`,
  );
}

/** pnpm project; pinned + installed at `pinned` unless null (first install). */
function pnpmProject(pinned: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "pm-release-age-"));
  TEMPS.push(root);
  if (pinned === null) {
    writeFileSync(join(root, "package.json"), '{\n  "name": "t",\n  "private": true\n}\n');
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  } else {
    writePin(root, pinned);
    writeRuntime(root, pinned);
  }
  writeFileSync(join(root, "pnpm-workspace.yaml"), WS, "utf8");
  return root;
}

const readWs = (root: string) => readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => void out.push(t),
      writeErr: (t: string) => void err.push(t),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const okInvoke = (entry: "setup" | "migrate", operation: string) => () => ({
  exitCode: 0,
  stdout: JSON.stringify(
    entry === "setup"
      ? { contract: 1, entry, operation, created: [], modified: [], removed: [], conflicts: [] }
      : { contract: 1, entry, migrated: [], created: [], modified: [], removed: [] },
  ),
  stderr: "",
  spawned: true,
  message: null,
});

/** PM add stub: installs the runtime; optionally changes pnpm-workspace.yaml like pnpm does. */
function okAdd(pnpmWritesWorkspace: boolean): NonNullable<InstallDeps["runPmAdd"]> {
  return ({ projectRoot, version }) => {
    if (pnpmWritesWorkspace) {
      const ws = join(projectRoot, "pnpm-workspace.yaml");
      writeFileSync(
        ws,
        readFileSync(ws, "utf8").replace(
          "'@deftai/directive-runtime@1.2.3'",
          `'@deftai/directive-runtime@1.2.3 || ${version}'`,
        ),
      );
    }
    writePin(projectRoot, version);
    writeRuntime(projectRoot, version);
    return { ok: true as const };
  };
}

const ageFail =
  (code: string): NonNullable<InstallDeps["runPmAdd"]> =>
  ({ version }) => ({
    ok: false as const,
    message: "pnpm add -D --save-exact failed (exit 1)",
    stderr: `${code} No matching version found for @deftai/directive-runtime@${version} that is older than the minimum release age`,
  });

type Op = "install" | "upgrade" | "repair";

function run(op: Op, root: string, add: NonNullable<InstallDeps["runPmAdd"]>) {
  const c = capture();
  const deps: UpgradeDeps = {
    checkPmAvailable: () => ({ ok: true }),
    resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
    runPmAdd: add,
    invokeSetup: okInvoke("setup", op),
    invokeMigrate: okInvoke("migrate", op),
  };
  const state = readProjectInstallState(root);
  let code: number;
  if (op === "install") {
    code = runInstall(
      root,
      state,
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      deps,
    );
  } else if (op === "upgrade") {
    code = runUpgrade(
      root,
      state,
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      deps,
    );
  } else {
    code = runInstall(root, state, ["--repair", "--yes"], "0.0.0-test", c.io, deps);
  }
  return { code, out: c.out(), err: c.err() };
}

/** Project fixture per op. Repair restores the package when `restore` is true. */
function fixture(op: Op, restore = true): string {
  if (op === "install") return pnpmProject(null);
  const root = pnpmProject("1.2.3");
  if (op === "repair" && restore) {
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
  }
  return root;
}

const versionFor = (op: Op) => (op === "repair" ? "1.2.3" : "2.0.0");

describe("pnpm release-age detection and recovery (#5854)", () => {
  it("detects both pnpm release-age codes", () => {
    expect(isPnpmReleaseAgeFailure("ERR_PNPM_NO_MATURE_MATCHING_VERSION blah")).toBe(true);
    expect(isPnpmReleaseAgeFailure("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION blah")).toBe(true);
    expect(isPnpmReleaseAgeFailure("ERR_PNPM_IGNORED_BUILDS")).toBe(false);
    expect(isPnpmReleaseAgeFailure("network error")).toBe(false);
  });

  it("recovery names the exact version and never says Directive edited the file", () => {
    const hint = formatPnpmReleaseAgeRecovery("0.129.10");
    expect(hint).toContain("@deftai/directive-runtime@0.129.10");
    expect(hint).toMatch(/minimumReleaseAgeExclude/);
    expect(hint).toMatch(/pnpm-workspace\.yaml/);
    expect(hint).toMatch(/\|\| 0\.129\.10/);
    expect(hint).toMatch(/Directive does not change it/);
    expect(hint).not.toMatch(/Directive (has )?(updated|edited|changed|wrote|added)/i);
  });
});

describe.each<Op>(["install", "upgrade", "repair"])("%s bookend (#5854 Outcome B)", (op) => {
  it.each([
    "ERR_PNPM_NO_MATURE_MATCHING_VERSION",
    "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
  ])("prints the release-age recovery on %s, exits non-zero, leaves the file byte-identical", (errCode) => {
    const root = fixture(op);
    const before = readWs(root);
    const r = run(op, root, ageFail(errCode));
    expect(r.code).toBe(EXIT_CODES.FAILURE);
    expect(r.err).toContain(errCode);
    expect(r.err).toContain(formatPnpmReleaseAgeRecovery(versionFor(op)));
    expect(readWs(root)).toBe(before);
  });

  it("never writes pnpm-workspace.yaml when pnpm leaves it alone; review list omits it", () => {
    const root = fixture(op);
    const before = readWs(root);
    const r = run(op, root, okAdd(false));
    expect(r.code).toBe(0);
    expect(readWs(root)).toBe(before);
    expect(r.out).not.toContain("pnpm-workspace.yaml");
    expect(r.out).not.toMatch(/minimumReleaseAgeExclude/);
  });

  it("lists pnpm-workspace.yaml under Review and commit when pnpm changed it", () => {
    const root = fixture(op);
    const r = run(op, root, okAdd(true));
    expect(r.code).toBe(0);
    const review = r.out.slice(r.out.indexOf("Review and commit:"));
    expect(r.out).toContain("Review and commit:");
    expect(review).toContain(`  ${PNPM_WORKSPACE_REVIEW_LINE}\n`);
    // Only pnpm's own change is present: Directive did not rewrite or collapse the rows.
    expect(readWs(root)).toContain(`'@deftai/directive-runtime@1.2.3 || ${versionFor(op)}'`);
    expect(readWs(root)).toContain("'@deftai/directive-runtime@1.2.2'");
  });
});

describe("repair with no PM restore (#5854)", () => {
  it("leaves pnpm-workspace.yaml byte-identical and never runs the PM", () => {
    const root = fixture("repair", false);
    const before = readWs(root);
    const r = run("repair", root, () => {
      throw new Error("PM must not run");
    });
    expect(r.code).toBe(0);
    expect(readWs(root)).toBe(before);
    expect(r.out).not.toContain("pnpm-workspace.yaml");
  });

  it("--dry-run upgrade shows no pnpm-workspace.yaml edit and changes nothing", () => {
    const root = fixture("upgrade");
    const before = readWs(root);
    const c = capture();
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--dry-run", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        checkPmAvailable: () => ({ ok: true }),
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(0);
    expect(c.out()).not.toMatch(/minimumReleaseAgeExclude/);
    expect(readWs(root)).toBe(before);
  });
});
