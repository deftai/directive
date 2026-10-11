/**
 * AC14.25 worktree PM install unit tests.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectWorktreePm,
  installWorktreePackages,
  worktreeHasRuntimePin,
} from "./worktree-pm-install.js";

function fixture(pkg: Record<string, unknown>, lock?: "npm" | "pnpm"): string {
  const root = mkdtempSync(join(tmpdir(), "wt-pm-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
  if (lock === "npm") writeFileSync(join(root, "package-lock.json"), "{}\n");
  if (lock === "pnpm") writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  return root;
}

describe("worktree-pm-install (AC14.25)", () => {
  it("detects npm vs pnpm from lockfiles", () => {
    expect(detectWorktreePm(fixture({ name: "x" }, "npm"))).toBe("npm");
    expect(detectWorktreePm(fixture({ name: "x" }, "pnpm"))).toBe("pnpm");
  });

  it("worktreeHasRuntimePin reads exact runtime pin", () => {
    const root = fixture({
      name: "x",
      devDependencies: { "@deftai/directive-runtime": "1.2.3" },
    });
    expect(worktreeHasRuntimePin(root)).toBe(true);
    expect(worktreeHasRuntimePin(fixture({ name: "y" }))).toBe(false);
  });

  it("skips when package.json absent", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-pm-empty-"));
    const r = installWorktreePackages(root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skipped).toBe(true);
  });

  it("runs pm install via seam and requires runtime node_modules when pinned", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const calls: string[][] = [];
    const r = installWorktreePackages(root, {
      runner: (cmd, args, cwd) => {
        calls.push([cmd, ...args, cwd]);
        mkdirSync(join(root, "node_modules", "@deftai", "directive-runtime"), {
          recursive: true,
        });
        writeFileSync(
          join(root, "node_modules", "@deftai", "directive-runtime", "package.json"),
          JSON.stringify({ name: "@deftai/directive-runtime", version: "1.2.3" }),
        );
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![0]).toBe("npm");
  });

  it("fails closed when PM install exits nonzero for a pinned worktree", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const r = installWorktreePackages(root, {
      runner: () => ({ status: 1, stdout: "", stderr: "boom" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/boom|failed/i);
  });

  it("fails closed when install succeeds but runtime package is missing", () => {
    const root = fixture(
      {
        name: "configured",
        devDependencies: { "@deftai/directive-runtime": "1.2.3" },
      },
      "npm",
    );
    const r = installWorktreePackages(root, {
      runner: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/directive-runtime is missing/i);
  });

  it("refuses Yarn lockfiles", () => {
    const root = fixture({ name: "x" });
    writeFileSync(join(root, "yarn.lock"), "");
    const r = installWorktreePackages(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Yarn|Bun/i);
  });
});
