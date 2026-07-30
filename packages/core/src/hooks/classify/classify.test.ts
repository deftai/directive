import { describe, expect, it } from "vitest";
import { fixtureCasesFor, HOOK_FIXTURE_CASES } from "../fixtures/index.js";
import { classifyHookPayload } from "./classify.js";
import { hookWriteTargetPath } from "./paths.js";
import { parseHookStdin } from "./stdin.js";
import { hookToolName } from "./tool-name.js";

describe("classifyHookPayload (pure, #2950)", () => {
  it("classifies Cursor Write without process I/O", () => {
    const result = classifyHookPayload({
      host: "cursor",
      payload: {
        tool_name: "Write",
        tool_input: { contents: "x", path: "src/a.ts" },
      },
    });
    expect(result).toMatchObject({
      toolName: "Write",
      writeIntent: "direct-write",
      writeTargetPath: "src/a.ts",
      paths: ["src/a.ts"],
    });
  });

  it("infers Cursor tool name when omitted (#2628)", () => {
    expect(
      classifyHookPayload({
        host: "cursor",
        payload: { arguments: { contents: "x", path: "a.py" } },
      }).toolName,
    ).toBe("Write");
  });

  it("classifies Task as spawn intent", () => {
    expect(
      classifyHookPayload({
        host: "cursor",
        payload: { tool_name: "Task", tool_input: { prompt: "go" } },
      }).writeIntent,
    ).toBe("spawn");
  });

  it("parseHookStdin synthesizes free-form ApplyPatch (#2738)", () => {
    const freeForm = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/a.txt",
      "+probe",
      "*** End Patch",
    ].join("\n");
    const parsed = parseHookStdin(freeForm);
    expect(parsed.context).toEqual({});
    expect(classifyHookPayload({ host: "cursor", payload: parsed.payload })).toMatchObject({
      toolName: "ApplyPatch",
      writeIntent: "direct-write",
      writeTargetPath: "xbrief/proposed/a.txt",
    });
  });

  it("parseHookStdin tags empty and bad JSON", () => {
    expect(parseHookStdin("")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parseHookStdin("{bad")).toEqual({ payload: {}, context: { parseFailed: true } });
  });
});

describe("shared fixture corpus (#2950 Phase B)", () => {
  it("includes Cursor × win32/posix × Write/ApplyPatch/Task coverage", () => {
    const need = [
      ["cursor", "posix", "Write"],
      ["cursor", "win32", "Write"],
      ["cursor", "posix", "ApplyPatch"],
      ["cursor", "win32", "ApplyPatch"],
      ["cursor", "posix", "Task"],
      ["cursor", "win32", "Task"],
    ] as const;
    for (const [host, os, tool] of need) {
      const hits = fixtureCasesFor({ host, os, tool });
      expect(hits.length, `${host}/${os}/${tool}`).toBeGreaterThan(0);
    }
  });

  it("every fixture case matches pure classify (and stdin parse when raw)", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(24);

    for (const c of HOOK_FIXTURE_CASES) {
      let payload = c.payload;
      if (c.raw !== undefined) {
        const parsed = parseHookStdin(c.raw);
        if (c.expected.stdinEmpty === true) {
          expect(parsed.context.stdinEmpty, c.id).toBe(true);
        }
        if (c.expected.parseFailed === true) {
          expect(parsed.context.parseFailed, c.id).toBe(true);
        }
        if (c.expected.parseFailed !== true && c.expected.stdinEmpty !== true) {
          expect(parsed.context.parseFailed, c.id).toBeUndefined();
          expect(parsed.context.stdinEmpty, c.id).toBeUndefined();
        }
        payload = parsed.payload;
      }

      const classified = classifyHookPayload({ host: c.host, payload });
      expect(classified.toolName, c.id).toBe(c.expected.toolName);
      expect(classified.writeIntent, c.id).toBe(c.expected.writeIntent);
      expect(classified.writeTargetPath, c.id).toBe(c.expected.writeTargetPath);
      // helpers stay consistent with classify
      expect(hookToolName(payload, c.host), c.id).toBe(c.expected.toolName);
      expect(hookWriteTargetPath(payload), c.id).toBe(c.expected.writeTargetPath);
    }
  });
});
