import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatWelcomeCommand, normalizeTaskPrefix, runDefaultMode } from "./default-mode.js";

describe("default-mode helpers", () => {
  it("formatWelcomeCommand with task prefix", () => {
    expect(normalizeTaskPrefix("task")).toBe("task:");
    expect(formatWelcomeCommand(["triage:welcome", "--onboard"], "task")).toContain(
      "task task:triage:welcome",
    );
  });

  it("runDefaultMode with task prefix nudge", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-tp-"));
    const lines: string[] = [];
    runDefaultMode(root, { output: (l) => lines.push(l), writeHistory: false, taskPrefix: "deft" });
    expect(lines.some((l) => l.includes("task deft:"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("runDefaultMode invokes cache self-heal before summary", () => {
    const root = mkdtempSync(join(tmpdir(), "welcome-heal-"));
    let healed = false;
    runDefaultMode(root, {
      output: () => {},
      writeHistory: false,
      selfHealFn: () => {
        healed = true;
      },
    });
    expect(healed).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
