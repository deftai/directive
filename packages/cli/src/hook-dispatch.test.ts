import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { parseArgs, parsePayload, run } from "./hook-dispatch.js";

describe("hook-dispatch CLI", () => {
  it("parses the provider-neutral host/event contract", () => {
    expect(
      parseArgs(["--host", "grok", "--event", "tool.before", "--project-root=/project"]),
    ).toEqual({ host: "grok", event: "tool.before", projectRoot: "/project" });
    expect(parseArgs(["--host", "codex", "--event", "session.start"])).toEqual({
      host: "codex",
      event: "session.start",
    });
    expect(parseArgs(["--host", "cursor", "--event", "session.compact"])).toEqual({
      host: "cursor",
      event: "session.compact",
    });
  });

  it("rejects unsupported providers and events as configuration errors", () => {
    expect(parseArgs(["--host", "opencode", "--event", "tool.before"]).error).toContain(
      "unsupported host",
    );
    expect(parseArgs(["--host", "grok", "--event", "tool.after"]).error).toContain(
      "unsupported event",
    );
  });

  it("covers inline flags and missing/unknown argument diagnostics", () => {
    expect(parseArgs(["--host=cursor", "--event=session.start"])).toEqual({
      host: "cursor",
      event: "session.start",
    });
    expect(parseArgs([]).error).toBe("--host is required");
    expect(parseArgs(["--host", "claude"]).error).toBe("--event is required");
    expect(parseArgs(["--host"]).error).toContain("expected one argument");
    expect(parseArgs(["--host", "claude", "--event"]).error).toContain("expected one argument");
    expect(
      parseArgs(["--host", "claude", "--event", "session.start", "--project-root"]).error,
    ).toContain("expected one argument");
    expect(parseArgs(["--bogus"]).error).toContain("unrecognized argument");
  });

  it("fails closed with a Grok-native denial when matched tool input is malformed", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["--host", "grok", "--event", "tool.before"], {
      readStdin: () => "{bad-json",
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      cwd: () => "/project",
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ decision: "deny" });
    expect(err).toEqual([]);
  });

  it("fails closed with a Codex-native denial when matched tool input is malformed", () => {
    const out: string[] = [];
    const code = run(["--host", "codex", "--event", "tool.before"], {
      readStdin: () => "{bad-json",
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("keeps SessionStart non-blocking and silent", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["--host", "claude", "--event", "session.start"], {
      readStdin: () => "{}",
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      cwd: () => "/definitely/not/a/repo",
    });

    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("non-blocking path");
  });

  it("uses a payload-derived project root and allows non-write tools silently", () => {
    const out: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify({ tool_name: "Read", workspace_root: "/project" }),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/fallback",
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("returns exit 2 through the CLI error path", () => {
    const err: string[] = [];
    const code = run([], {
      readStdin: () => "",
      writeOut: () => undefined,
      writeErr: (text) => err.push(text),
    });
    expect(code).toBe(2);
    expect(err.join("")).toContain("--host is required");
  });

  it("registers the task-style hook:dispatch alias", () => {
    expect(resolveCanonicalVerb("hook:dispatch")).toBe("hook-dispatch");
  });

  it("tags empty stdin separately from parse failures (#2669)", () => {
    expect(parsePayload("")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parsePayload("{bad-json")).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("strips UTF-8 BOM before JSON.parse (#2734)", () => {
    const writePayload = {
      tool_name: "Write",
      tool_input: { content: "x", file_path: "a.txt" },
      workspace_roots: ["/p"],
    };
    const bomWrite = `\uFEFF${JSON.stringify(writePayload)}`;
    expect(parsePayload(bomWrite)).toEqual({ payload: writePayload, context: {} });
    expect(parsePayload("\uFEFF")).toEqual({ payload: {}, context: { stdinEmpty: true } });
    expect(parsePayload("\uFEFF{bad-json")).toEqual({
      payload: {},
      context: { parseFailed: true },
    });
  });

  it("allows Cursor Write payloads prefixed with UTF-8 BOM (#2734)", () => {
    const out: string[] = [];
    const err: string[] = [];
    const writePayload = {
      tool_name: "Write",
      tool_input: { content: "x", file_path: "a.txt" },
      workspace_roots: ["/project"],
    };
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => `\uFEFF${JSON.stringify(writePayload)}`,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    const rendered = out.join("");
    expect(rendered).not.toContain("not valid JSON");
    expect(rendered).not.toContain("omitted a recognizable tool name");
    if (rendered.length > 0) {
      expect(JSON.parse(rendered).user_message).toContain("Write");
    }
  });

  it("synthesizes Cursor free-form ApplyPatch stdin after JSON.parse fails (#2738)", () => {
    const freeFormAdd = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/_probe-applypatch-only.txt",
      "+probe",
      "*** End Patch",
    ].join("\n");
    expect(parsePayload(freeFormAdd)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: {
          path: "xbrief/proposed/_probe-applypatch-only.txt",
          patch: freeFormAdd,
        },
      },
      context: {},
    });

    const freeFormUpdate = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    expect(parsePayload(freeFormUpdate)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: {
          path: "src/example.ts",
          patch: freeFormUpdate,
        },
      },
      context: {},
    });

    const bomFreeForm = `\uFEFF${freeFormAdd}`;
    expect(parsePayload(bomFreeForm)).toEqual({
      payload: {
        tool_name: "ApplyPatch",
        tool_input: {
          path: "xbrief/proposed/_probe-applypatch-only.txt",
          patch: freeFormAdd,
        },
      },
      context: {},
    });
  });

  it("keeps multi-file and unparseable free-form ApplyPatch fail-closed (#2738)", () => {
    const multiFile = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+a",
      "*** Add File: b.txt",
      "+b",
      "*** End Patch",
    ].join("\n");
    expect(parsePayload(multiFile)).toEqual({ payload: {}, context: { parseFailed: true } });

    const addAndUpdate = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+a",
      "*** Update File: b.txt",
      "@@",
      "*** End Patch",
    ].join("\n");
    expect(parsePayload(addAndUpdate)).toEqual({ payload: {}, context: { parseFailed: true } });

    const markerOnly = "*** Begin Patch\n*** End Patch";
    expect(parsePayload(markerOnly)).toEqual({ payload: {}, context: { parseFailed: true } });

    const emptyPath = ["*** Begin Patch", "*** Add File: ", "+a", "*** End Patch"].join("\n");
    expect(parsePayload(emptyPath)).toEqual({ payload: {}, context: { parseFailed: true } });

    expect(parsePayload("{bad-json")).toEqual({ payload: {}, context: { parseFailed: true } });

    const addFileWithoutBegin = ["*** Add File: only.txt", "+x"].join("\n");
    expect(parsePayload(addFileWithoutBegin)).toEqual({
      payload: {},
      context: { parseFailed: true },
    });

    // One Add + Delete must not synthesize — policy would only see the Add path.
    const addPlusDelete = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/a.xbrief.json",
      "+probe",
      "*** Delete File: src/secret.ts",
      "*** End Patch",
    ].join("\n");
    expect(parsePayload(addPlusDelete)).toEqual({ payload: {}, context: { parseFailed: true } });

    const deleteOnly = ["*** Begin Patch", "*** Delete File: src/a.ts", "*** End Patch"].join("\n");
    expect(parsePayload(deleteOnly)).toEqual({ payload: {}, context: { parseFailed: true } });
  });

  it("allows Cursor JSON ApplyPatch through hook-dispatch (#2738)", () => {
    const payload = {
      tool_name: "ApplyPatch",
      tool_input: {
        path: "xbrief/proposed/_probe-applypatch-only.xbrief.json",
        patch: "*** Begin Patch\n*** Add File: x\n+probe\n*** End Patch",
      },
      workspace_roots: ["/project"],
    };
    const out: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify(payload),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    expect(out.join("")).not.toContain("not valid JSON");
  });

  it("allows Cursor free-form ApplyPatch through hook-dispatch without JSON parse denial (#2738)", () => {
    const freeForm = [
      "*** Begin Patch",
      "*** Add File: xbrief/proposed/_probe-applypatch-only.xbrief.json",
      "+probe",
      "*** End Patch",
    ].join("\n");
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => freeForm,
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    const rendered = out.join("");
    expect(rendered).not.toContain("not valid JSON");
    expect(rendered).not.toContain("omitted a recognizable tool name");
  });

  it.skipIf(process.platform !== "win32")(
    "honors explicit --project-root over drive-only payload workspace roots (#2764)",
    () => {
      const payload = {
        tool_name: "Write",
        tool_input: { file_path: "src/a.ts", content: "x" },
        workspace_roots: ["C:"],
        cwd: "C:",
      };
      const out: string[] = [];
      const code = run(
        [
          "--host=cursor",
          "--event=tool.before",
          "--project-root",
          "C:\\Users\\nicol\\OneDrive\\Documents\\Projects\\Aperture",
        ],
        {
          readStdin: () => JSON.stringify(payload),
          writeOut: (text) => out.push(text),
          writeErr: () => undefined,
          cwd: () => "C:",
        },
      );
      expect(code).toBe(0);
      expect(out.join("")).not.toContain("C:\\\\C:\\\\");
    },
  );

  it("denies Cursor multi-file free-form ApplyPatch as invalid JSON (#2738)", () => {
    const multiFile = [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+a",
      "*** Add File: b.txt",
      "+b",
      "*** End Patch",
    ].join("\n");
    const out: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => multiFile,
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    const decision = JSON.parse(out.join(""));
    expect(decision.permission).toBe("deny");
    expect(decision.user_message).toContain("not valid JSON");
  });

  it("writes session.compact bookkeeping to stderr (#2113)", () => {
    const err: string[] = [];
    const code = run(["--host=cursor", "--event=session.compact", "--project-root=/project"], {
      readStdin: () => "{}",
      writeOut: () => undefined,
      writeErr: (text) => err.push(text),
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/compaction|ritual/i);
  });

  it("logs Cursor payload keys and distinct empty-stdin messaging (#2669)", () => {
    const emptyOut: string[] = [];
    const emptyErr: string[] = [];
    run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => "",
      writeOut: (text) => emptyOut.push(text),
      writeErr: (text) => emptyErr.push(text),
      cwd: () => "/project",
    });
    const emptyDecision = JSON.parse(emptyOut.join(""));
    expect(emptyDecision.permission).toBe("deny");
    expect(emptyDecision.user_message).toContain("stdin was empty");
    expect(emptyErr).toEqual([]);

    const unknownOut: string[] = [];
    const unknownErr: string[] = [];
    run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify({ host_version: "2026.1" }),
      writeOut: (text) => unknownOut.push(text),
      writeErr: (text) => unknownErr.push(text),
      cwd: () => "/project",
    });
    const unknownDecision = JSON.parse(unknownOut.join(""));
    expect(unknownDecision.user_message).toContain("Top-level payload keys: host_version");
    expect(unknownErr.join("")).toContain("Directive hook diagnostic: payload top-level keys");
  });
});
