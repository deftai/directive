/**
 * Wave 2g / 3e — repository uninstall entry (R11 / AC11.5 / F-012 / F-013).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function listEmptyDirs(root: string, rel = ""): string[] {
  const abs = rel ? join(root, rel) : root;
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = join(root, childRel);
    try {
      const entries = readdirSync(childAbs);
      if (entries.length === 0) out.push(childRel);
      else out.push(...listEmptyDirs(root, childRel));
    } catch {
      /* file */
    }
  }
  return out;
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

  it("prunes empty skill/command/.githooks husks and sole-author package.json (F-012/F-013)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "NOTE.txt"), "user-data\n");
    // Foreign sibling skill must survive prune-up.
    mkdirSync(join(root, ".agents", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"), "# user\n");

    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, ".agents", "skills", "deft", "SKILL.md"))).toBe(true);

    const result = runUninstall({ root });
    expect(result.stub).toBe(false);
    expect(existsSync(join(root, ".agents", "skills", "deft"))).toBe(false);
    expect(existsSync(join(root, ".githooks"))).toBe(false);
    expect(existsSync(join(root, ".claude", "commands"))).toBe(false);
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "NOTE.txt"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"))).toBe(true);

    const emptyHostDirs = listEmptyDirs(root).filter(
      (p) =>
        p.startsWith(".agents") ||
        p.startsWith(".claude") ||
        p.startsWith(".cursor") ||
        p.startsWith(".codex") ||
        p.startsWith(".grok") ||
        p.startsWith(".github") ||
        p.startsWith(".githooks") ||
        p.startsWith(".deft"),
    );
    expect(emptyHostDirs).toEqual([]);
  });
});
