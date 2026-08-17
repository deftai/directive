/**
 * Same-session verify:ac cache (#3387).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readVerifyAcSessionCache,
  resolveVerifyAcSessionId,
  writeVerifyAcSessionCache,
} from "./verify-ac-session-cache.js";

const snapshot = {
  ok: true as const,
  code: 0 as const,
  message: "ok",
  commands: [{ command: "true" }],
  runs: [{ command: "true", cwd: ".", exitCode: 0, stdout: "", stderr: "", ok: true, detail: "" }],
  sourceRung: "derived",
  noneStated: true,
  acceptance: { commands: [{ command: "true" }] },
  resolution: "verified-pass",
  resolvedCommandCount: 1,
};

describe("verify-ac session cache (#3387)", () => {
  it("round-trips a green snapshot and ignores a different session", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-vcache-"));
    writeVerifyAcSessionCache({
      projectRoot: root,
      sessionId: "sess-a",
      scopeId: "scope-1",
      productStateHash: "abc",
      snapshot,
    });
    const hit = readVerifyAcSessionCache(root, "sess-a", "scope-1");
    expect(hit?.productStateHash).toBe("abc");
    expect(hit?.snapshot.ok).toBe(true);
    expect(readVerifyAcSessionCache(root, "sess-b", "scope-1")).toBeNull();
    expect(readVerifyAcSessionCache(root, "sess-a", "other")).toBeNull();
  });

  it("resolveVerifyAcSessionId prefers explicit then DEFT_SESSION_ID", () => {
    expect(resolveVerifyAcSessionId({ DEFT_SESSION_ID: "env" }, "explicit")).toBe("explicit");
    expect(resolveVerifyAcSessionId({ DEFT_SESSION_ID: "env" }, null)).toBe("env");
    expect(resolveVerifyAcSessionId({}, null)).toBeNull();
  });
});
