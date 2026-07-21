import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { evaluateAgentHooks } from "./agent-hooks.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agent-hook-health-"));
  temps.push(root);
  return root;
}

describe("evaluateAgentHooks", () => {
  it("passes when all P0 registrations are structurally healthy", () => {
    const root = project();
    writeAgentHookDeposit(root);

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(0);
    expect(result.message).toContain("Claude, Grok, Cursor, Codex");
    expect(result.message).toContain("runtime trust is user-controlled");
    expect(result.message).toContain("`/hooks`");
    expect(result.message).toContain("compact re-arm deposited");
    expect(result.message).toContain("Codex has no native compact hook");
  });

  it("reports missing registrations separately from git hooks", () => {
    const result = evaluateAgentHooks(project());
    expect(result.code).toBe(1);
    expect(result.message).toContain("agent hook registration INCOMPLETE");
    expect(result.message).toContain(".grok/hooks/deft.json");
    expect(result.message).toContain(".codex/hooks.json");
    expect(result.stream).toBe("stderr");
  });

  it("returns a configuration error for a missing project root", () => {
    const root = project();
    const result = evaluateAgentHooks(join(root, "missing"));
    expect(result.code).toBe(2);
    expect(result.message).toContain("does not exist");
  });
});
