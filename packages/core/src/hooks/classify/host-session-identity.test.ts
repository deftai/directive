import { describe, expect, it } from "vitest";
import {
  exactLifecycleCommandVerb,
  hookHostIdentitySource,
  hostIdentityFallsBackToExplicitOwner,
  inspectExactLifecycleCommand,
  MAX_HOOK_HOST_IDENTITY_UTF8_BYTES,
  resolveHookHostIdentity,
  rewriteExactLifecycleCommand,
} from "./host-session-identity.js";

const CODEX_SESSION_ID = "host:codex:v1:c2Vzc2lvbi1B";
const GROK_RAW_SESSION_ID = "grok-session-a";
const GROK_SESSION_ID = "host:grok:v1:Z3Jvay1zZXNzaW9uLWE";

describe("resolveHookHostIdentity (#3611)", () => {
  it("canonicalizes Codex and keeps parent/subagent events in one session family", () => {
    expect(resolveHookHostIdentity("codex", { session_id: "session-A" })).toEqual({
      status: "ok",
      provider: "codex",
      rawSessionId: "session-A",
      sessionId: CODEX_SESSION_ID,
      message: null,
    });
    expect(
      resolveHookHostIdentity("codex", {
        session_id: "session-A",
        agent_id: "subagent-7",
      }),
    ).toMatchObject({ status: "ok", sessionId: CODEX_SESSION_ID });
  });

  it("uses Claude session_id instead of the optional subagent agent_id", () => {
    expect(
      resolveHookHostIdentity("claude", {
        session_id: "claude-session",
        agent_id: "claude-subagent",
      }),
    ).toEqual({
      status: "ok",
      provider: "claude",
      rawSessionId: "claude-session",
      sessionId: "host:claude:v1:Y2xhdWRlLXNlc3Npb24",
      message: null,
    });
  });

  it("uses Cursor conversation_id and accepts an agreeing simultaneous session_id", () => {
    expect(
      resolveHookHostIdentity("cursor", {
        conversation_id: "conv-1",
        session_id: "conv-1",
      }),
    ).toEqual({
      status: "ok",
      provider: "cursor",
      rawSessionId: "conv-1",
      sessionId: "host:cursor:v1:Y29udi0x",
      message: null,
    });
  });

  it("fails closed when Cursor identity fields conflict", () => {
    expect(
      resolveHookHostIdentity("cursor", {
        conversation_id: "conv-A",
        session_id: "conv-B",
      }),
    ).toEqual({
      status: "conflict",
      provider: "cursor",
      rawSessionId: null,
      sessionId: null,
      message: "Cursor hook identity conflict: conversation_id and session_id differ.",
    });
  });

  it.each([
    ["codex", {}, "missing"],
    ["claude", { session_id: "   " }, "invalid"],
    ["cursor", { conversation_id: 42 }, "invalid"],
    ["cursor", { session_id: "conv-only" }, "missing"],
    // Grok's payload session_id stays unverified and is never read: with no
    // host variable in the environment the resolution is missing, not ok.
    ["grok", { session_id: "unverified" }, "missing"],
    ["openclaw", { session_id: "unknown-host" }, "unsupported"],
  ] as const)("reports %s identity as %s", (host, payload, status) => {
    expect(resolveHookHostIdentity(host, payload, {})).toMatchObject({ status, sessionId: null });
  });

  it("bounds raw IDs by UTF-8 bytes rather than UTF-16 code units", () => {
    expect(
      resolveHookHostIdentity("codex", {
        session_id: "a".repeat(MAX_HOOK_HOST_IDENTITY_UTF8_BYTES),
      }),
    ).toMatchObject({ status: "ok" });
    expect(
      resolveHookHostIdentity("codex", {
        session_id: "a".repeat(MAX_HOOK_HOST_IDENTITY_UTF8_BYTES + 1),
      }),
    ).toMatchObject({ status: "invalid", sessionId: null });

    const scalarAtBoundary = "😀".repeat(MAX_HOOK_HOST_IDENTITY_UTF8_BYTES / 4);
    expect(resolveHookHostIdentity("cursor", { conversation_id: scalarAtBoundary })).toMatchObject({
      status: "ok",
    });
    expect(
      resolveHookHostIdentity("cursor", { conversation_id: `${scalarAtBoundary}😀` }),
    ).toMatchObject({ status: "invalid", sessionId: null });
  });

  it.each([
    "session\u0000id",
    "session\nid",
    "session\u0085id",
  ])("rejects raw IDs containing control characters %j", (session_id) => {
    expect(resolveHookHostIdentity("claude", { session_id })).toMatchObject({
      status: "invalid",
      sessionId: null,
    });
  });

  it.each([
    "session-\ud800",
    "session-\udc00",
    "session-\ud800x",
    "session-x\udc00",
  ])("rejects raw IDs containing an unpaired UTF-16 surrogate %j", (session_id) => {
    expect(resolveHookHostIdentity("codex", { session_id })).toMatchObject({
      status: "invalid",
      sessionId: null,
    });
  });

  it("preserves valid non-BMP Unicode scalar IDs without canonical collision", () => {
    expect(resolveHookHostIdentity("codex", { session_id: "session-😀" })).toMatchObject({
      status: "ok",
      rawSessionId: "session-😀",
      sessionId: "host:codex:v1:c2Vzc2lvbi3wn5iA",
    });
  });
});

describe("host-env session identity (#3873)", () => {
  it("canonicalizes the id the host publishes in the hook process environment", () => {
    expect(
      resolveHookHostIdentity(
        "grok",
        { tool_name: "Write" },
        { GROK_SESSION_ID: GROK_RAW_SESSION_ID },
      ),
    ).toEqual({
      status: "ok",
      provider: "grok",
      rawSessionId: GROK_RAW_SESSION_ID,
      sessionId: GROK_SESSION_ID,
      message: null,
    });
  });

  it("never reads the unverified Grok payload session_id, even as a fallback", () => {
    expect(resolveHookHostIdentity("grok", { session_id: "payload-owner" }, {})).toMatchObject({
      status: "missing",
      sessionId: null,
    });
    // A host variable present alongside a different payload id resolves to the
    // variable: the payload field is not consulted, so it cannot conflict.
    expect(
      resolveHookHostIdentity(
        "grok",
        { session_id: "payload-owner" },
        { GROK_SESSION_ID: GROK_RAW_SESSION_ID },
      ),
    ).toMatchObject({ status: "ok", sessionId: GROK_SESSION_ID });
  });

  it.each([
    [{ GROK_SESSION_ID: "" }, "missing"],
    [{ GROK_SESSION_ID: " padded " }, "invalid"],
    [{ GROK_SESSION_ID: "control\u0000id" }, "invalid"],
    [{ GROK_SESSION_ID: "a".repeat(MAX_HOOK_HOST_IDENTITY_UTF8_BYTES + 1) }, "invalid"],
  ] as const)("bounds the host variable the same way as a payload id (%#)", (environ, status) => {
    expect(resolveHookHostIdentity("grok", {}, environ)).toMatchObject({
      status,
      sessionId: null,
    });
  });

  it("falls back to the explicit owner flow only when the variable is absent", () => {
    const absent = resolveHookHostIdentity("grok", {}, {});
    const malformed = resolveHookHostIdentity("grok", {}, { GROK_SESSION_ID: " padded " });
    const unknownHost = resolveHookHostIdentity("openclaw", {}, {});
    expect(hostIdentityFallsBackToExplicitOwner("grok", absent)).toBe(true);
    expect(hostIdentityFallsBackToExplicitOwner("grok", malformed)).toBe(false);
    expect(hostIdentityFallsBackToExplicitOwner("openclaw", unknownHost)).toBe(false);
    // A payload provider that omits its field is a broken contract, not a
    // legacy host: it must never route back to the ambient owner.
    expect(
      hostIdentityFallsBackToExplicitOwner("codex", resolveHookHostIdentity("codex", {})),
    ).toBe(false);
  });

  it("names each provider's identity source", () => {
    expect(hookHostIdentitySource("grok")).toEqual({
      kind: "host-env",
      variable: "GROK_SESSION_ID",
    });
    expect(hookHostIdentitySource("cursor")).toEqual({
      kind: "payload",
      field: "conversation_id",
    });
    expect(hookHostIdentitySource("openclaw")).toBeNull();
  });

  it("keeps the canonical owner pattern coupled to the provider list", () => {
    // A provider whose ids the rewrite bridge rejects can never bind its own
    // claim, which is the drift that left Grok denied by its own lease.
    expect(
      rewriteExactLifecycleCommand(
        { tool_name: "Bash", tool_input: { command: "deft session:start" } },
        GROK_SESSION_ID,
      ),
    ).toMatchObject({
      kind: "rewrite",
      verb: "session:start",
      rewrittenCommand: `deft session:start --session-id=${GROK_SESSION_ID}`,
    });
    expect(
      rewriteExactLifecycleCommand(
        { tool_name: "Bash", tool_input: { command: "deft session:start" } },
        "host:openclaw:v1:Z3Jvay1vd25lcg",
      ),
    ).toBeNull();
  });
});

describe("rewriteExactLifecycleCommand (#3611)", () => {
  it("distinguishes absent, explicit, and invalid lifecycle session arguments", () => {
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:start --rearm" },
      }),
    ).toMatchObject({ verb: "session:start", sessionIdStatus: "absent", sessionId: null });
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:start --session-id=manual-owner" },
      }),
    ).toMatchObject({
      verb: "session:start",
      sessionIdStatus: "present",
      sessionId: "manual-owner",
    });
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:start --session-id=" },
      }),
    ).toMatchObject({ verb: "session:start", sessionIdStatus: "invalid", sessionId: null });
  });

  it("recognizes unsafe lifecycle shapes without treating swallowed owner tokens as effective", () => {
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: {
          command: `deft session:start --project-root --session-id=${CODEX_SESSION_ID}`,
        },
      }),
    ).toMatchObject({
      verb: "session:start",
      rewriteSafe: false,
      sessionIdStatus: "absent",
      sessionId: null,
    });
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft swarm-launch --paths xbrief/active/story.xbrief.json" },
      }),
    ).toMatchObject({ verb: "swarm:launch", rewriteSafe: false, sessionIdStatus: "absent" });
  });

  it("does not auto-approve or require an owner for read-only session alignment", () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "deft session:start --read-only" },
    };
    expect(inspectExactLifecycleCommand(payload)).toMatchObject({
      verb: "session:start",
      requiresOwner: false,
    });
    expect(rewriteExactLifecycleCommand(payload, CODEX_SESSION_ID)).toBeNull();
    expect(
      inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:start --occupant --read-only" },
      }),
    ).toMatchObject({ requiresOwner: true, rewriteSafe: false });
  });

  it.each([
    ["deft session:start", "session:start"],
    ["directive occupancy:release", "occupancy:release"],
    ["deft swarm-launch", "swarm:launch"],
    ["task occupancy:heartbeat", "occupancy:heartbeat"],
    ["task swarm:launch -- --stories 3611", "swarm:launch"],
    [`task session:ready -- --session-id=${CODEX_SESSION_ID}`, "session:ready"],
  ] as const)("classifies exact lifecycle command %j as %s", (command, verb) => {
    expect(exactLifecycleCommandVerb({ tool_name: "Shell", tool_input: { command } })).toBe(verb);
  });

  it.each([
    { tool_name: "Write", tool_input: { command: "deft session:start" } },
    { tool_name: "Bash", tool_input: { command: "deft session:start && echo unsafe" } },
    { tool_name: "Bash", tool_input: { command: "deft swarm:launch" } },
    { tool_name: "Bash", tool_input: { command: "task swarm-launch" } },
  ])("does not classify non-exact lifecycle payload $tool_name", (payload) => {
    expect(exactLifecycleCommandVerb(payload)).toBeNull();
  });

  it("preserves the complete tool input while appending identity to a direct CLI command", () => {
    const toolInput = {
      command: "deft session:start --rearm",
      description: "Re-arm the mutation session",
      timeout: 120_000,
      run_in_background: false,
      metadata: { source: "model" },
    };
    const payload = { tool_name: "Bash", tool_input: toolInput };

    const result = rewriteExactLifecycleCommand(payload, CODEX_SESSION_ID);

    expect(result).toEqual({
      kind: "rewrite",
      verb: "session:start",
      originalCommand: "deft session:start --rearm",
      rewrittenCommand: "deft session:start --rearm --session-id=host:codex:v1:c2Vzc2lvbi1B",
      updatedInput: {
        ...toolInput,
        command: "deft session:start --rearm --session-id=host:codex:v1:c2Vzc2lvbi1B",
      },
    });
    expect(payload.tool_input).toEqual(toolInput);
    expect(payload.tool_input.command).toBe("deft session:start --rearm");
  });

  it.each([
    "session:start",
    "session:ready",
    "session:end",
    "occupancy:steal",
    "occupancy:release",
    "occupancy:heartbeat",
  ])("rewrites the exact directive lifecycle verb %s", (verb) => {
    const result = rewriteExactLifecycleCommand(
      { tool_name: "Shell", tool_input: { command: `directive ${verb}` } },
      CODEX_SESSION_ID,
    );
    expect(result).toMatchObject({
      kind: "rewrite",
      verb,
      rewrittenCommand: `directive ${verb} --session-id=${CODEX_SESSION_ID}`,
    });
  });

  it.each([
    "deft",
    "directive",
  ])("maps the direct %s swarm-launch command to logical swarm:launch", (executable) => {
    const result = rewriteExactLifecycleCommand(
      { tool_name: "Shell", tool_input: { command: `${executable} swarm-launch` } },
      CODEX_SESSION_ID,
    );
    expect(result).toMatchObject({
      kind: "rewrite",
      verb: "swarm:launch",
      rewrittenCommand: `${executable} swarm-launch --session-id=${CODEX_SESSION_ID}`,
    });
  });

  it("keeps the canonical task swarm:launch spelling", () => {
    const result = rewriteExactLifecycleCommand(
      { tool_name: "Shell", tool_input: { command: "task swarm:launch -- --stories 3611" } },
      CODEX_SESSION_ID,
    );
    expect(result).toMatchObject({
      kind: "rewrite",
      verb: "swarm:launch",
      rewrittenCommand: `task swarm:launch -- --stories 3611 --session-id=${CODEX_SESSION_ID}`,
    });
  });

  it("adds the task forwarding separator when the canonical task has no arguments", () => {
    const result = rewriteExactLifecycleCommand(
      { tool_name: "Shell", tool_input: { command: "task session:ready", cwd: "/repo" } },
      CODEX_SESSION_ID,
    );
    expect(result).toMatchObject({
      kind: "rewrite",
      rewrittenCommand: `task session:ready -- --session-id=${CODEX_SESSION_ID}`,
      updatedInput: {
        command: `task session:ready -- --session-id=${CODEX_SESSION_ID}`,
        cwd: "/repo",
      },
    });
  });

  it("appends after existing canonical task forwarded arguments", () => {
    const result = rewriteExactLifecycleCommand(
      {
        tool_name: "Bash",
        tool_input: {
          command: "task occupancy:steal -- --confirm --occupant old-owner",
          timeout: 30_000,
        },
      },
      CODEX_SESSION_ID,
    );
    expect(result).toMatchObject({
      kind: "rewrite",
      verb: "occupancy:steal",
      rewrittenCommand:
        `task occupancy:steal -- --confirm --occupant old-owner ` +
        `--session-id=${CODEX_SESSION_ID}`,
    });
  });

  it.each([
    "deft session:start && echo pwned",
    "deft session:start; echo pwned",
    "deft session:start | tee output",
    "deft session:start > output",
    "deft session:start\necho pwned",
    "deft session:start @sessionArgs",
    "deft session:start %SESSION_ARGS%",
    "npx deft session:start",
    "./deft session:start",
    "deft doctor",
    "deft swarm:launch",
    "directive swarm:launch",
    "task swarm-launch",
    "task session:start --rearm",
    "task session:start -- --defer 'cache fresh'",
    "deft session:start --project-root /tmp/other",
    "deft session:ready --unknown-flag",
    `deft session:start --defer --session-id=${CODEX_SESSION_ID}`,
    "deft occupancy:release --project-root=/tmp/other",
    "deft swarm-launch --stories 3611 --output /tmp/auto-approved-write.json",
    "deft swarm-launch --stories 3611 --worktree-map /tmp/map.json",
    "deft swarm-launch --stories xbrief/active/3611.xbrief.json",
    "deft swarm-launch --stories=/tmp/3611.xbrief.json",
    "task swarm:launch -- --stories 3611,/tmp/3612.xbrief.json",
    "deft swarm-launch --stories 3611 --no-audit",
    `deft swarm-launch --operator-approval --session-id=${CODEX_SESSION_ID}`,
    "deft swarm-launch --stories 3611 --operator-approval --no-create-worktrees",
    "deft session:ready --repo --with-network",
    "deft session:start --occupant --read-only",
    "task swarm:launch -- --max-depth 2",
  ])("refuses compound, aliased, ambiguous, or non-lifecycle command %j", (command) => {
    expect(
      rewriteExactLifecycleCommand(
        { tool_name: "Bash", tool_input: { command, untouched: true } },
        CODEX_SESSION_ID,
      ),
    ).toBeNull();
  });

  it.each([
    [String.raw`deft session:start --project-root C:\repo`, "session:start"],
    [String.raw`deft swarm-launch --stories xbrief\active\3611.xbrief.json`, "swarm:launch"],
  ])("inspects Windows path form %j but keeps it outside auto-rewrite", (command, verb) => {
    const payload = { tool_name: "Shell", tool_input: { command } };
    expect(inspectExactLifecycleCommand(payload)).toMatchObject({
      verb,
      rewriteSafe: false,
      requiresOwner: true,
      sessionIdStatus: "absent",
    });
    expect(rewriteExactLifecycleCommand(payload, CODEX_SESSION_ID)).toBeNull();
  });

  it("does not rewrite a lifecycle-looking command carried by a non-shell tool", () => {
    expect(
      rewriteExactLifecycleCommand(
        { tool_name: "Write", tool_input: { command: "deft session:start" } },
        CODEX_SESSION_ID,
      ),
    ).toBeNull();
  });

  it("returns null when the exact command already carries the matching identity", () => {
    expect(
      rewriteExactLifecycleCommand(
        {
          tool_name: "Bash",
          tool_input: { command: `deft session:start --session-id=${CODEX_SESSION_ID}` },
        },
        CODEX_SESSION_ID,
      ),
    ).toBeNull();
  });

  it("reports an explicit identity conflict instead of replacing it", () => {
    expect(
      rewriteExactLifecycleCommand(
        {
          tool_name: "Bash",
          tool_input: { command: "deft session:start --session-id=host:codex:v1:b3RoZXI" },
        },
        CODEX_SESSION_ID,
      ),
    ).toEqual({
      kind: "conflict",
      verb: "session:start",
      existingSessionId: "host:codex:v1:b3RoZXI",
      requestedSessionId: CODEX_SESSION_ID,
      message:
        "Lifecycle command session:start already names a different --session-id; refusing rewrite.",
    });
  });

  it("refuses a non-canonical or shell-unsafe requested identity", () => {
    expect(
      rewriteExactLifecycleCommand(
        { tool_name: "Bash", tool_input: { command: "deft session:start" } },
        "owner; echo pwned",
      ),
    ).toBeNull();
  });
});
