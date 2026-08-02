import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InitDepositIo } from "./constants.js";
import {
  CONSUMER_SKILL_DISCOVERY_INVENTORY,
  isThinSkillPointer,
  writeAgentsSkillsFromInventory,
  writeMultiHostSkillDiscovery,
} from "./skill-discovery-deposit.js";
import {
  DEFAULT_HOST_SKILL_DISCOVERY_POLICY,
  type HostSkillDiscoveryPolicy,
  hostSkillRelativePath,
  listSkillDiscoveryHosts,
} from "./skill-discovery-hosts.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-skill-discovery-deposit-"));
  temps.push(root);
  return root;
}

function captureIo(): { io: InitDepositIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      printf: (msg: string) => {
        lines.push(msg);
      },
    },
  };
}

function writeProjectDefinition(root: string, hostSkillDiscovery: Record<string, boolean>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ plan: { policy: { hostSkillDiscovery } } }, null, 2)}\n`,
    "utf8",
  );
}

describe("multi-host skill discovery deposit (#75 residual)", () => {
  it("inventory entries are all thin pointers (non-inlining)", () => {
    expect(CONSUMER_SKILL_DISCOVERY_INVENTORY.length).toBeGreaterThan(0);
    for (const skill of CONSUMER_SKILL_DISCOVERY_INVENTORY) {
      expect(isThinSkillPointer(skill.content), skill.dir).toBe(true);
      expect(skill.content).toContain("Read and follow:");
      expect(skill.content).toContain(".deft/core/");
      expect(skill.content.toLowerCase()).not.toContain("## phase");
      expect(skill.content.length).toBeLessThan(1200);
    }
  });

  it("rejects fat full skill bodies as thin pointers", () => {
    const fat = `---
name: fat
description: not a pointer
---

## Phase 1
${"x".repeat(2000)}
`;
    expect(isThinSkillPointer(fat)).toBe(false);
  });

  it("deposits the path matrix for all enabled hosts", () => {
    const root = project();
    const { io } = captureIo();
    const result = writeMultiHostSkillDiscovery(root, io, {
      policy: { ...DEFAULT_HOST_SKILL_DISCOVERY_POLICY },
    });

    expect(result.changed).toBe(true);
    expect(result.hostsSkipped).toEqual([]);
    expect(result.hostsTouched.sort()).toEqual([...listSkillDiscoveryHosts()].sort());

    for (const host of listSkillDiscoveryHosts()) {
      for (const skill of CONSUMER_SKILL_DISCOVERY_INVENTORY) {
        const rel = hostSkillRelativePath(host, skill.dir);
        const abs = join(root, ...rel.split("/"));
        expect(existsSync(abs), rel).toBe(true);
        const body = readFileSync(abs, "utf8");
        expect(body).toBe(skill.content);
        expect(isThinSkillPointer(body)).toBe(true);
      }
    }

    // Canonical .agents inventory remains a separate deposit surface.
    expect(existsSync(join(root, ".agents/skills/deft/SKILL.md"))).toBe(false);
  });

  it("mirrors the same inventory as .agents/skills", () => {
    const root = project();
    const { io } = captureIo();
    writeAgentsSkillsFromInventory(root, io);
    writeMultiHostSkillDiscovery(root, io);

    const agentsBody = readFileSync(
      join(root, ".agents/skills/deft-directive-build/SKILL.md"),
      "utf8",
    );
    for (const host of listSkillDiscoveryHosts()) {
      const hostBody = readFileSync(
        join(root, ...hostSkillRelativePath(host, "deft-directive-build").split("/")),
        "utf8",
      );
      expect(hostBody).toBe(agentsBody);
    }
  });

  it("is idempotent on re-run", () => {
    const root = project();
    const first = captureIo();
    const r1 = writeMultiHostSkillDiscovery(root, first.io);
    expect(r1.changed).toBe(true);

    const second = captureIo();
    const r2 = writeMultiHostSkillDiscovery(root, second.io);
    expect(r2.changed).toBe(false);
    expect(r2.changedPaths).toEqual([]);
    expect(second.lines.some((l) => l.includes("already current"))).toBe(true);
  });

  it("rewrites managed thin pointers when content drifts", () => {
    const root = project();
    const { io } = captureIo();
    writeMultiHostSkillDiscovery(root, io);

    const rel = hostSkillRelativePath("claude", "deft");
    const abs = join(root, ...rel.split("/"));
    // Thin but stale (still managed shape) — should rewrite.
    writeFileSync(
      abs,
      `---
name: deft
description: stale managed pointer
---

Read and follow: .deft/core/SKILL.md
`,
      "utf8",
    );

    const again = captureIo();
    const result = writeMultiHostSkillDiscovery(root, again.io);
    expect(result.changed).toBe(true);
    expect(result.changedPaths).toContain(rel);
    expect(readFileSync(abs, "utf8")).toBe(
      CONSUMER_SKILL_DISCOVERY_INVENTORY.find((s) => s.dir === "deft")?.content,
    );
  });

  it("preserves consumer-authored host skills with the same name", () => {
    const root = project();
    const rel = hostSkillRelativePath("claude", "deft");
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(root, ".claude/skills/deft"), { recursive: true });
    const consumerBody = `# Consumer custom skill\n\n## Phase 1\nDo not overwrite me.\n`;
    writeFileSync(abs, consumerBody, "utf8");

    const { io, lines } = captureIo();
    const result = writeMultiHostSkillDiscovery(root, io, {
      policy: {
        ...DEFAULT_HOST_SKILL_DISCOVERY_POLICY,
        cursor: false,
        codex: false,
        github: false,
      },
    });
    expect(readFileSync(abs, "utf8")).toBe(consumerBody);
    expect(result.changedPaths).not.toContain(rel);
    expect(lines.some((l) => l.includes("preserving consumer skill"))).toBe(true);
  });

  it("skips opted-out hosts", () => {
    const root = project();
    writeProjectDefinition(root, { claude: false, github: false });
    const { io } = captureIo();
    const result = writeMultiHostSkillDiscovery(root, io);

    expect(result.hostsSkipped.sort()).toEqual(["claude", "github"]);
    expect(existsSync(join(root, ".claude/skills/deft/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".github/skills/deft/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".cursor/skills/deft/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".codex/skills/deft/SKILL.md"))).toBe(true);
  });

  it("honors explicit policy override without PROJECT-DEFINITION", () => {
    const root = project();
    const policy: HostSkillDiscoveryPolicy = {
      claude: true,
      cursor: false,
      codex: false,
      github: false,
    };
    const { io } = captureIo();
    const result = writeMultiHostSkillDiscovery(root, io, { policy });
    expect(result.hostsTouched).toEqual(["claude"]);
    expect(result.hostsSkipped.sort()).toEqual(["codex", "cursor", "github"]);
  });

  it("refuses to deposit non-thin inventory entries", () => {
    const root = project();
    const { io } = captureIo();
    expect(() =>
      writeMultiHostSkillDiscovery(root, io, {
        inventory: [
          {
            dir: "evil",
            content: `---
name: evil
description: fat
---

## Phase 1
${"body ".repeat(500)}
`,
          },
        ],
      }),
    ).toThrow(/not a thin pointer/);
  });
});
