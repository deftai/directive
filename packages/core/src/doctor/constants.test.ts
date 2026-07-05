import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANONICAL_UPGRADE_COMMAND, PNPM_UPGRADE_COMMAND, upgradeCommandFor } from "./constants.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("doctor constants (#2003)", () => {
  it("CANONICAL_UPGRADE_COMMAND matches agents-entry.md narrative", () => {
    const agentsEntry = readFileSync(join(repoRoot, "content/templates/agents-entry.md"), "utf8");
    expect(agentsEntry).toContain(CANONICAL_UPGRADE_COMMAND);
    expect(CANONICAL_UPGRADE_COMMAND).toBe("npm i -g @deftai/directive@latest");
  });

  it("exposes a pnpm upgrade one-liner and a PM-aware renderer (#2197)", () => {
    expect(PNPM_UPGRADE_COMMAND).toBe("pnpm add -g @deftai/directive@latest");
    expect(upgradeCommandFor()).toBe(CANONICAL_UPGRADE_COMMAND);
    expect(upgradeCommandFor("npm")).toBe(CANONICAL_UPGRADE_COMMAND);
    expect(upgradeCommandFor("pnpm")).toBe(PNPM_UPGRADE_COMMAND);
  });
});
