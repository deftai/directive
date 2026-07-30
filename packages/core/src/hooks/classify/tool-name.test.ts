import { describe, expect, it } from "vitest";
import { hookToolName, missingToolNameMessage } from "./tool-name.js";

describe("hookToolName (#2628 / #2669 / #2950)", () => {
  it("reads direct tool_name and nested tool_call", () => {
    expect(hookToolName({ tool_name: "Write" })).toBe("Write");
    expect(hookToolName({ tool_call: { name: "Task" } })).toBe("Task");
  });

  it("infers Cursor direct-write names when omitted", () => {
    expect(hookToolName({ arguments: { contents: "x", path: "a.py" } }, "cursor")).toBe("Write");
    expect(hookToolName({ tool_input: { path: "a.ts", patch: "diff" } }, "cursor")).toBe(
      "ApplyPatch",
    );
    expect(hookToolName({ tool_input: { old_string: "a", new_string: "b" } }, "cursor")).toBe(
      "StrReplace",
    );
  });

  it("missingToolNameMessage distinguishes stdin-empty and keys", () => {
    expect(
      missingToolNameMessage({ host: "cursor", payload: {}, context: { stdinEmpty: true } }),
    ).toContain("empty payload");
    expect(missingToolNameMessage({ host: "cursor", payload: { host_version: "1" } })).toContain(
      "host_version",
    );
    expect(missingToolNameMessage({ host: "claude", payload: {} })).toContain(
      "omitted its tool name",
    );
  });
});
