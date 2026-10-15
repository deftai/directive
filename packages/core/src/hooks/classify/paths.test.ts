import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hookApplyPatchBodyText,
  hookMcpArgsText,
  hookMutationTargetPaths,
  hookPathSet,
  hookShellCommand,
  hookWriteTargetPath,
  normalizeMutationTargetPaths,
  resolveMutationTargetPath,
} from "./paths.js";

describe("path/shell extractors (#2950)", () => {
  it("hookWriteTargetPath reads nested and top-level spellings", () => {
    expect(hookWriteTargetPath({ tool_input: { file_path: "a.ts" } })).toBe("a.ts");
    expect(hookWriteTargetPath({ path: "b.ts" })).toBe("b.ts");
    expect(hookWriteTargetPath({})).toBeNull();
  });

  it("hookApplyPatchBodyText reads nested patch spellings", () => {
    expect(hookApplyPatchBodyText({ tool_input: { patch: "p" } })).toBe("p");
    expect(hookApplyPatchBodyText({ unified_diff: "d" })).toBe("d");
    expect(hookApplyPatchBodyText({})).toBeNull();
  });

  it("hookApplyPatchBodyText reads string command only on declared apply_patch (#5094)", () => {
    const patch = "*** Begin Patch\n*** Update File: body.ts\n+x\n*** End Patch";
    expect(
      hookApplyPatchBodyText({
        tool_name: "apply_patch",
        tool_input: { command: patch },
      }),
    ).toBe(patch);
    expect(
      hookApplyPatchBodyText({
        tool_name: "Bash",
        tool_input: { command: patch },
      }),
    ).toBeNull();
  });

  it("hyphenated apply-patch command-only payload extracts mutation targets (#5094)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply-patch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: hyphen.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["hyphen.ts"]);
  });

  it("hookApplyPatchBodyText unions conflicting body fields (#5094)", () => {
    const patchA = "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch";
    const patchB = "*** Begin Patch\n*** Update File: b.ts\n+y\n*** End Patch";
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: { patch: patchA, command: patchB },
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("hookMutationTargetPaths includes ApplyPatch body members", () => {
    expect(
      hookMutationTargetPaths({
        tool_input: {
          path: "declared.ts",
          patch: "*** Begin Patch\n*** Update File: body.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["declared.ts", "body.ts"]);
  });

  it("hookMutationTargetPaths includes a canonical `Move to` destination (#3794)", () => {
    expect(
      hookMutationTargetPaths({
        tool_input: {
          path: "declared.ts",
          patch:
            "*** Begin Patch\n*** Update File: src/from.ts\n" +
            "*** Move to: /elsewhere/to.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["declared.ts", "src/from.ts", "/elsewhere/to.ts"]);
  });
  it("hookShellCommand and hookMcpArgsText", () => {
    expect(hookShellCommand({ tool_input: { command: "git push" } })).toBe("git push");
    expect(hookMcpArgsText({ tool_input: { x: 1 } })).toBe('{"x":1}');
    expect(hookPathSet({ tool_input: { path: "p.ts" } })).toEqual(["p.ts"]);
  });

  it("string command Add/Update/Delete/Move-to recover mutation targets (#5094)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Add File: added.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["added.ts"]);
    expect(
      hookMutationTargetPaths({
        tool_name: "ApplyPatch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: updated.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["updated.ts"]);
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch",
        },
      }),
    ).toEqual(["gone.ts"]);
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: from.ts\n*** Move to: to.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["from.ts", "to.ts"]);
  });

  it("Bash heredoc with Update File keeps shell targets unchanged (#5094)", () => {
    const command = "cat > notes.md <<'EOF'\n*** Update File: secret.ts\nEOF";
    const payload = { tool_name: "Bash", tool_input: { command } };
    expect(hookApplyPatchBodyText(payload)).toBeNull();
    expect(hookMutationTargetPaths(payload)).toEqual([]);
    expect(hookShellCommand(payload)).toBe(command);
  });

  it("declared apply_patch string tool_input.input yields mutation targets (#5129)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          input: "*** Begin Patch\n*** Update File: linked.ts\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["linked.ts"]);
  });

  it("top-level string payload.input yields mutation targets (#5129)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: added.ts\n+x\n*** End Patch",
      }),
    ).toEqual(["added.ts"]);
  });

  it("unions patch and canonical input body targets (#5129)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          patch: "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch",
          input: "*** Begin Patch\n*** Update File: b.ts\n+y\n*** End Patch",
        },
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("header-looking input without Begin/End does not yield body targets (#5129)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: {
          input: "not a patch\n*** Update File: /linked/src/a.ts\nnoise",
        },
      }),
    ).toEqual([]);
  });

  it("shell and MCP names do not harvest tool_input.input (#5129)", () => {
    const input = "*** Begin Patch\n*** Update File: secret.ts\n+x\n*** End Patch";
    expect(hookMutationTargetPaths({ tool_name: "shell", tool_input: { input } })).toEqual([]);
    expect(
      hookMutationTargetPaths({
        tool_name: "mcp__github__create_issue",
        tool_input: { input },
      }),
    ).toEqual([]);
  });

  it("raw-string tool_input stays unharvested (#5129)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "apply_patch",
        tool_input: "*** Begin Patch\n*** Update File: linked.ts\n+x\n*** End Patch",
      }),
    ).toEqual([]);
  });

  it("harvests MCP uri and file dest fields (#5366)", () => {
    expect(
      hookMutationTargetPaths({
        tool_name: "mcp__filesystem__write_file",
        tool_input: { uri: "src/via-uri.ts", contents: "x" },
      }),
    ).toEqual(["src/via-uri.ts"]);
    expect(
      hookMutationTargetPaths({
        tool_input: {
          tool_name: "write_file",
          arguments: { file: "nested/via-file.ts" },
        },
      }),
    ).toEqual(["nested/via-file.ts"]);
    expect(hookWriteTargetPath({ tool_input: { uri: "only-uri.ts" } })).toBe("only-uri.ts");
    expect(
      hookMutationTargetPaths({
        tool_name: "mcp__serena__create_text_file",
        tool_input: { relative_path: "src/a.ts", content: "x" },
      }),
    ).toEqual(["src/a.ts"]);
  });

  it("decodes local file: URIs and refuses unsupported schemes (#5366)", () => {
    const localFile =
      process.platform === "win32" ? "file:///C:/tmp/secret%20x.ts" : "file:///tmp/secret%20x.ts";
    expect(resolveMutationTargetPath(localFile)).toEqual({
      status: "path",
      path: fileURLToPath(localFile),
    });
    expect(resolveMutationTargetPath("https://example.com/a.ts")).toEqual({
      status: "refuse",
      detail: "unsupported URI scheme: https",
    });
    expect(resolveMutationTargetPath("mcp://server/tool")).toEqual({
      status: "refuse",
      detail: "unsupported URI scheme: mcp",
    });
    expect(resolveMutationTargetPath("src/plain.ts")).toEqual({
      status: "path",
      path: "src/plain.ts",
    });
    // Windows drive letter is not a URI scheme.
    expect(resolveMutationTargetPath("C:/repo/a.ts")).toEqual({
      status: "path",
      path: "C:/repo/a.ts",
    });
    expect(normalizeMutationTargetPaths(["src/ok.ts", "https://evil.example/x"]).ok).toBe(false);
    expect(normalizeMutationTargetPaths(["src/ok.ts", "src/ok.ts"])).toEqual({
      ok: true,
      paths: ["src/ok.ts"],
    });
  });
});
