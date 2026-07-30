import { describe, expect, it } from "vitest";
import { classifyHookPayload, parseHookStdin } from "../classify/index.js";
import { fixtureCasesFor, HOOK_FIXTURE_CASES } from "./cases.js";

describe("HOOK_FIXTURE_CASES corpus (#2950)", () => {
  it("covers Cursor × win32/posix × Write/ApplyPatch/Task", () => {
    for (const tool of ["Write", "ApplyPatch", "Task"] as const) {
      for (const os of ["win32", "posix"] as const) {
        expect(fixtureCasesFor({ host: "cursor", os, tool }).length).toBeGreaterThan(0);
      }
    }
  });

  it("each case matches pure classify", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(12);
    for (const c of HOOK_FIXTURE_CASES) {
      let payload = c.payload;
      if (c.raw !== undefined) {
        const parsed = parseHookStdin(c.raw);
        if (c.expected.stdinEmpty) expect(parsed.context.stdinEmpty, c.id).toBe(true);
        if (c.expected.parseFailed) expect(parsed.context.parseFailed, c.id).toBe(true);
        payload = parsed.payload;
      }
      const result = classifyHookPayload({ host: c.host, payload });
      expect(result.toolName, c.id).toBe(c.expected.toolName);
      expect(result.writeIntent, c.id).toBe(c.expected.writeIntent);
      expect(result.writeTargetPath, c.id).toBe(c.expected.writeTargetPath);
    }
  });
});
