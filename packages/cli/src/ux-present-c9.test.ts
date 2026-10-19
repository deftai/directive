/**
 * §C9 Examples A–F / F-002 UX-PRESENT — default human plan/report shape.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "./bookends.js";
import { readProjectInstallState, type ProjectInstallState } from "./pin.js";

const TEMPS: string[] = [];

function tempProject(name = "ux-c9"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
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
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), "@deftai/directive-runtime": version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeInstalledRuntime(root: string, version: string): void {
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
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
}

function writeNpmLockRecordingPin(root: string, version: string): void {
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": {
            name: "t",
            devDependencies: { "@deftai/directive-runtime": version },
          },
          "node_modules/@deftai/directive-runtime": { version },
        },
      },
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

describe("§C9 UX-PRESENT (F-002)", () => {
  it("Example A: first-install dry-run is human-shaped (no keyed dump)", () => {
    const root = tempProject("ux-c9-a");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toMatch(/Set up Deft Directive/);
    expect(text).toMatch(/Project:/);
    expect(text).toMatch(/Package manager:/);
    expect(text).toMatch(/Directive version:/);
    expect(text).toMatch(/If you approve, Directive will:/i);
    // wave 4g: default plan is bullets; exact PM argv at -v (AC5.1 evidence)
    expect(text).not.toMatch(/Install command:/);
    expect(text).not.toMatch(/Package manager will run:/);
    expect(text).toMatch(/add Directive 1\.2\.3/);
    expect(text).not.toMatch(/Installation skips package lifecycle scripts/);
    expect(text).not.toMatch(/^\s*operation:/m);
    expect(text).not.toMatch(/created=\[/);
    expect(text).not.toMatch(/Plan:/);
  });

  it("Example A + -v: includes verbose keyed plan", () => {
    const root = tempProject("ux-c9-a-v");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "-v", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toMatch(/Set up Deft Directive/);
    expect(text).toMatch(/Plan \(verbose\):|operation: install/);
    expect(text).toMatch(/install-script policy:/i);
  });

  it("Example E: configured + --yes (no --repair) → stderr shape, exit 2", () => {
    const root = tempProject("ux-c9-e");
    pinExact(root, "1.2.3");
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    const text = c.err();
    expect(text).toMatch(/already configured at version 1\.2\.3/);
    expect(text).toMatch(/directive install --repair --yes/);
    expect(text).toMatch(/No project files were changed/);
  });

  it("cancel path still emits Cancelled message", () => {
    const root = tempProject("ux-c9-cancel");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: () => false,
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toContain("Cancelled. No project files were changed.");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("Example B: healthy repair dry-run — unchanged, no reinstall", () => {
    const root = tempProject("ux-c9-b");
    const version = "1.2.3";
    pinExact(root, version);
    writeNpmLockRecordingPin(root, version);
    writeInstalledRuntime(root, version);
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--repair", "--dry-run"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toMatch(/Repair Directive/);
    expect(text).toMatch(/unchanged/);
    expect(text).toMatch(/No reinstall is needed/);
    expect(text).not.toMatch(/created=\[/);
  });
});
