import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitHostCommandFiles, HOST_COMMAND_LAYOUTS } from "../slash/emitters.js";
import { isThinWrapperMarkdown } from "../slash/generator.js";
import { PRODUCT_COMMAND_COUNT } from "../slash/product-set.js";
import { isInstallerManagedPath } from "./hygiene.js";
import { slashCommandManagedExactPaths, writeSlashCommandDeposit } from "./slash-deposit.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slash-deposit-"));
  temps.push(root);
  return root;
}

function writeProjectDefinition(root: string, hostSlashCommands: Record<string, boolean>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ plan: { policy: { hostSlashCommands } } }, null, 2)}\n`,
    "utf8",
  );
}

describe("writeSlashCommandDeposit (#3054)", () => {
  it("deposits all four emitter hosts by default (multi-host product default)", () => {
    const root = project();
    const lines: string[] = [];
    const result = writeSlashCommandDeposit(root, { printf: (t) => lines.push(t) });

    expect(result.depositedHosts).toEqual(["claude", "cursor", "grok", "codex"]);
    expect(result.skippedHosts).toEqual([]);
    expect(result.writtenPaths.length).toBe(PRODUCT_COMMAND_COUNT * 4);
    expect(result.changed).toBe(true);

    for (const host of result.depositedHosts) {
      const layout = HOST_COMMAND_LAYOUTS[host];
      const sample = join(root, layout.relativeDir, "deft-continue.md");
      expect(existsSync(sample)).toBe(true);
      const body = readFileSync(sample, "utf8");
      expect(isThinWrapperMarkdown(body, "resilience/continue-here.md")).toBe(true);
    }
    expect(lines.some((l) => l.includes("Installed Directive slash commands"))).toBe(true);
  });

  it("is idempotent on second pass (no duplicate pile-up)", () => {
    const root = project();
    const first = writeSlashCommandDeposit(root);
    expect(first.changed).toBe(true);
    expect(first.writtenPaths.length).toBeGreaterThan(0);

    const second = writeSlashCommandDeposit(root);
    expect(second.changed).toBe(false);
    expect(second.writtenPaths).toEqual([]);
    expect(second.removedPaths).toEqual([]);
  });

  it("rewrites drifted managed thin wrappers without creating extras", () => {
    const root = project();
    writeSlashCommandDeposit(root);
    const target = join(root, ".claude/commands/deft-continue.md");
    // Still a thin wrapper (managed) but drifted description.
    writeFileSync(
      target,
      "---\ndescription: stale managed\n---\n\nRead and follow `resilience/continue-here.md` (content-relative; deposit under `.deft/core/` when installed).\nHonor `$ARGUMENTS` as documented for this command.\nDo not inline the strategy, skill, or commands.md body here.\n",
      "utf8",
    );

    const result = writeSlashCommandDeposit(root);
    expect(result.writtenPaths).toContain(".claude/commands/deft-continue.md");
    const expected = emitHostCommandFiles("claude").find((f) => f.filename === "deft-continue.md");
    expect(readFileSync(target, "utf8")).toBe(expected?.contents);
    expect(emitHostCommandFiles("claude")).toHaveLength(PRODUCT_COMMAND_COUNT);
  });

  it("does not overwrite non-thin consumer customizations at product paths", () => {
    const root = project();
    writeSlashCommandDeposit(root);
    const target = join(root, ".claude/commands/deft-continue.md");
    writeFileSync(target, "# my custom continue command\n", "utf8");

    const result = writeSlashCommandDeposit(root);
    expect(result.writtenPaths).not.toContain(".claude/commands/deft-continue.md");
    expect(result.preservedCustomPaths).toContain(".claude/commands/deft-continue.md");
    expect(readFileSync(target, "utf8")).toBe("# my custom continue command\n");
  });

  it("skips opted-out host without breaking other hosts", () => {
    const root = project();
    writeProjectDefinition(root, { claude: false });
    const result = writeSlashCommandDeposit(root);

    expect(result.skippedHosts).toContain("claude");
    expect(result.depositedHosts).toEqual(["cursor", "grok", "codex"]);
    expect(existsSync(join(root, ".claude/commands/deft-continue.md"))).toBe(false);
    expect(existsSync(join(root, ".cursor/commands/deft-continue.md"))).toBe(true);
    expect(existsSync(join(root, ".grok/commands/deft-continue.md"))).toBe(true);
    expect(existsSync(join(root, ".codex/prompts/deft-continue.md"))).toBe(true);
  });

  it("removes managed thin wrappers on opt-out but leaves user customizations", () => {
    const root = project();
    writeSlashCommandDeposit(root);
    expect(existsSync(join(root, ".claude/commands/deft-continue.md"))).toBe(true);

    const customPath = join(root, ".claude/commands/user-custom.md");
    mkdirSync(join(root, ".claude/commands"), { recursive: true });
    writeFileSync(customPath, "# user owned\n", "utf8");

    const customizedManaged = join(root, ".claude/commands/deft-checkpoint.md");
    writeFileSync(customizedManaged, "# heavily customized non-thin wrapper\n", "utf8");

    writeProjectDefinition(root, { claude: false });
    const lines: string[] = [];
    const result = writeSlashCommandDeposit(root, { printf: (t) => lines.push(t) });

    expect(result.skippedHosts).toContain("claude");
    expect(result.removedPaths).toContain(".claude/commands/deft-continue.md");
    expect(existsSync(join(root, ".claude/commands/deft-continue.md"))).toBe(false);
    // Non-thin customization of a product filename is left alone.
    expect(existsSync(customizedManaged)).toBe(true);
    expect(readFileSync(customizedManaged, "utf8")).toBe("# heavily customized non-thin wrapper\n");
    // Unrelated user file left alone.
    expect(existsSync(customPath)).toBe(true);
    expect(lines.some((l) => l.includes("hostSlashCommands opt-out"))).toBe(true);
    // Other hosts still deposited / current.
    expect(existsSync(join(root, ".cursor/commands/deft-continue.md"))).toBe(true);
  });

  it("exposes product paths as installer-managed exacts (L8 prefer commit)", () => {
    const exacts = slashCommandManagedExactPaths();
    expect(exacts).toContain(".claude/commands/deft-continue.md");
    expect(exacts).toContain(".codex/prompts/deft-continue.md");
    expect(exacts).toHaveLength(PRODUCT_COMMAND_COUNT * 4);
    for (const path of exacts) {
      expect(isInstallerManagedPath(path)).toBe(true);
    }
    // Consumer custom file under same dir is NOT installer-managed.
    expect(isInstallerManagedPath(".claude/commands/user-custom.md")).toBe(false);
    // Hook JSON paths remain distinct and still managed.
    expect(isInstallerManagedPath(".claude/settings.json")).toBe(true);
  });

  it("does not conflict with agent hook paths", () => {
    const root = project();
    writeSlashCommandDeposit(root);
    // Slash deposit must not create or require hook JSON files.
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor/hooks.json"))).toBe(false);
  });
});
