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
import {
  HOST_HOOK_CONFIG_RELS,
  HOST_HOOK_OUTER_DIRS,
} from "@deftai/directive-core/dist/install-health/index.js";
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
    writeFileSync(join(root, "AGENTS.md"), `# Project\n\nUser prose stays.\n`);
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

  describe("agy hook file is entry-owned (#7438)", () => {
    const AGY = ".agents/hooks.json";
    const FOREIGN = {
      mine: { PreToolUse: [{ matcher: "x", hooks: [{ command: "node mine.mjs" }] }] },
    };

    function agyOuters(root: string): string[] {
      return existsSync(join(root, ".agents"))
        ? readdirSync(join(root, ".agents")).filter((n) => /^deft-hook-[a-f0-9]{8}\.mjs$/.test(n))
        : [];
    }

    it("strips only the zzzz-directive entry, keeps foreign hooks, and removes the outer", () => {
      const root = tempRoot();
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(join(root, AGY), `${JSON.stringify(FOREIGN, null, 2)}\n`);
      runSetup({ operation: "install", from: "none", root });
      expect(agyOuters(root)).toHaveLength(1);
      expect(Object.keys(JSON.parse(readFileSync(join(root, AGY), "utf8")))).toContain(
        "zzzz-directive",
      );

      const result = runUninstall({ root });
      expect(JSON.parse(readFileSync(join(root, AGY), "utf8"))).toEqual(FOREIGN);
      expect(agyOuters(root)).toEqual([]);
      expect(result.removed.filter((p) => p.startsWith(".agents/deft-hook-"))).toHaveLength(1);
      expect(result.remaining).toEqual([]);
    });

    it("deletes the file only when Directive's entry was all it held", () => {
      const root = tempRoot();
      runSetup({ operation: "install", from: "none", root });
      expect(existsSync(join(root, AGY))).toBe(true);
      const result = runUninstall({ root });
      expect(existsSync(join(root, AGY))).toBe(false);
      expect(agyOuters(root)).toEqual([]);
      expect(result.removed).toContain(AGY);
    });

    it("keeps a named entry that a user chained another command onto", () => {
      const root = tempRoot();
      mkdirSync(join(root, ".agents"), { recursive: true });
      const chained = {
        "zzzz-directive": {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  command:
                    "node deft-hook-1a2b3c4d.mjs --host agy --event tool.before && node mine.mjs",
                },
              ],
            },
          ],
        },
      };
      const bytes = `${JSON.stringify(chained, null, 2)}\n`;
      writeFileSync(join(root, AGY), bytes);
      runUninstall({ root });
      expect(readFileSync(join(root, AGY), "utf8")).toBe(bytes);
    });

    it("leaves a foreign-only file byte for byte", () => {
      const root = tempRoot();
      runSetup({ operation: "install", from: "none", root });
      const foreignBytes = `${JSON.stringify(FOREIGN)}\n`;
      writeFileSync(join(root, AGY), foreignBytes);
      runUninstall({ root });
      expect(readFileSync(join(root, AGY), "utf8")).toBe(foreignBytes);
    });

    it("works with the entry in grouped and flat SessionStart shapes", () => {
      const cmd = (event: string): string =>
        `node deft-hook-1a2b3c4d.mjs --host agy --event ${event}`;
      const shapes = [
        { SessionStart: [{ hooks: [{ command: cmd("session.start") }] }] },
        { SessionStart: [{ command: cmd("session.start") }] },
      ];
      for (const sessionStart of shapes) {
        const root = tempRoot();
        mkdirSync(join(root, ".agents"), { recursive: true });
        writeFileSync(
          join(root, AGY),
          `${JSON.stringify(
            {
              ...FOREIGN,
              "zzzz-directive": {
                ...sessionStart,
                PreToolUse: [{ matcher: "*", hooks: [{ command: cmd("tool.before") }] }],
              },
            },
            null,
            2,
          )}\n`,
        );
        runUninstall({ root });
        expect(JSON.parse(readFileSync(join(root, AGY), "utf8"))).toEqual(FOREIGN);
      }
    });
  });

  it("prunes empty skill/command/.githooks husks and keeps package.json for the package manager (F-012/F-013, #5999)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "NOTE.txt"), "user-data\n");
    // Foreign sibling skill must survive prune-up.
    mkdirSync(join(root, ".agents", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"), "# user\n");

    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, ".agents", "skills", "deft", "SKILL.md"))).toBe(true);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = runUninstall({ root });
    expect(result.stub).toBe(false);
    expect(existsSync(join(root, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "deft"))).toBe(false);
    expect(existsSync(join(root, ".githooks"))).toBe(false);
    expect(existsSync(join(root, ".claude", "commands"))).toBe(false);
    // The launcher removes the runtime through the package manager, then the manifest.
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(result.removed).not.toContain("package.json");
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

  it("removes v261027 .mjs hook registrations and the .mjs files on all five hosts (AC11.4 / #7438)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const outers = mjsOuters(root);
    expect(outers.length).toBe(5);
    for (const rel of HOST_HOOK_CONFIG_RELS) {
      expect(readFileSync(join(root, rel), "utf8")).toMatch(/deft-hook-[a-f0-9]{8}\.mjs/);
    }

    const result = runUninstall({ root });
    expect(result.remaining).toEqual([]);
    for (const rel of HOST_HOOK_CONFIG_RELS) {
      const body = existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
      expect(body, rel).not.toMatch(/deft-hook-[a-f0-9]{8}\.mjs/);
    }
    expect(mjsOuters(root)).toEqual([]);
  });

  it("removes .mjs outers and registrations when GENERATION.json is missing", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    rmSync(join(root, ".deft", "GENERATION.json"));
    runUninstall({ root });
    expect(mjsOuters(root)).toEqual([]);
    for (const rel of HOST_HOOK_CONFIG_RELS) {
      const body = existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "";
      expect(body, rel).not.toMatch(/deft-hook-[a-f0-9]{8}\.mjs/);
    }
  });

  it("keeps a consumer .mjs beside the outers", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    writeFileSync(join(root, ".cursor", "hooks", "consumer-custom.mjs"), "// mine\n");
    runUninstall({ root });
    expect(existsSync(join(root, ".cursor", "hooks", "consumer-custom.mjs"))).toBe(true);
    expect(mjsOuters(root)).toEqual([]);
  });

  it("keeps a user command added to a Directive hook group", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const rel = join(root, ".claude", "settings.json");
    const cfg = JSON.parse(readFileSync(rel, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    const event = Object.keys(cfg.hooks)[0] as string;
    cfg.hooks[event]?.[0]?.hooks.push({ type: "command", command: "node scripts/mine.mjs" });
    writeFileSync(rel, `${JSON.stringify(cfg, null, 2)}\n`);
    runUninstall({ root });
    const after = readFileSync(rel, "utf8");
    expect(after).toContain("node scripts/mine.mjs");
    expect(after).not.toMatch(/deft-hook-[a-f0-9]{8}\.mjs/);
  });

  it("keeps a Directive command that a user chained another command onto", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    // Codex keeps the string form; Claude's no-shell entry has no shell to chain onto.
    const rel = join(root, ".codex", "hooks.json");
    const body = readFileSync(rel, "utf8");
    const chained = body.replace(
      /("command": "node \.codex\/deft-hook-[a-f0-9]{8}\.mjs[^"]*)"/,
      '$1 && node scripts/check.mjs"',
    );
    expect(chained).not.toBe(body);
    writeFileSync(rel, chained);
    const result = runUninstall({ root });
    expect(readFileSync(rel, "utf8")).toContain("&& node scripts/check.mjs");
    // Still registered by the user's entry: the .mjs files stay and are reported.
    expect(mjsOuters(root)).toHaveLength(5);
    expect(result.remaining).toEqual(expect.arrayContaining([".codex/hooks.json#hooks"]));
  });

  it("keeps the .mjs files and reports them when a registration cannot be removed", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    // Invalid JSON: uninstall cannot strip this config's registration.
    const rel = join(root, ".codex", "hooks.json");
    writeFileSync(rel, `${readFileSync(rel, "utf8")}\n{ broken`);
    const result = runUninstall({ root });
    expect(mjsOuters(root)).toHaveLength(5);
    expect(result.remaining).toEqual(expect.arrayContaining([".codex/hooks.json#hooks"]));
    expect(result.remaining.filter((r) => r.endsWith(".mjs"))).toHaveLength(5);
  });
});

function mjsOuters(root: string): string[] {
  const out: string[] = [];
  for (const dir of HOST_HOOK_OUTER_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (/^deft-hook-[a-f0-9]{8}\.mjs$/.test(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}
