import { describe, expect, it } from "vitest";
import {
  classifyHookPayload,
  exactLifecycleCommandVerb,
  parseHookStdin,
  resolveHookHostIdentity,
  rewriteExactLifecycleCommand,
} from "../classify/index.js";
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

  it("covers #3611 identity, rewrite, conflict, missing, malformed, and ambiguity cases", () => {
    const cases = HOOK_FIXTURE_CASES.filter((c) => c.regression.includes("#3611"));
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(
      [...new Set(cases.map((c) => c.expected.hostIdentity?.status).filter(Boolean))].sort(),
    ).toEqual(["conflict", "invalid", "missing", "ok"]);
    expect(cases.some((c) => c.expected.lifecycle?.resultKind === "rewrite")).toBe(true);
    expect(cases.some((c) => c.expected.lifecycle?.resultKind === "conflict")).toBe(true);
    expect(cases.some((c) => c.expected.lifecycle?.verb === null)).toBe(true);
  });

  it("covers #3873 host-env identity in both resolved and absent states", () => {
    const cases = HOOK_FIXTURE_CASES.filter((c) => c.regression.includes("#3873"));
    expect(
      [...new Set(cases.map((c) => c.expected.hostIdentity?.status).filter(Boolean))].sort(),
    ).toEqual(["missing", "ok"]);
  });

  it("matches #3611 host identity and lifecycle rewrite expectations", () => {
    for (const c of HOOK_FIXTURE_CASES) {
      const identityExpected = c.expected.hostIdentity;
      if (identityExpected !== undefined) {
        // #3873: resolve against the case's own environment, never the ambient
        // one, so a host-env provider case is reproducible off its host.
        const identity = resolveHookHostIdentity(c.host, c.payload, c.environ ?? {});
        expect(identity.status, c.id).toBe(identityExpected.status);
        expect(identity.sessionId, c.id).toBe(identityExpected.sessionId);
      }

      const lifecycleExpected = c.expected.lifecycle;
      if (lifecycleExpected === undefined) continue;
      expect(exactLifecycleCommandVerb(c.payload), c.id).toBe(lifecycleExpected.verb);
      const result = rewriteExactLifecycleCommand(c.payload, lifecycleExpected.requestedSessionId);
      if (lifecycleExpected.resultKind === null) {
        expect(result, c.id).toBeNull();
        continue;
      }
      expect(result, c.id).toMatchObject({ kind: lifecycleExpected.resultKind });
      if (lifecycleExpected.resultKind === "rewrite" && result?.kind === "rewrite") {
        expect(result.rewrittenCommand, c.id).toBe(lifecycleExpected.rewrittenCommand);
        expect(result.updatedInput, c.id).toEqual(lifecycleExpected.updatedInput);
      }
    }
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
