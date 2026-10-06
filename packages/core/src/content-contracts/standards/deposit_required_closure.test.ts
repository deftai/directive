import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageContentPack } from "../../deposit/stage-content-pack.js";
import {
  evaluateDepositClosure,
  loadDepositRequiredDeclaration,
  resolveDeclarationFile,
} from "../../validate-content/deposit-required.js";
import { destContentionItTimeout } from "../../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { readText, repoRoot } from "./_helpers.js";

const staged: string[] = [];

afterEach(() => {
  while (staged.length > 0) {
    const root = staged.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function stageDeclaredPack(root: string): string {
  const declarationPath = resolveDeclarationFile(root);
  expect(declarationPath, "C1 declaration must exist in the source tree").toBeTruthy();
  const tmp = mkdtempSync(join(tmpdir(), "deft-c1-prepack-"));
  staged.push(tmp);
  const pkgDir = join(tmp, "pack");
  mkdirSync(pkgDir, { recursive: true });
  stageContentPack({ repoRoot: root, destDir: pkgDir });
  return pkgDir;
}

describe("declared deposit closure against staged pack (#3601 C1)", () => {
  it(
    "every declared required path exists after running content-package prepack",
    destContentionItTimeout(),
    () => {
      const root = repoRoot();
      const declaration = loadDepositRequiredDeclaration(resolveDeclarationFile(root) as string);
      expect(declaration.paths.length).toBeGreaterThan(0);
      expect(declaration.paths).toContain(".deft/core/docs/subagent-heartbeat.md");
      expect(declaration.paths).toContain(
        ".deft/core/skills/deft-directive-debug/templates/investigation.xbrief.json",
      );
      expect(declaration.paths).toContain(
        ".deft/core/skills/deft-directive-debug/references/outcome-template.md",
      );
      const pack = stageDeclaredPack(root);
      const result = evaluateDepositClosure({ packRoot: pack, paths: declaration.paths });
      expect(result.ok, result.missing.join(", ")).toBe(true);
      expect(existsSync(join(pack, "docs", "subagent-heartbeat.md"))).toBe(true);
      expect(
        existsSync(
          join(pack, "skills", "deft-directive-debug", "templates", "investigation.xbrief.json"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(pack, "skills", "deft-directive-debug", "references", "outcome-template.md"),
        ),
      ).toBe(true);
      const packedHeartbeat = readFileSync(join(pack, "docs", "subagent-heartbeat.md"), "utf8");
      expect(packedHeartbeat).not.toContain("scripts/subagent_monitor.py");
      expect(packedHeartbeat).not.toContain("tests/cli/test_subagent_monitor.py");
      expect(packedHeartbeat).not.toContain("scripts/_safe_subprocess.py");
      expect(packedHeartbeat).not.toContain("Greptile body it has to inspect");
      expect(packedHeartbeat).toContain("does not invoke `gh`");
      expect(packedHeartbeat).toContain("does not inspect Greptile bodies");
    },
  );

  it(
    "fails when a declared file is deleted from the staged pack output",
    destContentionItTimeout(),
    () => {
      const root = repoRoot();
      const declaration = loadDepositRequiredDeclaration(resolveDeclarationFile(root) as string);
      const pack = stageDeclaredPack(root);
      rmSync(join(pack, "main.md"));
      const mutated = evaluateDepositClosure({ packRoot: pack, paths: declaration.paths });
      expect(mutated.ok).toBe(false);
      expect(mutated.missing).toContain(".deft/core/main.md");
    },
  );

  it("consumer template no longer mandates .deft/core/REFERENCES.md and names the pack-slice text form", () => {
    const template = readText("templates/agents-entry.md");
    const skills = template.split("## Skills")[1]?.split("## ")[0] ?? "";
    expect(skills).not.toContain(".deft/core/REFERENCES.md");
    expect(skills).toContain("packs:slice skills list");
    const steer = template.split("## Parent-steer inbox")[1]?.split("## ")[0] ?? "";
    expect(steer).toContain("content/docs/subagent-heartbeat.md");
    expect(steer).toContain(".deft/core/docs");
    expect(skills).toContain("npx deft");
    expect(skills).toContain("--json");
    expect(skills).toContain("node_modules");
  });

  it("subagent-heartbeat lives under content/docs and is not at repo-root docs/ (#4891)", () => {
    const root = repoRoot();
    expect(existsSync(join(root, "content", "docs", "subagent-heartbeat.md"))).toBe(true);
    expect(existsSync(join(root, "docs", "subagent-heartbeat.md"))).toBe(false);
  });

  it("content-tree heartbeat cites use the deposit-reachable path (#4891)", () => {
    const root = join(repoRoot(), "content");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|json)$/.test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("`docs/subagent-heartbeat.md`")) {
          hits.push(relative(root, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    expect(hits, hits.join(", ")).toEqual([]);
    expect(readText("templates/agent-prompt-preamble.md")).toContain(
      "`.deft/core/docs/subagent-heartbeat.md`",
    );
  });
});
