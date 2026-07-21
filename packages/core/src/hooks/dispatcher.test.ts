import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECT_WRITE_TOOL_NAMES,
  decideHook,
  type HookPolicySeams,
  hookPayloadTopLevelKeys,
  hookToolName,
  hookWriteTargetPath,
  isDirectWriteTool,
  isHookEvent,
  isHookHost,
  isProposedLifecycleWrite,
  projectRootFromHookPayload,
  renderHostDecision,
} from "./index.js";

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    inspectRitual: () => READY_RITUAL,
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

describe("direct-write hook policy", () => {
  it("allows non-write tools without consulting mutation gates", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Read", cwd: "/project" },
      },
      readySeams({ inspectRitual }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "not-direct-write" });
    expect(inspectRitual).not.toHaveBeenCalled();
  });

  it("denies a direct write when the gated ritual is not fresh", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "Edit", workspaceRoot: "/project" },
      },
      readySeams({
        inspectRitual: () => ({
          ...READY_RITUAL,
          code: 1,
          message: "ritual state missing",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(decision.message).toContain("deft session:start");
    expect(decision.message).toContain("deft verify:session-ritual -- --tier=gated");
  });

  it("denies a direct write when no active running scope passes preflight", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "StrReplace", workspace_roots: ["/project"] },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active/running xBRIEF is available.",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("deft scope:activate");
  });

  it("allows Write of xbrief/proposed/*.xbrief.json with no active scope (#2625)", () => {
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          cwd: "/project",
          tool_input: {
            file_path: "/project/xbrief/proposed/2026-07-17-story.xbrief.json",
          },
        },
      },
      readySeams({ inspectScope }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-propose-ready" });
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("allows Write of legacy vbrief/proposed/*.vbrief.json with no active scope (#2625)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "vbrief/proposed/legacy.vbrief.json" },
        },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active xBRIEF",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-propose-ready" });
  });

  it("allows a direct write only when both canonical predicates pass", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", cwd: "/project" },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(decision.scopePath).toBe(READY_SCOPE.path);
  });

  it("fails closed when a matched tool event omits its tool name", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "invalid-input" });
    expect(decision.message).toContain("omitted its tool name");
    expect(decision.message).not.toContain("host-integration");
  });

  it("maps Cursor write payloads that omit tool_name from tool_input shape (#2628)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_input: {
            path: "/project/src/index.ts",
            contents: "export {}",
          },
          workspace_roots: ["/project"],
        },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready", toolName: "Write" });
  });

  it("maps Cursor StrReplace payloads that omit tool_name (#2628)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_input: {
            path: "/project/src/index.ts",
            old_string: "foo",
            new_string: "bar",
          },
          workspace_roots: ["/project"],
        },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({
      verdict: "allow",
      code: "write-ready",
      toolName: "StrReplace",
    });
  });

  it("surfaces a Cursor host-integration deny when tool identity cannot be mapped (#2628)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "invalid-input" });
    expect(decision.message).toContain("host-integration mismatch");
    expect(decision.message).not.toContain("deft session:start");
  });

  it("distinguishes empty stdin from unknown-shape Cursor denies (#2669)", () => {
    const emptyStdin = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
        payloadContext: { stdinEmpty: true },
      },
      readySeams(),
    );
    expect(emptyStdin.message).toContain("stdin was empty");

    const parseFailed = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
        payloadContext: { parseFailed: true },
      },
      readySeams(),
    );
    expect(parseFailed.message).toContain("not valid JSON");

    const unknownShape = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { host_version: "1.2.3" },
      },
      readySeams(),
    );
    expect(unknownShape.message).toContain("Top-level payload keys: host_version");
    expect(hookPayloadTopLevelKeys({ host_version: "1.2.3" })).toEqual(["host_version"]);
  });

  it("maps Cursor gap-table payload shapes that omitted tool_name (#2669)", () => {
    expect(hookToolName({ arguments: { contents: "x", path: "a.py" } }, "cursor")).toBe("Write");
    expect(
      hookToolName(
        {
          tool_call: { name: "Write", arguments: { contents: "x", path: "a.py" } },
        },
        "cursor",
      ),
    ).toBe("Write");
    expect(hookToolName({ tool: { name: "Write" } }, "cursor")).toBe("Write");
    expect(
      hookToolName(
        {
          tool_call: {
            name: "StrReplace",
            arguments: { path: "a.py", old_string: "a", new_string: "b" },
          },
        },
        "cursor",
      ),
    ).toBe("StrReplace");
    expect(
      decideHook(
        {
          host: "cursor",
          event: "tool.before",
          projectRoot: "/project",
          payload: { arguments: { contents: "x", path: "src/a.py" } },
        },
        readySeams(),
      ),
    ).toMatchObject({ verdict: "allow", code: "write-ready", toolName: "Write" });
  });

  it("surfaces a failed SessionStart result without blocking the session", () => {
    const sessionStart = vi.fn(() => ({ code: 2, stdout: "", stderr: "no active scope" }));
    const decision = decideHook(
      {
        host: "grok",
        event: "session.start",
        projectRoot: "/project",
        payload: { hookEventName: "SessionStart", workspaceRoot: "/project" },
      },
      readySeams({ sessionStart }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toBe(
      "Directive SessionStart bookkeeping reported exit 2 on its non-blocking path: no active scope",
    );
    expect(sessionStart).toHaveBeenCalledWith(resolve("/project"));
  });

  it("reports a failed SessionStart result even when the hook returns no detail", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({ sessionStart: () => ({ code: 1, stdout: "", stderr: "" }) }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toBe(
      "Directive SessionStart bookkeeping reported exit 1 on its non-blocking path.",
    );
  });

  it("keeps SessionStart non-blocking when bookkeeping throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart: () => {
          throw new Error("read-only bookkeeping failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toBe(
      "Directive SessionStart bookkeeping failed on its non-blocking path: Error: read-only bookkeeping failed",
    );
  });

  it("reports successful SessionStart bookkeeping", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start" });
    expect(decision.message).toBe("SessionStart bookkeeping completed on a non-blocking path.");
  });

  it("re-arms ritual state on session.compact without blocking the host (#2113)", () => {
    const markCompactStale = vi.fn(() => ({
      changed: true,
      statePath: "/project/.deft/ritual-state.json",
      message: "Marked session ritual stale after context compaction.",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({ markCompactStale }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-compact-rearm" });
    expect(markCompactStale).toHaveBeenCalledWith(resolve("/project"));
  });

  it("reports session.compact noop when no ritual state exists (#2113)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        markCompactStale: () => ({
          changed: false,
          statePath: "/project/.deft/ritual-state.json",
          message: "no ritual state to invalidate after compaction",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-compact-noop" });
  });

  it("keeps session.compact non-blocking when re-arm throws (#2113)", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        markCompactStale: () => {
          throw new Error("write failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-compact-rearm-degraded" });
    expect(decision.message).toContain("write failed");
  });

  it("fails closed when ritual inspection throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool: "Write" },
      },
      readySeams({
        inspectRitual: () => {
          throw new Error("probe failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(decision.message).toContain("probe failed");
  });

  it("fails closed when active-scope inspection throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Edit" },
      },
      readySeams({
        inspectScope: () => {
          throw new Error("scope probe failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("scope probe failed");
  });
});

describe("provider codecs", () => {
  const deny = decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: "/project",
      payload: { toolName: "Write" },
    },
    readySeams({
      inspectRitual: () => ({ ...READY_RITUAL, code: 1, message: "stale" }),
    }),
  );

  it("renders Claude's hookSpecificOutput denial", () => {
    expect(JSON.parse(renderHostDecision("claude", deny))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("renders Grok's native decision denial", () => {
    expect(JSON.parse(renderHostDecision("grok", deny))).toMatchObject({
      decision: "deny",
    });
  });

  it("renders Cursor's permission denial", () => {
    expect(JSON.parse(renderHostDecision("cursor", deny))).toMatchObject({
      permission: "deny",
    });
  });

  it("renders Codex's canonical hookSpecificOutput denial", () => {
    expect(JSON.parse(renderHostDecision("codex", deny))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: deny.message,
      },
    });
  });

  it("emits no provider override for an allow decision", () => {
    const allow = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Read" },
      },
      readySeams(),
    );
    expect(renderHostDecision("claude", allow)).toBe("");
    expect(renderHostDecision("grok", allow)).toBe("");
    expect(renderHostDecision("cursor", allow)).toBe("");
    expect(renderHostDecision("codex", allow)).toBe("");
  });
});

describe("direct-write classifier", () => {
  it.each([...DIRECT_WRITE_TOOL_NAMES])("classifies %s as a direct write", (tool) =>
    expect(isDirectWriteTool(tool)).toBe(true));

  it.each([
    "Read",
    "Grep",
    "Shell",
    "Bash",
    "Task",
    "WebSearch",
  ])("leaves %s outside the P0 direct-write slice", (tool) =>
    expect(isDirectWriteTool(tool)).toBe(false));
});

describe("provider input normalization", () => {
  it("accepts snake_case, camelCase, and generic tool names", () => {
    expect(hookToolName({ tool_name: "Write" })).toBe("Write");
    expect(hookToolName({ toolName: "Edit" })).toBe("Edit");
    expect(hookToolName({ tool: "Delete" })).toBe("Delete");
    expect(hookToolName(null)).toBeNull();
    expect(hookToolName({ tool_name: "  " })).toBeNull();
  });

  it("infers Cursor direct-write tools when tool_name is omitted (#2628)", () => {
    expect(
      hookToolName(
        {
          tool_input: { path: "src/a.ts", contents: "x" },
        },
        "cursor",
      ),
    ).toBe("Write");
    expect(
      hookToolName(
        {
          toolInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
        },
        "cursor",
      ),
    ).toBe("StrReplace");
    expect(hookToolName({ tool_input: { path: "src/a.ts" } }, "cursor")).toBe("Write");
    expect(
      hookToolName({ tool_input: { path: "src/a.ts", new_string: "prepend" } }, "cursor"),
    ).toBe("StrReplace");
    expect(hookToolName({}, "cursor")).toBeNull();
    expect(hookToolName({ tool_input: { path: "src/a.ts" } })).toBeNull();
  });

  it("resolves supported workspace-root spellings with a fallback", () => {
    // path.resolve is platform-native (win32 maps "/fallback" -> "C:\\fallback").
    expect(projectRootFromHookPayload(null, "/fallback")).toBe(resolve("/fallback"));
    expect(projectRootFromHookPayload({ workspace_root: "/snake" }, "/fallback")).toBe(
      resolve("/snake"),
    );
    expect(projectRootFromHookPayload({ workspace_roots: ["/array"] }, "/fallback")).toBe(
      resolve("/array"),
    );
    expect(projectRootFromHookPayload({ cwd: "/cwd" }, "/fallback")).toBe(resolve("/cwd"));
    expect(projectRootFromHookPayload({}, "/fallback")).toBe(resolve("/fallback"));
  });

  it("validates public host and event identifiers", () => {
    expect(isHookHost("cursor")).toBe(true);
    expect(isHookHost("codex")).toBe(true);
    expect(isHookHost("opencode")).toBe(false);
    expect(isHookEvent("session.start")).toBe(true);
    expect(isHookEvent("session.compact")).toBe(true);
    expect(isHookEvent("tool.after")).toBe(false);
  });

  it("extracts write target paths from host payload shapes (#2625)", () => {
    expect(
      hookWriteTargetPath({ tool_input: { file_path: "/p/xbrief/proposed/a.xbrief.json" } }),
    ).toBe("/p/xbrief/proposed/a.xbrief.json");
    expect(hookWriteTargetPath({ filePath: "xbrief/proposed/b.xbrief.json" })).toBe(
      "xbrief/proposed/b.xbrief.json",
    );
    expect(hookWriteTargetPath({ tool_name: "Write" })).toBeNull();
    expect(hookWriteTargetPath({ toolInput: { path: "xbrief/proposed/c.xbrief.json" } })).toBe(
      "xbrief/proposed/c.xbrief.json",
    );
    expect(hookWriteTargetPath({ input: { filePath: "xbrief/proposed/d.xbrief.json" } })).toBe(
      "xbrief/proposed/d.xbrief.json",
    );
    expect(hookWriteTargetPath({ path: "xbrief/proposed/e.xbrief.json" })).toBe(
      "xbrief/proposed/e.xbrief.json",
    );
    expect(hookWriteTargetPath(null)).toBeNull();
    expect(hookWriteTargetPath("Write")).toBeNull();
  });

  it("classifies proposed lifecycle writes (#2625)", () => {
    expect(
      isProposedLifecycleWrite("/project", "xbrief/proposed/2026-07-17-story.xbrief.json"),
    ).toBe(true);
    expect(isProposedLifecycleWrite("/project", "vbrief/proposed/legacy.vbrief.json")).toBe(true);
    expect(isProposedLifecycleWrite("/project", "xbrief/active/story.xbrief.json")).toBe(false);
    expect(isProposedLifecycleWrite("/project", "src/index.ts")).toBe(false);
    expect(isProposedLifecycleWrite("/project", null)).toBe(false);
    expect(isProposedLifecycleWrite("/project", "   ")).toBe(false);
    expect(isProposedLifecycleWrite("/project", "")).toBe(false);
    expect(isProposedLifecycleWrite("/project", "../outside/xbrief/proposed/x.xbrief.json")).toBe(
      false,
    );
    expect(isProposedLifecycleWrite("/project", "xbrief/proposed/README.md")).toBe(false);
    expect(isProposedLifecycleWrite("/project", "xbrief/pending/story.xbrief.json")).toBe(false);
  });

  it("hints when proposed path is present but not a lifecycle artifact (#2625)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "xbrief/proposed/notes.md" },
        },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active xBRIEF artifact was found under xbrief/active/",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("lifecycle artifact");
  });

  it("hints when write target uses backslash proposed paths (#2625)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "xbrief\\proposed\\notes.md" },
        },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active xBRIEF",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("lifecycle artifact");
  });

  it("resolves workspaceRoot camelCase spelling", () => {
    expect(projectRootFromHookPayload({ workspaceRoot: "/camel" }, "/fallback")).toBe(
      resolve("/camel"),
    );
  });

  it("rejects lifecycle writes that escape the project root", () => {
    expect(
      isProposedLifecycleWrite("/project", "xbrief/proposed/../active/story.xbrief.json"),
    ).toBe(false);
  });

  it("surfaces SessionStart stdout when stderr is empty", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart: () => ({ code: 3, stdout: "stdout-only detail", stderr: "" }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-degraded" });
    expect(decision.message).toContain("stdout-only detail");
  });
});
