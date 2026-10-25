/**
 * #5797 Locked: PM-owned allowBuilds; IGNORED_BUILDS surfaces pnpm-shaped recovery;
 * Directive never writes allowBuilds placeholders.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall, runUpgrade } from "./bookends.js";
import { EXIT_CODES } from "./constants.js";
import { type ProjectInstallState, readProjectInstallState } from "./pin.js";
import {
  buildPmExactAddArgs,
  formatPnpmIgnoredBuildsRecovery,
  isPnpmIgnoredBuildsFailure,
  PNPM_IGNORED_BUILDS_PLACEHOLDER,
} from "./pm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPS: string[] = [];

function tempProject(name = "ignored-builds"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        out.push(t);
      },
      writeErr: (t: string) => {
        err.push(t);
      },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function stateFor(root: string): ProjectInstallState {
  return readProjectInstallState(root);
}

function pinExact(root: string, version: string): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  pkg.devDependencies = { "@deftai/directive-runtime": version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(nm, { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify(
      { name: "@deftai/directive-runtime", version, directive: { contract: 1 } },
      null,
      2,
    )}\n`,
  );
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("pnpm ignored-builds recovery (#5797)", () => {
  it("detects ERR_PNPM_IGNORED_BUILDS in stderr/message blobs", () => {
    expect(isPnpmIgnoredBuildsFailure("ERR_PNPM_IGNORED_BUILDS: ignored build scripts")).toBe(
      true,
    );
    expect(isPnpmIgnoredBuildsFailure("something else")).toBe(false);
  });

  it("recovery hint is PM-shaped and never instructs the interactive placeholder", () => {
    const hint = formatPnpmIgnoredBuildsRecovery();
    expect(hint).toMatch(/ERR_PNPM_IGNORED_BUILDS/);
    expect(hint).toMatch(/pnpm approve-builds/);
    expect(hint).toMatch(/allowBuilds/);
    expect(hint).toMatch(/Directive does not write allowBuilds/i);
    expect(hint).toMatch(/\btrue\b/);
    expect(hint).toMatch(/\bfalse\b/);
    expect(hint).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
    expect(hint).not.toMatch(/set this to true or false/i);
  });

  it("install bookend surfaces the recovery on IGNORED_BUILDS PM add failure", () => {
    const root = tempProject("ib-install");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        runPmAdd: () => ({
          ok: false as const,
          message: "pnpm add -D --save-exact failed (exit 1)",
          stderr:
            "ERR_PNPM_IGNORED_BUILDS Failed to add @deftai/directive-runtime: ignored build scripts",
        }),
      },
    );
    expect(code).toBe(EXIT_CODES.FAILURE);
    const err = c.err();
    expect(err).toMatch(/ERR_PNPM_IGNORED_BUILDS/);
    expect(err).toMatch(/pnpm approve-builds/);
    expect(err).toMatch(/Directive does not write allowBuilds/i);
    expect(err).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
  });

  it("upgrade bookend surfaces the recovery on IGNORED_BUILDS PM add failure", () => {
    const root = tempProject("ib-upgrade");
    pinExact(root, "1.2.3");
    const c = capture();
    const code = runUpgrade(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.4"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: () => ({
          ok: false as const,
          message: "pnpm add -D --save-exact failed (exit 1)",
          stderr: "ERR_PNPM_IGNORED_BUILDS ignored build scripts for @deftai/directive-runtime",
        }),
      },
    );
    expect(code).toBe(EXIT_CODES.FAILURE);
    const err = c.err();
    expect(err).toMatch(/ERR_PNPM_IGNORED_BUILDS/);
    expect(err).toMatch(/pnpm approve-builds/);
    expect(err).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
  });
});

describe("allowBuilds ownership invariant (#5797)", () => {
  it("exact-add argv keeps --ignore-scripts (avoid IGNORED_BUILDS on pin add)", () => {
    expect(buildPmExactAddArgs("pnpm", "1.2.3", tempProject("ib-args"))).toContain(
      "--ignore-scripts",
    );
    expect(buildPmExactAddArgs("npm", "1.2.3", tempProject("ib-args-npm"))).toContain(
      "--ignore-scripts",
    );
  });

  it("product writers never invent allowBuilds keys or instruct the pnpm placeholder", () => {
    const productRels = ["pm.ts", "bookends.ts", "age-exclude.ts"];
    for (const rel of productRels) {
      const src = readFileSync(join(HERE, rel), "utf8");
      // No code path that writes an allowBuilds map entry into workspace YAML.
      expect(src, rel).not.toMatch(/writeFileSync\([^;]*allowBuilds/s);
      expect(src, rel).not.toMatch(/allowBuilds:\s*\n\s*['"`][^'"`]+['"`]\s*:\s*['"`]?set this/i);
      // Strip comments + the named constant that exists only to forbid instructing the placeholder.
      const withoutNoise = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(
          /export const PNPM_IGNORED_BUILDS_PLACEHOLDER\s*=\s*["'`][^"'`]+["'`];?/,
          "",
        );
      expect(withoutNoise, rel).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
      expect(withoutNoise, rel).not.toMatch(
        /['"`]allowBuilds['"`]\s*[:=].{0,40}(true|false|set this)/s,
      );
    }
    // Operator-facing recovery must never instruct writing the interactive placeholder.
    expect(formatPnpmIgnoredBuildsRecovery()).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
  });

  it("UPGRADING.md does not instruct writing the pnpm interactive placeholder", () => {
    const docs = readFileSync(join(HERE, "..", "..", "..", "content", "UPGRADING.md"), "utf8");
    expect(docs).not.toContain(PNPM_IGNORED_BUILDS_PLACEHOLDER);
    expect(docs).toMatch(/allowBuilds/);
    expect(docs).toMatch(/PM-owned|package-manager.?owned|pnpm.?owned/i);
  });
});
