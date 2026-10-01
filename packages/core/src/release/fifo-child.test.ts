import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const itPosix = it.skipIf(process.platform === "win32");

describe("FIFO CHANGELOG bounded child (#4318)", () => {
  itPosix(
    "classified Step 5 refusal with zero CI on skip-ci, dry-run, and real CI paths",
    () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const child = join(here, "fifo-child.ts");
      const tsx = join(here, "..", "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
      for (const mode of ["skip-ci", "dry-run", "ci"] as const) {
        const root = mkdtempSync(join(tmpdir(), "rel-fifo-"));
        roots.push(root);
        execFileSync("mkfifo", [join(root, "CHANGELOG.md")]);
        writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n");
        const result = spawnSync(process.execPath, [tsx, child, root, mode], {
          encoding: "utf8",
          timeout: 30 * 1000,
          env: { ...process.env },
        });
        expect(result.error, `${mode} timed out or failed to spawn`).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).toContain("rc=1");
        expect(result.stderr).toMatch(/\[5\/13\].*FAIL/);
      }
    },
    60_000,
  );
});
