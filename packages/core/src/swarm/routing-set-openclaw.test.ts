import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routingSetMain } from "./routing-set-cli.js";

describe("routing-set OpenClaw provider key (#2875)", () => {
  let dir: string | undefined;
  const prev = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("records routes under openclaw when OPENCLAW=1 without cloud signals", () => {
    dir = mkdtempSync(join(tmpdir(), "routing-set-oc-"));
    // Every host that outranks OpenClaw in resolveDispatchProvider must be
    // cleared, or this asserts nothing. Claude Code sits ABOVE OpenClaw
    // (routing.ts: "Claude Code before OpenClaw/CI", #3134) and was missing
    // here, so an ambient CLAUDECODE — i.e. running `task check` from inside
    // Claude Code, a supported and dogfooded host — failed this test and
    // blocked a release cut (#3492).
    delete process.env.CURSOR_AGENT;
    delete process.env.CURSOR_COMPOSER;
    delete process.env.GROK_BUILD;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;
    delete process.env.DEFT_PROBE_CLAUDE_CODE;
    process.env.OPENCLAW = "1";
    const code = routingSetMain([
      "--project-root",
      dir,
      "--role",
      "leaf-implementation",
      "--harness-default",
    ]);
    expect(code).toBe(0);
    const raw = readFileSync(join(dir, ".deft", "routing.local.json"), "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    // writeModelDecision keys by provider at top level (not under .providers)
    expect(json.openclaw).toBeDefined();
    expect(json["local-unsandboxed"]).toBeUndefined();
  });
});
