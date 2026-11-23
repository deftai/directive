import { describe, expect, it } from "vitest";
import { isHostEnvKey } from "./clean-host-env.js";

describe("clean-host-env (#6298)", () => {
  it("matches host markers and AI_AGENT only", () => {
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CURSOR_TRACE_ID",
      "GROK_X",
      "DEFT_Y",
      "OPENCLAW_Z",
      "WARP_W",
      "AI_AGENT",
      "CODEX_SANDBOX",
      "CODEX_CI",
      "OPENAI_CODEX",
    ]) {
      expect(isHostEnvKey(key)).toBe(true);
    }
    for (const key of ["PATH", "HOME", "AI_AGENTS", "MY_CLAUDE"]) {
      expect(isHostEnvKey(key)).toBe(false);
    }
  });
});
