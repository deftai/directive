import { fixtureCaseById, fixtureCasesFor, HOOK_FIXTURE_CASES } from "@deftai/directive-core/hooks";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import {
  DEFAULT_STDIN_EMPTY_RETRY_MS,
  parseArgs,
  parsePayload,
  readStdinHardened,
  run,
  STDIN_EMPTY_RETRY_INTERVAL_MS,
} from "./hook-dispatch.js";

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

  it("keeps SessionStart non-blocking and injects soft AGENTS re-bind (#3171)", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["--host", "claude", "--event", "session.start"], {
      readStdin: () => "{}",
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      cwd: () => "/definitely/not/a/repo",
    });

    expect(code).toBe(0);
    // Soft checklist is host-injected on stdout; SessionStart stays exit 0.
    const wire = JSON.parse(out.join("")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(wire.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(wire.hookSpecificOutput.additionalContext).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
    expect(wire.hookSpecificOutput.additionalContext).toContain("non-blocking path");
    expect(err.join("")).toContain("non-blocking path");
  });

  it("uses a payload-derived project root and emits Cursor allow for non-write tools (#2779 / #2864)", () => {
    const out: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify({ tool_name: "Read", workspace_root: "/project" }),
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/fallback",
    });
    expect(code).toBe(0);
    // Cursor failClosed deposits treat empty stdout as failure — allow must be explicit.
    // code is on the wire so agents can distinguish verdict classes without English (#2864).
    expect(JSON.parse(out.join(""))).toEqual({ permission: "allow", code: "not-direct-write" });
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
        ["--host=cursor", "--event=tool.before", "--project-root", "C:\\Repos\\deft\\statusreport"],
        {
          readStdin: () => JSON.stringify(payload),
          writeOut: (text) => out.push(text),
          writeErr: () => undefined,
          cwd: () => "C:",
        },
      );
      expect(code).toBe(0);
      expect(out.join("")).not.toMatch(/[A-Za-z]:\\[A-Za-z]:\\/i);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "normalizes doubled-drive --project-root before ritual lookup (#2787)",
    () => {
      const out: string[] = [];
      const code = run(
        [
          "--host=cursor",
          "--event=tool.before",
          "--project-root",
          "C:\\c:\\Repos\\deft\\statusreport",
        ],
        {
          readStdin: () =>
            JSON.stringify({
              tool_name: "Write",
              tool_input: { file_path: "src/a.ts", content: "x" },
            }),
          writeOut: (text) => out.push(text),
          writeErr: () => undefined,
          cwd: () => "C:\\Repos\\deft\\statusreport",
        },
      );
      expect(code).toBe(0);
      expect(out.join("")).not.toMatch(/[A-Za-z]:\\[A-Za-z]:\\/i);
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

  it("logs Cursor payload keys and distinct empty-stdin messaging (#2669 / #2864)", () => {
    const emptyOut: string[] = [];
    const emptyErr: string[] = [];
    const emptyExit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => "",
      // Skip wall-clock retry budget; empty path is covered with retries below.
      stdinEmptyRetryMs: 0,
      writeOut: (text) => emptyOut.push(text),
      writeErr: (text) => emptyErr.push(text),
      cwd: () => "/project",
    });
    const emptyDecision = JSON.parse(emptyOut.join(""));
    expect(emptyExit).toBe(0);
    expect(emptyDecision.permission).toBe("deny");
    expect(emptyDecision.code).toBe("stdin-empty");
    expect(emptyDecision.user_message).toContain("stdin was empty");
    expect(emptyErr.join("")).toContain("stdin was empty after empty-read retry budget");

    const unknownOut: string[] = [];
    const unknownErr: string[] = [];
    run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify({ host_version: "2026.1" }),
      writeOut: (text) => unknownOut.push(text),
      writeErr: (text) => unknownErr.push(text),
      cwd: () => "/project",
    });
    const unknownDecision = JSON.parse(unknownOut.join(""));
    expect(unknownDecision.code).toBe("invalid-input");
    expect(unknownDecision.user_message).toContain("Top-level payload keys: host_version");
    expect(unknownErr.join("")).toContain("Directive hook diagnostic: payload top-level keys");
  });

  it("accepts delayed stdin within the empty-read retry budget (#2864)", () => {
    let calls = 0;
    let clock = 0;
    const taskPayload = JSON.stringify({
      tool_name: "Task",
      tool_input: { subagent_type: "generalPurpose", prompt: "explore" },
      workspace_root: "/project",
    });
    const out: string[] = [];
    const exit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => {
        calls += 1;
        // First two polls empty (race); third delivers the host payload.
        return calls < 3 ? "" : taskPayload;
      },
      sleepMs: (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
      stdinEmptyRetryMs: DEFAULT_STDIN_EMPTY_RETRY_MS,
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(exit).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
    const decision = JSON.parse(out.join(""));
    // Ritual/scope seams use real project paths; without ready gates this may deny
    // spawn-not-ready — but it must NOT be stdin-empty (payload was accepted).
    expect(decision.code).not.toBe("stdin-empty");
    expect(decision.permission === "allow" || decision.permission === "deny").toBe(true);
  });

  it("denies true empty stdin with code stdin-empty and exit 0 after retries (#2864)", () => {
    let calls = 0;
    let clock = 0;
    const out: string[] = [];
    const exit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => {
        calls += 1;
        return "";
      },
      sleepMs: (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
      stdinEmptyRetryMs: DEFAULT_STDIN_EMPTY_RETRY_MS,
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(exit).toBe(0);
    expect(calls).toBeGreaterThan(1);
    expect(clock).toBeGreaterThanOrEqual(DEFAULT_STDIN_EMPTY_RETRY_MS);
    const decision = JSON.parse(out.join(""));
    expect(decision).toMatchObject({ permission: "deny", code: "stdin-empty" });
  });

  it("readStdinHardened returns first non-empty poll and leaves true empty as empty (#2864)", () => {
    let n = 0;
    let clock = 0;
    const delayed = readStdinHardened(
      () => {
        n += 1;
        return n === 1 ? "" : '{"tool_name":"Task"}';
      },
      {
        emptyRetryMs: 100,
        sleepMs: (ms) => {
          clock += ms;
        },
        nowMs: () => clock,
      },
    );
    expect(delayed).toBe('{"tool_name":"Task"}');
    expect(n).toBe(2);

    n = 0;
    clock = 0;
    const empty = readStdinHardened(
      () => {
        n += 1;
        return "   ";
      },
      {
        emptyRetryMs: STDIN_EMPTY_RETRY_INTERVAL_MS * 3,
        sleepMs: (ms) => {
          clock += ms;
        },
        nowMs: () => clock,
      },
    );
    expect(empty.trim()).toBe("");
    expect(n).toBeGreaterThan(1);
  });

  it("documents exit 0 for rendered verdicts and exit 2 only for argv errors (#2864)", () => {
    const allowOut: string[] = [];
    const allowExit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => JSON.stringify({ tool_name: "Read", workspace_root: "/project" }),
      writeOut: (text) => allowOut.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(allowExit).toBe(0);
    expect(JSON.parse(allowOut.join("")).permission).toBe("allow");

    const denyOut: string[] = [];
    const denyExit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => "",
      stdinEmptyRetryMs: 0,
      writeOut: (text) => denyOut.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(denyExit).toBe(0);
    expect(JSON.parse(denyOut.join("")).permission).toBe("deny");

    const argvErr: string[] = [];
    const argvExit = run(["--host=cursor", "--event=bogus"], {
      readStdin: () => "",
      writeOut: () => undefined,
      writeErr: (text) => argvErr.push(text),
    });
    expect(argvExit).toBe(2);
    expect(argvErr.join("")).toContain("unsupported event");
  });
});

describe("shared hooks fixture corpus (Phase B of #2950)", () => {
  it("imports the core HOOK_FIXTURE_CASES matrix", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(24);
    expect(fixtureCasesFor({ host: "cursor", tool: "Write" }).length).toBeGreaterThanOrEqual(3);
    expect(fixtureCaseById("cursor-posix-applypatch-freeform")?.raw).toBeDefined();
  });

  it("parsePayload agrees with every raw fixture case", () => {
    const rawCases = HOOK_FIXTURE_CASES.filter((c) => c.raw !== undefined);
    expect(rawCases.length).toBeGreaterThan(0);
    for (const c of rawCases) {
      const parsed = parsePayload(c.raw as string);
      if (c.expected.stdinEmpty) {
        expect(parsed.context.stdinEmpty, c.id).toBe(true);
      }
      if (c.expected.parseFailed) {
        expect(parsed.context.parseFailed, c.id).toBe(true);
      }
      if (c.expected.parseFailed !== true && c.expected.stdinEmpty !== true) {
        // Successful free-form / BOM JSON synthesis — CLI and core share the same parse.
        expect(parsed.context.parseFailed, c.id).toBeUndefined();
        expect(parsed.context.stdinEmpty, c.id).toBeUndefined();
      }
    }
  });

  it("runs Cursor free-form ApplyPatch fixture without JSON parse denial", () => {
    const freeForm = fixtureCaseById("cursor-posix-applypatch-freeform");
    expect(freeForm?.raw).toBeDefined();
    const out: string[] = [];
    const code = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => freeForm?.raw ?? "",
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(code).toBe(0);
    const rendered = out.join("");
    expect(rendered).not.toContain("not valid JSON");
    expect(rendered).not.toContain("omitted a recognizable tool name");
  });

  it("surfaces stdin-empty decision code from the empty-stdin fixture (#2864)", () => {
    const empty = fixtureCaseById("cursor-posix-stdin-empty");
    expect(empty?.raw).toBe("");
    const out: string[] = [];
    const exit = run(["--host=cursor", "--event=tool.before"], {
      readStdin: () => empty?.raw ?? "",
      stdinEmptyRetryMs: 0,
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      cwd: () => "/project",
    });
    expect(exit).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      permission: "deny",
      code: "stdin-empty",
    });
  });
});
