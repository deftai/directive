import { describe, expect, it } from "vitest";
import { classifyHookPayload, parseHookStdin } from "../classify/index.js";
import { fixtureCaseById, fixtureCasesFor, HOOK_FIXTURE_CASES } from "./cases.js";

describe("HOOK_FIXTURE_CASES corpus (#2950 Phase B)", () => {
  it("covers Cursor × win32/posix × Write/ApplyPatch/Task", () => {
    for (const tool of ["Write", "ApplyPatch", "Task"] as const) {
      for (const os of ["win32", "posix"] as const) {
        expect(fixtureCasesFor({ host: "cursor", os, tool }).length).toBeGreaterThan(0);
      }
    }
  });

  it("expands Write and ApplyPatch depth on win32 and posix (Phase B)", () => {
    for (const tool of ["Write", "ApplyPatch"] as const) {
      for (const os of ["win32", "posix"] as const) {
        expect(
          fixtureCasesFor({ host: "cursor", os, tool }).length,
          `cursor/${os}/${tool}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("includes StrReplace direct-write cells on both OSes", () => {
    for (const os of ["win32", "posix"] as const) {
      expect(fixtureCasesFor({ host: "cursor", os, tool: "StrReplace" }).length).toBeGreaterThan(0);
    }
  });

  it("fixtureCaseById resolves known Phase B cases", () => {
    expect(fixtureCaseById("cursor-posix-write-filePath-camel")?.tool).toBe("Write");
    expect(fixtureCaseById("cursor-win32-applypatch-freeform-add")?.tool).toBe("ApplyPatch");
    expect(fixtureCaseById("missing-id")).toBeUndefined();
  });

  it("each case matches pure classify", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(24);
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
