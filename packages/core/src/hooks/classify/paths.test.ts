import { describe, expect, it } from "vitest";
import { hookMcpArgsText, hookPathSet, hookShellCommand, hookWriteTargetPath } from "./paths.js";

describe("path/shell extractors (#2950)", () => {
  it("hookWriteTargetPath reads nested and top-level spellings", () => {
    expect(hookWriteTargetPath({ tool_input: { file_path: "a.ts" } })).toBe("a.ts");
    expect(hookWriteTargetPath({ path: "b.ts" })).toBe("b.ts");
    expect(hookWriteTargetPath({})).toBeNull();
  });

  it("hookShellCommand and hookMcpArgsText", () => {
    expect(hookShellCommand({ tool_input: { command: "git push" } })).toBe("git push");
    expect(hookMcpArgsText({ tool_input: { x: 1 } })).toBe('{"x":1}');
    expect(hookPathSet({ tool_input: { path: "p.ts" } })).toEqual(["p.ts"]);
  });
});
