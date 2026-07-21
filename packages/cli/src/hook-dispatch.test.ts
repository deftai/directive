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
