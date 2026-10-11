/**
 * Wave 2g — repository uninstall entry (R11 / AC11.5).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";
import { runUninstall } from "./uninstall.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wave2g-rt-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
  return root;
}

describe("runUninstall (AC11.5 / AC11.7)", () => {
  it("removes owned wiring from a setup install while preserving xbrief", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "NOTE.txt"), "user-data\n");
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\nUser prose stays.\n`,
    );
    runSetup({ operation: "install", from: "none", root });

    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(true);

    const result = runUninstall({ root });
    expect(result.stub).toBe(false);
    expect(result.preserved).toEqual(expect.arrayContaining(["xbrief"]));
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(false);
    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "NOTE.txt"))).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("User prose stays.");
    expect(agents).not.toContain("deft:managed-section");
  });

  it("strips host hook registrations without deleting user entries", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: "echo user-before" }],
          },
        },
        null,
        2,
      )}\n`,
    );
    runSetup({ operation: "install", from: "none", root });
    const mid = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8")) as {
      hooks: { sessionStart: unknown[] };
    };
    expect(mid.hooks.sessionStart.length).toBeGreaterThan(1);

    runUninstall({ root });
    const after = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8")) as {
      hooks?: { sessionStart?: Array<{ command?: string }> };
    };
    expect(after.hooks?.sessionStart?.some((e) => e.command === "echo user-before")).toBe(true);
    expect(
      after.hooks?.sessionStart?.some((e) =>
        (e.command ?? "").includes("directive-runtime/dist/hook-bin.js"),
      ),
    ).toBeFalsy();
  });
});
