import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routingSetMain } from "./routing-set-cli.js";

describe("routing-set OpenClaw provider key (#2875)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("records routes under openclaw when OPENCLAW=1 without cloud signals", () => {
    dir = mkdtempSync(join(tmpdir(), "routing-set-oc-"));
    // Constructed environment, not `process.env` minus a denylist. The denylist
    // form asserted nothing on any host that set a signal outranking OpenClaw,
    // and rotted twice as new signals landed: CLAUDECODE (#3492), then
    // DEFT_HAS_CLAUDE_AGENT / DEFT_AGENT_RUNTIME (#3494). `routingSetMain`
    // takes the same injected-env seam `resolveDispatchProvider` has, so this
    // test states exactly what it means and no future host var can invalidate
    // it.
    const environ: NodeJS.ProcessEnv = { OPENCLAW: "1" };
    const code = routingSetMain(
      ["--project-root", dir, "--role", "leaf-implementation", "--harness-default"],
      environ,
    );
    expect(code).toBe(0);
    const raw = readFileSync(join(dir, ".deft", "routing.local.json"), "utf8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    // writeModelDecision keys by provider at top level (not under .providers)
    expect(json.openclaw).toBeDefined();
    expect(json["local-unsandboxed"]).toBeUndefined();
  });
});
