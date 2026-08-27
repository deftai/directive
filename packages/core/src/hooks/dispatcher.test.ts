import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_AUTHORITY_POLICY } from "../policy/runtime-authority.js";
import {
  applyWorktreeOccupancy,
  OCCUPANCY_MAX_LEASE_MS,
  OCCUPANCY_STALE_WARN_MS,
  occupancyPath,
  readOccupancy,
} from "../session/occupancy.js";
import { ritualStatePath } from "../session/ritual-sentinel.js";
import { fixtureCaseById, fixtureCasesFor, HOOK_FIXTURE_CASES } from "./fixtures/index.js";
import {
  ASSIST_SESSION_POSTURE_ENV,
  DIRECT_WRITE_TOOL_NAMES,
  decideHook,
  type HookPolicySeams,
  hookPayloadTopLevelKeys,
  hookShellCommand,
  hookToolName,
  hookWriteTargetPath,
  isAllowlistedAssistScratchPath,
  isAssistScratchWrite,
  isDirectWriteTool,
  isHookEvent,
  isHookHost,
  isLexicalOutsideProjectRoot,
  isMcpTool,
  isOutsideProjectRootWrite,
  isProposedLifecycleWrite,
  isShellTool,
  isSpawnTool,
  normalizeHookProjectRoot,
  projectRootFromHookPayload,
  READ_ONLY_HOOK_ENV,
  renderHostDecision,
  SPAWN_TOOL_NAMES,
} from "./index.js";

// Symlinks require elevated privileges on Windows (SeCreateSymbolicLink); skip there.
const itSymlink = it.skipIf(process.platform === "win32");
const hookTemps: string[] = [];
afterEach(() => {
  for (const t of hookTemps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function hasDoubledWindowsDrivePrefix(path: string): boolean {
  return /^[A-Za-z]:\\[A-Za-z]:\\/i.test(path.replace(/\//g, "\\"));
}

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
    ...(overrides.inspectRitual ? {} : { verifyRitual: () => READY_RITUAL }),
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    ...overrides,
  };
}

/**
 * Shell dest-form enforcement is opt-in (#3438 / #3594): `readySeams` keeps the
 * production default (`shellDestForms: "off"`), so any test asserting a
 * dest-form verdict must enable it explicitly. Kept separate rather than folded
 * into `readySeams` so the opt-in is visible at every call site.
 */
function enforcingSeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return readySeams({
    loadRuntimeAuthority: () => ({
      ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
      shellDestForms: "enforce" as const,
    }),
    ...overrides,
  });
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
    expect(decision.message).toContain("deft session:ready");
    expect(decision.message).toContain("one-shot");
  });

  it("denies a product-path write when another live session occupies the tree (#3433)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-occ-"));
    hookTemps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    applyWorktreeOccupancy(root, {
      sessionId: "owner",
      intent: "mutation",
    });
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Edit", file_path: join(root, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("Worktree occupied by session owner");
  });

  it("denies a capped holder's write but not the release it is told to run (#3599)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-occ-capped-"));
    hookTemps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    // A lease that kept beating until just now but was claimed past the
    // absolute cap. Written directly because reaching this state through the
    // lease API needs a day of wall-clock heartbeats.
    const nowMs = Date.now();
    writeFileSync(
      occupancyPath(root),
      `${JSON.stringify({
        schemaVersion: 1,
        session_id: "owner",
        worktree_path: resolve(root),
        intent: "mutation",
        claimed_at: new Date(nowMs - OCCUPANCY_MAX_LEASE_MS - 60_000).toISOString(),
        heartbeat_at: new Date(nowMs - 1_000).toISOString(),
        host: "test",
        address: "test",
        retain_capable: false,
        join_protocol: "none",
      })}\n`,
      "utf8",
    );

    const write = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Edit", file_path: join(root, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "owner" },
      },
      readySeams(),
    );
    expect(write).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(write.message).toContain("absolute age cap");

    // The capped holder is the first owner this gate ever denies, so the
    // remediation's "release and re-claim" has to stay reachable. Product
    // writes route through the occupancy gate; a plain lifecycle command is not
    // a dest form, so it never enters it. Pin that: if Shell gating ever widens
    // to cover these commands, the cap would deny the only way out of itself.
    for (const command of [
      "deft occupancy:release --session-id=owner",
      "deft session:start --session-id=owner",
    ]) {
      const wayOut = decideHook(
        {
          host: "grok",
          event: "tool.before",
          projectRoot: root,
          payload: { tool_name: "Bash", tool_input: { command } },
          environ: { DEFT_SESSION_ID: "owner" },
        },
        enforcingSeams(),
      );
      expect(wayOut.verdict, command).toBe("allow");
    }
  });

  it("composes occupancy deny with ritual-not-ready (#3433)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-occ-ritual-"));
    hookTemps.push(root);
    applyWorktreeOccupancy(root, {
      sessionId: "owner",
    });
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Write", file_path: join(root, "src", "app.ts") },
        environ: { DEFT_SESSION_ID: "other" },
      },
      readySeams({
        inspectRitual: () => ({
          ...READY_RITUAL,
          code: 1,
          message: "ritual state missing",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("Also ritual-not-ready");
  });

  it("allows a payload-bound Codex owner when host, lease, and exact ritual state agree (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-owner-"));
    hookTemps.push(root);
    const sessionId = "host:codex:v1:c2Vzc2lvbi1h";
    applyWorktreeOccupancy(root, { sessionId });

    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "apply_patch",
          session_id: "session-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: sessionId }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("an allowed write renews the owner's lease instead of warning about it (#3599)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-occ-refresh-"));
    hookTemps.push(root);
    const sessionId = "host:codex:v1:c2Vzc2lvbi1h";
    const claimedAt = new Date(Date.now() - OCCUPANCY_STALE_WARN_MS - 1_000);
    applyWorktreeOccupancy(root, { sessionId, now: claimedAt });

    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "apply_patch",
          session_id: "session-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: sessionId }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    // The lease entered this call inside the staleness window, and this call
    // renewed it. Appending "your lease is going stale, run occupancy:heartbeat"
    // would name a state the same write already resolved.
    expect(decision.message).not.toContain("occupancy:heartbeat --session-id=");
    expect(decision.message).not.toContain("has not beaten");
    const record = readOccupancy(root);
    expect(record?.sessionId).toBe(sessionId);
    expect(record?.heartbeatAt.getTime()).toBeGreaterThan(claimedAt.getTime());
    expect(record?.lastWriteAt).not.toBeNull();
  });

  it("denies missing or conflicting host identity while a lease is live (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-missing-"));
    hookTemps.push(root);
    const sessionId = "host:codex:v1:c2Vzc2lvbi1h";
    applyWorktreeOccupancy(root, { sessionId });
    const seams = readySeams({
      verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: sessionId }),
    });
    const base = {
      host: "codex" as const,
      event: "tool.before" as const,
      projectRoot: root,
      payload: {
        tool_name: "apply_patch",
        tool_input: { file_path: join(root, "src", "app.ts") },
      },
    };

    expect(decideHook({ ...base, environ: {} }, seams)).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });
    expect(
      decideHook(
        {
          ...base,
          payload: { ...base.payload, session_id: "session-a" },
          environ: { DEFT_SESSION_ID: "host:codex:v1:Zm9yZWlnbg" },
        },
        seams,
      ),
    ).toMatchObject({ verdict: "deny", code: "occupancy-identity-conflict" });
    expect(
      decideHook(
        {
          ...base,
          payload: { ...base.payload, session_id: "session-b" },
          environ: {},
        },
        seams,
      ),
    ).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });

  it("denies a verified ritual owner mismatch even when payload and lease agree (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-ritual-mismatch-"));
    hookTemps.push(root);
    const sessionId = "host:claude:v1:c2Vzc2lvbi1h";
    applyWorktreeOccupancy(root, { sessionId });

    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "Write",
          session_id: "session-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => ({
          ...READY_RITUAL,
          boundSessionId: "host:claude:v1:c2Vzc2lvbi1i",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-ritual-mismatch" });
  });

  it("reports ritual-not-ready for a stale matching owner instead of occupancy denial (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-stale-"));
    hookTemps.push(root);
    const sessionId = "host:cursor:v1:Y29udmVyc2F0aW9uLWE";
    applyWorktreeOccupancy(root, { sessionId });

    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "Write",
          conversation_id: "conversation-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => ({
          ...READY_RITUAL,
          code: 1,
          message: "ritual state is stale",
          recoveryTier: "rearm",
          boundSessionId: sessionId,
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
  });

  it("denies the old hook when ownership changes after its exact ritual state was evaluated (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-owner-race-"));
    hookTemps.push(root);
    const ownerA = "host:codex:v1:c2Vzc2lvbi1h";
    const ownerB = "host:codex:v1:c2Vzc2lvbi1i";
    applyWorktreeOccupancy(root, { sessionId: ownerA });

    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "apply_patch",
          session_id: "session-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => {
          const changed = applyWorktreeOccupancy(root, {
            sessionId: ownerB,
            steal: true,
            confirm: true,
            occupant: ownerA,
          });
          expect(changed.code).toBe(0);
          return { ...READY_RITUAL, boundSessionId: ownerA };
        },
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });

  it("rechecks occupancy after scope/authz work before allowing the old owner (#3611)", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-host-final-owner-race-"));
    hookTemps.push(root);
    const ownerA = "host:codex:v1:c2Vzc2lvbi1h";
    const ownerB = "host:codex:v1:c2Vzc2lvbi1i";
    applyWorktreeOccupancy(root, { sessionId: ownerA });

    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "apply_patch",
          session_id: "session-a",
          tool_input: { file_path: join(root, "src", "app.ts") },
        },
        environ: {},
      },
      readySeams({
        verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: ownerA }),
        inspectScope: () => {
          const changed = applyWorktreeOccupancy(root, {
            sessionId: ownerB,
            steal: true,
            confirm: true,
            occupant: ownerA,
          });
          expect(changed.code).toBe(0);
          return { ready: true, path: "xbrief/active/story.xbrief.json", message: "ready" };
        },
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("occupancy changed while mutation gates were running");
  });

  it("refreshes hook readiness at every mutation dispatch", () => {
    const verifyRitual = vi
      .fn<HookPolicySeams["verifyRitual"]>()
      .mockReturnValueOnce(READY_RITUAL)
      .mockReturnValueOnce({
        ...READY_RITUAL,
        code: 1,
        message: "session ritual gated step 'agent_hooks' failed: shim drifted",
      });
    const seams = readySeams({ verifyRitual });
    const input = {
      host: "grok" as const,
      event: "tool.before" as const,
      projectRoot: "/project",
      payload: { toolName: "Edit", workspaceRoot: "/project" },
    };

    expect(decideHook(input, seams)).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(decideHook(input, seams)).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(verifyRitual).toHaveBeenCalledTimes(2);
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
    expect(decision.message).toMatch(/direct-write/);
    expect(decision.message).toMatch(/spawn/);
    expect(decision.message).toMatch(/not this deny/);
  });

  it("allows Write outside projectRoot when no active scope (#2885)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          cwd: "/project",
          tool_input: {
            file_path: "/home/user/.claude/projects/slug/memory/note.md",
          },
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

    expect(decision.verdict).toBe("allow");
    expect(decision.code).not.toBe("scope-not-ready");
  });

  it("allows Edit outside projectRoot when no active scope (#2885)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Edit",
          tool_input: { path: "/tmp/agent-scratch/note.md" },
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

    expect(decision.verdict).toBe("allow");
    expect(decision.code).not.toBe("scope-not-ready");
  });

  it("denies unparseable Write target when no active scope (fail-closed, #2885)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          cwd: "/project",
          // No extractable path — must not skip the gate via unparseable payload.
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
  });

  it("does not treat in-repo '..'-prefixed filenames as outside root (#2885)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          cwd: "/project",
          tool_input: { file_path: "/project/..secret" },
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
  });

  it("classifies lexical outside-root shapes for #2885", () => {
    expect(isLexicalOutsideProjectRoot("..")).toBe(true);
    expect(isLexicalOutsideProjectRoot("../tmp/x")).toBe(true);
    expect(isLexicalOutsideProjectRoot("..secret")).toBe(false);
    expect(isLexicalOutsideProjectRoot("src/foo.ts")).toBe(false);
    // Drive-letter relatives are outside only on win32 (cross-drive path.relative).
    // On POSIX, `D:/tmp/x` is a valid in-project child path segment.
    expect(isLexicalOutsideProjectRoot("D:/tmp/x")).toBe(process.platform === "win32");
  });

  it("denies in-repo drive-like POSIX child path without active scope (#2885)", () => {
    if (process.platform === "win32") return;
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          cwd: "/project",
          tool_input: { file_path: "/project/D:/tmp/x" },
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
  });

  itSymlink("denies outside-root symlink that re-enters the project (#2885)", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "hook-2885-proj-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "hook-2885-out-"));
    hookTemps.push(projectDir, outsideDir);
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "inside.ts"), "inside", "utf8");
    // Lexically outside path aliases into project via dir symlink.
    symlinkSync(join(projectDir, "src"), join(outsideDir, "alias"), "dir");
    const aliasedTarget = join(outsideDir, "alias", "inside.ts");

    expect(isOutsideProjectRootWrite(projectDir, aliasedTarget)).toBe(false);

    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: projectDir,
        payload: {
          tool_name: "Write",
          cwd: projectDir,
          tool_input: { file_path: aliasedTarget },
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
  });

  it("still denies spawn when no active scope even without a write target (#2885)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
        },
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active/running xBRIEF is available.",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });

  describe("assist scratch writes (#1802)", () => {
    const noScopeSeams = (): HookPolicySeams =>
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active xBRIEF artifact was found under xbrief/active/",
        }),
        inspectRitual: () => ({
          ...READY_RITUAL,
          code: 1,
          message: "ritual state missing",
        }),
      });

    it("classifies allowlisted scratch roots and rejects tracked paths", () => {
      expect(isAllowlistedAssistScratchPath("/project", ".deft-scratch/notes.md")).toBe(true);
      expect(isAllowlistedAssistScratchPath("/project", "/project/.deft-scratch/a/b.md")).toBe(
        true,
      );
      expect(isAllowlistedAssistScratchPath("/project", "temp/overview/x.md")).toBe(true);
      expect(
        isAllowlistedAssistScratchPath("/project", "packages/core/src/hooks/dispatcher.ts"),
      ).toBe(false);
      expect(isAllowlistedAssistScratchPath("/project", "src/a.ts")).toBe(false);
      expect(isAllowlistedAssistScratchPath("/project", "overview/notes.md")).toBe(false);
      expect(isAllowlistedAssistScratchPath("/project", null)).toBe(false);
      expect(isAllowlistedAssistScratchPath("/project", ".deft-scratch/../src/a.ts")).toBe(false);
    });

    it("requires assist/ephemeral classification with scratch path (fail closed without)", () => {
      expect(
        isAssistScratchWrite("/project", ".deft-scratch/notes.md", {
          tool_input: { worker_role: "assist" },
        }),
      ).toBe(true);
      expect(
        isAssistScratchWrite(
          "/project",
          ".deft-scratch/notes.md",
          {},
          { [ASSIST_SESSION_POSTURE_ENV]: "assist" },
        ),
      ).toBe(true);
      expect(
        isAssistScratchWrite("/project", ".deft-scratch/notes.md", {
          tool_input: { worker_role: "ephemeral" },
        }),
      ).toBe(true);
      // Path alone without posture markers → mutation path (fail closed).
      expect(isAssistScratchWrite("/project", ".deft-scratch/notes.md", {})).toBe(false);
      // Assist without allowlisted path → false (tracked stays hard).
      expect(
        isAssistScratchWrite("/project", "packages/core/src/a.ts", {
          tool_input: { worker_role: "assist" },
        }),
      ).toBe(false);
      // Free-text NLP alone is not classification.
      expect(
        isAssistScratchWrite("/project", ".deft-scratch/notes.md", {
          tool_input: { prompt: "for Obsidian do not commit" },
        }),
      ).toBe(false);
    });

    it("allows Write under .deft-scratch/ with assist posture without active scope or ritual", () => {
      const inspectScope = vi.fn(() => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }));
      const inspectRitual = vi.fn(() => ({
        ...READY_RITUAL,
        code: 1,
        message: "ritual state missing",
      }));
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            cwd: "/project",
            posture: "assist",
            tool_input: { file_path: "/project/.deft-scratch/notes.md" },
          },
        },
        readySeams({ inspectScope, inspectRitual }),
      );

      expect(decision).toMatchObject({
        verdict: "allow",
        code: "write-assist-scratch-ready",
      });
      expect(inspectScope).not.toHaveBeenCalled();
      expect(inspectRitual).not.toHaveBeenCalled();
    });

    it("allows Write under temp/ with ephemeral worker_role without active scope", () => {
      const decision = decideHook(
        {
          host: "cursor",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            tool_input: {
              path: "temp/research/overview.md",
              worker_role: "ephemeral",
            },
          },
        },
        noScopeSeams(),
      );

      expect(decision).toMatchObject({
        verdict: "allow",
        code: "write-assist-scratch-ready",
      });
    });

    it("allows Write under .deft-scratch/ with DEFT_SESSION_POSTURE=assist", () => {
      const decision = decideHook(
        {
          host: "grok",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            toolName: "Edit",
            tool_input: { path: ".deft-scratch/obsidian/note.md" },
          },
          environ: { [ASSIST_SESSION_POSTURE_ENV]: "assist" },
        },
        noScopeSeams(),
      );

      expect(decision).toMatchObject({
        verdict: "allow",
        code: "write-assist-scratch-ready",
      });
    });

    it("denies tracked product Write even with assist markers (AC5)", () => {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            posture: "assist",
            tool_input: {
              file_path: "/project/packages/core/src/hooks/dispatcher.ts",
              worker_role: "assist",
            },
          },
        },
        noScopeSeams(),
      );

      expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    });

    it("denies tracked product Write without active scope (no assist marker)", () => {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            tool_input: {
              file_path: "/project/packages/core/src/hooks/dispatcher.ts",
            },
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
      expect(decision.message).toContain(".deft-scratch");
      expect(decision.message).toMatch(/scope:activate|assist/i);
    });

    it("fails closed on ambiguous non-scratch Write without assist marker", () => {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            // Operator said "for Obsidian" in free text only — not a structural marker.
            tool_input: {
              file_path: "/project/overview/notes.md",
              prompt: "for Obsidian, do not commit",
            },
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
    });

    it("fails closed when scratch path has no assist/ephemeral classification", () => {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            tool_input: { file_path: "/project/.deft-scratch/notes.md" },
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

      // Path alone is not enough — need assist/ephemeral structural classification.
      expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    });

    it("still denies assist scratch Write under read-only posture", () => {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Write",
            posture: "assist",
            tool_input: { file_path: ".deft-scratch/notes.md" },
          },
          environ: { [READ_ONLY_HOOK_ENV]: "1" },
        },
        noScopeSeams(),
      );

      expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
    });

    itSymlink(
      "refuses assist scratch when .deft-scratch is a symlink outside project (#3186)",
      () => {
        const project = mkdtempSync(join(tmpdir(), "assist-scratch-proj-"));
        const outside = mkdtempSync(join(tmpdir(), "assist-scratch-out-"));
        hookTemps.push(project, outside);
        symlinkSync(outside, join(project, ".deft-scratch"));

        expect(isAllowlistedAssistScratchPath(project, ".deft-scratch/notes.md")).toBe(false);
        expect(
          isAssistScratchWrite(project, ".deft-scratch/notes.md", {
            tool_input: { worker_role: "assist" },
          }),
        ).toBe(false);

        const decision = decideHook(
          {
            host: "claude",
            event: "tool.before",
            projectRoot: project,
            payload: {
              tool_name: "Write",
              posture: "assist",
              tool_input: { file_path: join(project, ".deft-scratch", "notes.md") },
            },
          },
          noScopeSeams(),
        );
        // Falls through mutation gates (no active scope) — not write-assist-scratch-ready.
        expect(decision.verdict).toBe("deny");
        expect(decision.code).not.toBe("write-assist-scratch-ready");
      },
    );

    it("allows real contained .deft-scratch directory under assist posture (#3186 non-regression)", () => {
      const project = mkdtempSync(join(tmpdir(), "assist-scratch-real-"));
      hookTemps.push(project);
      mkdirSync(join(project, ".deft-scratch"), { recursive: true });

      expect(isAllowlistedAssistScratchPath(project, ".deft-scratch/notes.md")).toBe(true);

      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: project,
          payload: {
            tool_name: "Write",
            posture: "assist",
            tool_input: { file_path: join(project, ".deft-scratch", "notes.md") },
          },
        },
        noScopeSeams(),
      );
      expect(decision).toMatchObject({
        verdict: "allow",
        code: "write-assist-scratch-ready",
      });
    });
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

  it("allows ApplyPatch of xbrief/proposed/*.xbrief.json with no active scope (#2738)", () => {
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "ApplyPatch",
          tool_input: {
            path: "xbrief/proposed/2026-07-17-story.xbrief.json",
            patch: "*** Begin Patch\n*** Add File: x\n+probe\n*** End Patch",
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

  it("distinguishes empty stdin from unknown-shape Cursor denies (#2669 / #2864)", () => {
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
    expect(emptyStdin).toMatchObject({ verdict: "deny", code: "stdin-empty" });
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
    expect(parseFailed).toMatchObject({ verdict: "deny", code: "invalid-input" });
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
    expect(unknownShape).toMatchObject({ verdict: "deny", code: "invalid-input" });
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
      hookToolName(
        { tool_name: "ApplyPatch", tool_input: { path: "src/a.ts", patch: "*** Begin Patch" } },
        "cursor",
      ),
    ).toBe("ApplyPatch");
    expect(hookToolName({ tool_input: { path: "src/a.ts", patch: "diff" } }, "cursor")).toBe(
      "ApplyPatch",
    );
    expect(hookToolName({ tool_input: { path: "src/a.ts", unified_diff: "diff" } }, "cursor")).toBe(
      "ApplyPatch",
    );
    expect(hookToolName({ tool_input: { path: "src/a.ts", diff: "diff" } }, "cursor")).toBe(
      "ApplyPatch",
    );
    expect(hookToolName({ tool_input: { path: "a.ts", edits: [] } }, "cursor")).toBe("MultiEdit");
    expect(hookToolName({ tool_input: { cell_id: "cell-1" } }, "cursor")).toBe("NotebookEdit");
    expect(
      hookWriteTargetPath({
        tool_name: "ApplyPatch",
        tool_input: { path: "xbrief/proposed/a.xbrief.json", patch: "patch" },
      }),
    ).toBe("xbrief/proposed/a.xbrief.json");
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
    expect(decision.message).toContain(
      "Directive SessionStart bookkeeping reported exit 2 on its non-blocking path: no active scope",
    );
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
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
    expect(decision.message).toContain(
      "Directive SessionStart bookkeeping reported exit 1 on its non-blocking path.",
    );
    // Soft AGENTS re-bind still surfaces on degraded SessionStart (#3171).
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
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
    expect(decision.message).toContain(
      "Directive SessionStart bookkeeping failed on its non-blocking path: Error: read-only bookkeeping failed",
    );
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
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
    expect(decision.message).toContain(
      "SessionStart bookkeeping completed on a non-blocking path.",
    );
    // Soft cue on SessionStart without requiring a write tool (#3171 / Codex best-effort).
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
    expect(decision.message).toContain("Operational-ask trap");
  });

  it("skips SessionStart bookkeeping when .no-deft-directive is present (#2926)", () => {
    const sessionStart = vi.fn(() => {
      throw new Error("sessionStart must not run under opt-out");
    });
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart,
        detectDeftDirectiveDisable: () => ({
          present: false,
          flagPath: "/project/.deft-directive-disable",
          depositPresent: false,
          trackedByGit: false,
          active: false,
        }),
        detectNoDeftDirective: () => ({
          present: true,
          flagPath: "/project/.no-deft-directive",
          depositPresent: false,
          inconsistent: false,
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-disabled" });
    expect(decision.message).toContain("Directive disabled via `.no-deft-directive`");
    expect(sessionStart).not.toHaveBeenCalled();
  });

  it("skips SessionStart when local kill-switch is active even with deposit (#3039)", () => {
    const sessionStart = vi.fn(() => {
      throw new Error("sessionStart must not run under kill-switch");
    });
    const markCompactStale = vi.fn(() => {
      throw new Error("compact must not run under kill-switch");
    });
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart,
        markCompactStale,
        detectDeftDirectiveDisable: () => ({
          present: true,
          flagPath: "/project/.deft-directive-disable",
          depositPresent: true,
          trackedByGit: false,
          active: true,
        }),
        detectNoDeftDirective: () => ({
          present: false,
          flagPath: "/project/.no-deft-directive",
          depositPresent: true,
          inconsistent: false,
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-disabled" });
    expect(decision.message).toContain(".deft-directive-disable");
    expect(decision.message).toContain("NEW agent session");
    expect(decision.message).toContain("Deposit may still be present");
    expect(sessionStart).not.toHaveBeenCalled();
  });

  it("does not bypass gates when kill-switch flag is tracked by git (#3039)", () => {
    const sessionStart = vi.fn(() => ({ code: 0, stdout: "ok\n", stderr: "" }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart,
        detectDeftDirectiveDisable: () => ({
          present: true,
          flagPath: "/project/.deft-directive-disable",
          depositPresent: true,
          trackedByGit: true,
          active: false,
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-start" });
    expect(sessionStart).toHaveBeenCalled();
  });

  it("short-circuits PreToolUse and compact under active kill-switch (#3039)", () => {
    const markCompactStale = vi.fn(() => {
      throw new Error("compact must not run under kill-switch");
    });
    const killSeams = readySeams({
      markCompactStale,
      detectDeftDirectiveDisable: () => ({
        present: true,
        flagPath: "/project/.deft-directive-disable",
        depositPresent: true,
        trackedByGit: false,
        active: true,
      }),
    });

    const compact = decideHook(
      {
        host: "cursor",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      killSeams,
    );
    expect(compact).toMatchObject({ verdict: "allow", code: "directive-disabled" });
    expect(markCompactStale).not.toHaveBeenCalled();

    const tool = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Write", tool_input: { path: "/project/x.ts" } },
      },
      killSeams,
    );
    expect(tool).toMatchObject({ verdict: "allow", code: "directive-disabled" });
    expect(tool.message).toContain("rm .deft-directive-disable");
  });

  it("combines kill-switch and permanent opt-out messages when both flags present (#3039)", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart: vi.fn(() => ({ code: 0, stdout: "", stderr: "" })),
        detectDeftDirectiveDisable: () => ({
          present: true,
          flagPath: "/project/.deft-directive-disable",
          depositPresent: true,
          trackedByGit: false,
          active: true,
        }),
        detectNoDeftDirective: () => ({
          present: true,
          flagPath: "/project/.no-deft-directive",
          depositPresent: true,
          inconsistent: true,
        }),
      }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.message).toContain(".deft-directive-disable");
    expect(decision.message).toContain(".no-deft-directive");
  });

  it("skips SessionStart bookkeeping on inconsistent opt-out without blocking (#2926)", () => {
    const sessionStart = vi.fn(() => ({ code: 0, stdout: "", stderr: "" }));
    const decision = decideHook(
      {
        host: "grok",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({
        sessionStart,
        detectDeftDirectiveDisable: () => ({
          present: false,
          flagPath: "/project/.deft-directive-disable",
          depositPresent: true,
          trackedByGit: false,
          active: false,
        }),
        detectNoDeftDirective: () => ({
          present: true,
          flagPath: "/project/.no-deft-directive",
          depositPresent: true,
          inconsistent: true,
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "session-start-disabled" });
    expect(decision.message).toContain("Inconsistent state");
    expect(sessionStart).not.toHaveBeenCalled();
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
    // Soft checklist appended; hard re-arm message retained (#3171).
    expect(decision.message).toContain("Marked session ritual stale after context compaction.");
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
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
    // Soft still surfaces when ritual was absent (#3171).
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
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
    expect(decision.message).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
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

  it("denies implementation Task spawns without mutation gates (#1185)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
        },
      },
      readySeams({
        inspectRitual,
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active/running xBRIEF is available.",
        }),
      }),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(inspectRitual).toHaveBeenCalled();
  });

  it("allows Task spawns when both mutation gates pass (#1185)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "generalPurpose" } },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
  });

  it("allows explore Task spawns without implementation gates (#1185)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const inspectScope = vi.fn(() => READY_SCOPE);
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "explore" } },
      },
      readySeams({ inspectRitual, inspectScope }),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-explore-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("denies direct writes in read-only hook context (#1185)", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "Edit", capability_mode: "read-only" },
        environ: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
    expect(decision.message).toContain("read-only explore posture");
  });

  it("denies implementation spawns in read-only hook context (#1185)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "generalPurpose" } },
        environ: { [READ_ONLY_HOOK_ENV]: "1" },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
    expect(decision.message).toContain("implementation sub-agent spawns");
  });

  it("allows explore spawns in read-only hook context (#1185)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "explore" } },
        environ: { [READ_ONLY_HOOK_ENV]: "1" },
      },
      readySeams(),
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-explore-ready" });
  });
});

describe("ephemeral spawn posture (#3080)", () => {
  const emptyScopeSeams = (): HookPolicySeams =>
    readySeams({
      inspectRitual: vi.fn(() => READY_RITUAL),
      inspectScope: vi.fn(() => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      })),
    });

  it("allows explore Task without active xBRIEF (regression #1185 / AC1)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "explore" } },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-explore-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("denies unmarked generalPurpose Task when active scope empty (AC2 / AC6)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "implement feature" },
        },
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("scope:activate");
  });

  it("allows ephemeral worker_role Task without active xBRIEF (AC3)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { worker_role: "ephemeral", prompt: "one-sheet brochure" },
        },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ephemeral-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("allows docs and assist aliases without active xBRIEF (AC3)", () => {
    for (const role of ["docs", "assist"] as const) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Task", tool_input: { worker_role: role } },
        },
        emptyScopeSeams(),
      );
      expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ephemeral-ready" });
    }
  });

  it("deny message lists activate | explore | ephemeral recoveries (AC4)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "ship it" },
        },
        environ: {},
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("scope:activate");
    expect(decision.message).toMatch(/explore/i);
    expect(decision.message).toMatch(/ephemeral/i);
    expect(decision.message).toMatch(/Do not invent a fake scope/i);
  });

  it("deny recovery states free-text markers are not sufficient (#3259 AC4)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            subagent_type: "generalPurpose",
            prompt: "[worker_role: ephemeral] start local app",
          },
        },
        environ: {},
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toMatch(/NOT sufficient/i);
    expect(decision.message).toMatch(/DEFT_SESSION_POSTURE|DEFT_HOOK_ASSIST/);
    expect(decision.message).toMatch(/parent|Shell|docker compose|pnpm dev/i);
  });

  it("session assist env allows Task without active xBRIEF (#3259 AC3)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            subagent_type: "generalPurpose",
            prompt: "docker compose up && pnpm dev",
          },
        },
        environ: { DEFT_HOOK_ASSIST: "1" },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ephemeral-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("DEFT_SESSION_POSTURE assist allows Task without active xBRIEF (#3259 AC3)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "health check localhost" },
        },
        environ: { DEFT_SESSION_POSTURE: "assist" },
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ephemeral-ready" });
  });

  it("free-text only without assist env still denies (#3259 AC2)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            subagent_type: "generalPurpose",
            prompt: "[worker_role: ephemeral] start local AgentSentri",
          },
        },
        environ: {},
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });

  it("implement wins when ephemeral marker conflicts with drive-to merge-ready (AC6)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            worker_role: "ephemeral",
            drive_to: "merge-ready",
            prompt: "implement",
          },
        },
        environ: {},
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });

  it("implement wins when session assist env conflicts with drive-to (#3259 AC6)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: {
            subagent_type: "generalPurpose",
            drive_to: "merge-ready",
            prompt: "implement feature",
          },
        },
        environ: { DEFT_HOOK_ASSIST: "1" },
      },
      emptyScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });

  it("does not skip ritual/scope for implement spawn when gates ready (AC9)", () => {
    const inspectRitual = vi.fn(() => READY_RITUAL);
    const inspectScope = vi.fn(() => READY_SCOPE);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "generalPurpose" } },
        environ: {},
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(inspectRitual).toHaveBeenCalled();
    expect(inspectScope).toHaveBeenCalled();
  });
});

describe("runtime authority policy (#1394)", () => {
  const ENABLED_POLICY = {
    enabled: true,
    allowPaths: ["src/**", "xbrief/**"],
    denyPaths: [".env", "secrets/**"],
    scopes: { edits: true, push: false, merge: false },
  };

  function policySeams(
    policy: typeof ENABLED_POLICY,
    overrides: Partial<HookPolicySeams> = {},
  ): HookPolicySeams {
    return readySeams({
      loadRuntimeAuthority: () => policy,
      ...overrides,
    });
  }

  it("allows direct writes when runtime authority is disabled (default)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/docs/readme.md" },
        },
      },
      readySeams({ loadRuntimeAuthority: () => ({ ...ENABLED_POLICY, enabled: false }) }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("denies direct writes outside allowPaths when enabled", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { path: "/project/docs/readme.md", contents: "x" },
        },
      },
      policySeams(ENABLED_POLICY),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("allowPaths");
  });

  it("allows direct writes inside allowPaths when enabled", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/src/index.ts", contents: "x" },
        },
      },
      policySeams(ENABLED_POLICY),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("denies paths on denylist even when allowlist would permit", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/secrets/prod.env" },
        },
      },
      policySeams({ ...ENABLED_POLICY, allowPaths: ["**"] }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toContain("denyPaths");
  });

  it("denies when edits scope is false", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "Edit", tool_input: { file_path: "/project/src/a.ts" } },
      },
      policySeams({ ...ENABLED_POLICY, scopes: { edits: false, push: false, merge: false } }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-scope" });
  });

  it("ritual-not-ready fires before runtime authority path deny", () => {
    const loadRuntimeAuthority = vi.fn(() => ENABLED_POLICY);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/docs/outside.md" },
        },
      },
      policySeams(ENABLED_POLICY, {
        loadRuntimeAuthority,
        inspectRitual: () => ({ ...READY_RITUAL, code: 1, message: "stale ritual" }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(loadRuntimeAuthority).not.toHaveBeenCalled();
  });

  it("does not apply runtime authority to spawn tools", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "generalPurpose" } },
      },
      policySeams({ ...ENABLED_POLICY, scopes: { edits: false, push: false, merge: false } }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
  });

  it("does not change read-only deny behavior (#1185)", () => {
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "Edit", capability_mode: "read-only" },
        environ: {},
      },
      policySeams(ENABLED_POLICY),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
  });

  it("does not change session.compact re-arm (#2113)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      policySeams(ENABLED_POLICY, {
        markCompactStale: () => ({
          changed: true,
          statePath: "/project/.deft/ritual-state.json",
          message: "stale",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "session-compact-rearm" });
  });

  it("fail-opens when runtime authority policy load throws", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/docs/outside.md" },
        },
      },
      policySeams(ENABLED_POLICY, {
        loadRuntimeAuthority: () => {
          throw new Error("policy read failed");
        },
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("applies path policy to proposed lifecycle writes when enabled", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/xbrief/proposed/story.xbrief.json" },
        },
      },
      policySeams({ ...ENABLED_POLICY, allowPaths: ["src/**"] }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
  });

  it("intersects project allowPaths with story file_scope (#516 / #2443)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/src/index.ts", contents: "x" },
        },
      },
      policySeams(ENABLED_POLICY, {
        loadStoryWriteFence: () => ({
          fileScope: ["packages/**"],
          denyPaths: [],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toMatch(/story file_scope/);
  });

  it("allows path inside project+story intersection", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/src/index.ts", contents: "x" },
        },
      },
      policySeams(ENABLED_POLICY, {
        loadStoryWriteFence: () => ({
          fileScope: ["src/**"],
          denyPaths: [],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("enforces story-only fence when project runtimeAuthority is disabled", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { path: "/project/docs/readme.md", contents: "x" },
        },
      },
      readySeams({
        loadRuntimeAuthority: () => ({
          enabled: false,
          allowPaths: [],
          denyPaths: [],
          scopes: { edits: true, push: false, merge: false },
        }),
        loadStoryWriteFence: () => ({
          fileScope: ["src/**"],
          denyPaths: [],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toMatch(/story file_scope/);
  });

  it("still enforces story fence when project policy load throws (#516 P1)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/docs/outside.md", contents: "x" },
        },
      },
      readySeams({
        loadRuntimeAuthority: () => {
          throw new Error("policy read failed");
        },
        loadStoryWriteFence: () => ({
          fileScope: ["src/**"],
          denyPaths: [],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toMatch(/story file_scope/);
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

  it("renders Cursor's permission denial with decision code on the wire (#2864)", () => {
    expect(JSON.parse(renderHostDecision("cursor", deny))).toMatchObject({
      permission: "deny",
      code: deny.code,
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

  it("emits no provider override for an allow decision on non-Cursor hosts", () => {
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
    expect(renderHostDecision("codex", allow)).toBe("");
  });

  it("rewrites an exact Codex lifecycle command and renders the required allow shape (#3611)", () => {
    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          session_id: "session-a",
          tool_input: { command: "deft session:start --rearm", timeout_ms: 10_000 },
        },
        environ: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({
      verdict: "allow",
      updatedInput: {
        command: "deft session:start --rearm --session-id=host:codex:v1:c2Vzc2lvbi1h",
        timeout_ms: 10_000,
      },
    });
    expect(JSON.parse(renderHostDecision("codex", decision))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: decision.updatedInput,
      },
    });
  });

  it("renders Cursor lifecycle rewrites with updated_input while preserving tool fields (#3611)", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          conversation_id: "conversation-a",
          tool_input: { command: "task session:ready -- --json", timeout: 30 },
        },
        environ: {},
      },
      readySeams(),
    );

    expect(decision.updatedInput).toMatchObject({
      command: "task session:ready -- --json --session-id=host:cursor:v1:Y29udmVyc2F0aW9uLWE",
      timeout: 30,
    });
    expect(JSON.parse(renderHostDecision("cursor", decision))).toEqual({
      permission: "allow",
      code: decision.code,
      updated_input: decision.updatedInput,
    });
  });

  it("fails closed when an exact supported-host lifecycle command cannot be payload-bound (#3611)", () => {
    const missing = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          tool_input: { command: "deft session:start --rearm" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(missing).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });

    const manual = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          tool_input: { command: "deft session:start --session-id=manual-owner" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(manual).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });

    const grokManual = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          tool_input: { command: "deft session:start --session-id=manual-owner" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(grokManual.verdict).toBe("allow");
    expect(grokManual.updatedInput).toBeUndefined();
  });

  it("does not require host identity for non-claiming read-only session alignment (#3611)", () => {
    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          tool_input: { command: "deft session:start --read-only" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.updatedInput).toBeUndefined();
    expect(renderHostDecision("codex", decision)).toBe("");

    const swallowed = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          tool_input: { command: "deft session:start --occupant --read-only" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(swallowed).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });
  });

  it("denies ambiguous lifecycle args and ambient conflict even when no rewrite is needed (#3611)", () => {
    const invalid = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          session_id: "session-a",
          tool_input: { command: "deft session:start --session-id=" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(invalid).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });

    const conflict = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          session_id: "session-a",
          tool_input: {
            command: "deft session:start --session-id=host:codex:v1:c2Vzc2lvbi1h",
          },
        },
        environ: { DEFT_SESSION_ID: "host:codex:v1:Zm9yZWln" },
      },
      readySeams(),
    );
    expect(conflict).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
  });

  it("does not rewrite a compound lifecycle command or bypass an independent push denial (#3611)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          session_id: "session-a",
          tool_input: { command: "deft session:start && git push origin main" },
        },
        environ: {},
      },
      readySeams({
        loadRuntimeAuthority: () => ({
          ...DEFAULT_RUNTIME_AUTHORITY_POLICY,
          enabled: true,
          scopes: { edits: true, push: false, merge: false },
        }),
      }),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.updatedInput).toBeUndefined();
    expect(JSON.parse(renderHostDecision("claude", decision))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it.each([
    "deft session:start --project-root /tmp/other",
    String.raw`deft session:start --project-root C:\repo`,
    "deft swarm-launch --stories 3611 --output /tmp/auto-approved-write.json",
    "deft swarm-launch --stories 3611 --gate-clearances /tmp/clearances.json",
    "deft swarm-launch --paths xbrief/active/story.xbrief.json",
    "deft swarm-launch --stories 3611 --no-audit",
    "deft swarm-launch --stories 3611 --unknown-future-flag value",
    String.raw`deft swarm-launch --stories xbrief\active\story.xbrief.json`,
  ])("requires an explicit owner for non-rewrite lifecycle args: %s", (command) => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          session_id: "session-a",
          tool_input: { command },
        },
        environ: {},
      },
      readySeams(),
    );

    expect(decision).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });
    expect(decision.updatedInput).toBeUndefined();
    expect(decision.message).toContain("--session-id=host:claude:v1:c2Vzc2lvbi1h");
    expect(JSON.parse(renderHostDecision("claude", decision))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("keeps non-rewrite lifecycle args under normal permission once the explicit owner matches", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          session_id: "session-a",
          tool_input: {
            command:
              "deft swarm-launch --paths xbrief/active/story.xbrief.json " +
              "--session-id=host:claude:v1:c2Vzc2lvbi1h",
          },
        },
        environ: {},
      },
      readySeams(),
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.updatedInput).toBeUndefined();
    expect(renderHostDecision("claude", decision)).toBe("");
  });

  it("never auto-rewrites Task lifecycle aliases outside the Directive source repo", () => {
    const base = {
      host: "codex" as const,
      event: "tool.before" as const,
      projectRoot: "/consumer",
      payload: {
        tool_name: "Shell",
        session_id: "session-a",
        tool_input: { command: "task session:ready" },
      },
      environ: {},
    };
    expect(decideHook(base, readySeams({ runningInsideDeftRepo: () => false }))).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-unavailable",
    });

    const explicit = decideHook(
      {
        ...base,
        payload: {
          ...base.payload,
          tool_input: {
            command: "task session:ready -- --session-id=host:codex:v1:c2Vzc2lvbi1h",
          },
        },
      },
      readySeams({ runningInsideDeftRepo: () => false }),
    );
    expect(explicit.verdict).toBe("allow");
    expect(explicit.updatedInput).toBeUndefined();
  });

  it.each([
    ["nested cwd", {}, { cwd: "/other" }],
    ["nested workdir", {}, { workdir: "subdir" }],
    ["nested working_directory", {}, { working_directory: "/other" }],
    ["top-level cwd", { cwd: "/other" }, {}],
  ])("fails closed when lifecycle execution root differs via %s", (_label, top, nested) => {
    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          session_id: "session-a",
          ...top,
          tool_input: { command: "deft session:start", ...nested },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(decision).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
    expect(decision.updatedInput).toBeUndefined();
    expect(decision.message).toContain("execution-directory field");
  });

  it("allows an explicitly project-root-aligned cwd and preserves it in the rewrite", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          conversation_id: "conversation-a",
          tool_input: { command: "deft session:ready", cwd: "/project" },
        },
        environ: {},
      },
      readySeams(),
    );
    expect(decision).toMatchObject({
      verdict: "allow",
      updatedInput: {
        command: "deft session:ready --session-id=host:cursor:v1:Y29udmVyc2F0aW9uLWE",
        cwd: "/project",
      },
    });
  });

  it("ignores Cursor's Windows drive-only cwd when the hook project root is concrete", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          conversation_id: "conversation-a",
          cwd: "C:",
          tool_input: { command: "deft session:ready" },
        },
        environ: {},
      },
      readySeams({ lifecycleExecutionPlatform: "win32" }),
    );
    expect(decision).toMatchObject({
      verdict: "allow",
      updatedInput: {
        command: "deft session:ready --session-id=host:cursor:v1:Y29udmVyc2F0aW9uLWE",
      },
    });
  });

  it("does not ignore a drive-shaped relative cwd on POSIX", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Shell",
          conversation_id: "conversation-a",
          cwd: "C:",
          tool_input: { command: "deft session:ready" },
        },
        environ: {},
      },
      readySeams({ lifecycleExecutionPlatform: "linux" }),
    );
    expect(decision).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
    expect(decision.updatedInput).toBeUndefined();
  });

  it("cannot use a foreign cwd to bypass the source-repo Task restriction", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          session_id: "session-a",
          tool_input: { command: "task session:start", workingDirectory: "/consumer" },
        },
        environ: {},
      },
      readySeams({ runningInsideDeftRepo: () => true }),
    );
    expect(decision).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
    expect(decision.updatedInput).toBeUndefined();
  });

  itSymlink("realpath-binds lifecycle cwd before granting an updated-input allow", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "hook-lifecycle-cwd-project-"));
    const foreignRoot = mkdtempSync(join(tmpdir(), "hook-lifecycle-cwd-foreign-"));
    hookTemps.push(projectRoot, foreignRoot);
    mkdirSync(join(foreignRoot, "subdir"), { recursive: true });
    symlinkSync(join(foreignRoot, "subdir"), join(projectRoot, "link"), "dir");

    const decision = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot,
        payload: {
          tool_name: "Shell",
          session_id: "session-a",
          tool_input: { command: "deft session:start", cwd: "link/.." },
        },
        environ: {},
      },
      readySeams({ realpathLifecycleExecutionRoot: realpathSync }),
    );

    expect(decision).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
    expect(decision.updatedInput).toBeUndefined();
    expect(decision.message).toContain("parent traversal");

    const directSymlink = decideHook(
      {
        host: "codex",
        event: "tool.before",
        projectRoot,
        payload: {
          tool_name: "Shell",
          session_id: "session-a",
          tool_input: { command: "deft session:start", cwd: "link" },
        },
        environ: {},
      },
      readySeams({ realpathLifecycleExecutionRoot: realpathSync }),
    );
    expect(directSymlink).toMatchObject({
      verdict: "deny",
      code: "occupancy-identity-conflict",
    });
    expect(directSymlink.message).toContain(realpathSync(join(foreignRoot, "subdir")));
  });

  it("injects soft AGENTS re-bind on SessionStart for Claude/Codex/Grok/Cursor (#3171)", () => {
    const claude = decideHook(
      {
        host: "claude",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );
    const claudeWire = JSON.parse(renderHostDecision("claude", claude)) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(claudeWire.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(claudeWire.hookSpecificOutput.additionalContext).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );

    const codex = decideHook(
      {
        host: "codex",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );
    const codexWire = JSON.parse(renderHostDecision("codex", codex)) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(codexWire.hookSpecificOutput.additionalContext).toContain("Operational-ask trap");

    const grok = decideHook(
      {
        host: "grok",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );
    const grokWire = JSON.parse(renderHostDecision("grok", grok)) as {
      decision: string;
      additional_context: string;
    };
    expect(grokWire.decision).toBe("allow");
    expect(grokWire.additional_context).toContain("Summary");
    expect(grokWire.additional_context).toContain("Operational-ask trap");

    const cursor = decideHook(
      {
        host: "cursor",
        event: "session.start",
        projectRoot: "/project",
        payload: {},
      },
      readySeams(),
    );
    const cursorWire = JSON.parse(renderHostDecision("cursor", cursor)) as {
      permission: string;
      code: string;
      additional_context: string;
    };
    expect(cursorWire.permission).toBe("allow");
    expect(cursorWire.code).toBe("session-start");
    expect(cursorWire.additional_context).toContain(
      "Directive soft post-compact AGENTS re-bind (#3171 / #2769)",
    );
  });

  it("injects soft AGENTS re-bind on session.compact for file hosts (#3171)", () => {
    const markCompactStale = () => ({
      changed: true,
      statePath: "/project/.deft/ritual-state.json",
      message: "Marked session ritual stale after context compaction.",
    });
    const cursor = decideHook(
      {
        host: "cursor",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({ markCompactStale }),
    );
    const cursorWire = JSON.parse(renderHostDecision("cursor", cursor)) as {
      user_message: string;
      code: string;
    };
    expect(cursorWire.code).toBe("session-compact-rearm");
    expect(cursorWire.user_message).toContain("Soft AGENTS re-bind checklist");

    const claude = decideHook(
      {
        host: "claude",
        event: "session.compact",
        projectRoot: "/project",
        payload: {},
      },
      readySeams({ markCompactStale }),
    );
    const claudeWire = JSON.parse(renderHostDecision("claude", claude)) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(claudeWire.hookSpecificOutput.hookEventName).toBe("PostCompact");
    expect(claudeWire.hookSpecificOutput.additionalContext).toContain(
      "never authorizes skipping the mutation ritual",
    );
  });

  it("emits explicit Cursor permission allow with code for failClosed deposits (#2864)", () => {
    const allow = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Read" },
      },
      readySeams(),
    );
    expect(JSON.parse(renderHostDecision("cursor", allow))).toEqual({
      permission: "allow",
      code: "not-direct-write",
    });
  });

  it("surfaces stdin-empty code on Cursor deny wire for empty-payload path (#2864)", () => {
    const empty = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {},
        payloadContext: { stdinEmpty: true },
      },
      readySeams(),
    );
    expect(JSON.parse(renderHostDecision("cursor", empty))).toMatchObject({
      permission: "deny",
      code: "stdin-empty",
    });
  });

  it("surfaces spawn-ready code on Cursor allow wire for Task spawns (#2864)", () => {
    const spawnAllow = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Task", tool_input: { subagent_type: "generalPurpose" } },
      },
      readySeams(),
    );
    expect(spawnAllow.code).toBe("spawn-ready");
    expect(JSON.parse(renderHostDecision("cursor", spawnAllow))).toEqual({
      permission: "allow",
      code: "spawn-ready",
    });
  });
});

describe("shared hooks fixture corpus (Phase B of #2950)", () => {
  it("loads the expanded Cursor Write/ApplyPatch matrix", () => {
    expect(HOOK_FIXTURE_CASES.length).toBeGreaterThanOrEqual(24);
    for (const tool of ["Write", "ApplyPatch"] as const) {
      for (const os of ["win32", "posix"] as const) {
        expect(
          fixtureCasesFor({ host: "cursor", os, tool }).length,
          `cursor/${os}/${tool}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("decideHook uses fixture Task payload and emits spawn-ready code", () => {
    const task = fixtureCaseById("cursor-posix-task-spawn");
    expect(task?.payload).toBeDefined();
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: task?.payload,
      },
      readySeams(),
    );
    expect(decision.code).toBe("spawn-ready");
    expect(JSON.parse(renderHostDecision("cursor", decision))).toEqual({
      permission: "allow",
      code: "spawn-ready",
    });
  });

  it("decideHook uses fixture outside-root Write and does not emit scope-not-ready (#2885)", () => {
    const outside = fixtureCaseById("cursor-posix-write-outside-root");
    expect(outside?.payload).toBeDefined();
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: outside?.payload,
      },
      readySeams({
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active xBRIEF artifact was found under xbrief/active/",
        }),
      }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).not.toBe("scope-not-ready");
  });

  it("maps missing-tool-name fixture payload to invalid-input decision code", () => {
    const missing = fixtureCaseById("cursor-posix-missing-tool-name-keys");
    expect(missing?.payload).toBeDefined();
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: missing?.payload,
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "invalid-input" });
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
    "WebSearch",
  ])("leaves %s outside the P0 direct-write/spawn slice", (tool) =>
    expect(isDirectWriteTool(tool)).toBe(false));

  it.each([...SPAWN_TOOL_NAMES])("classifies %s as a spawn tool (#1185)", (tool) =>
    expect(isSpawnTool(tool)).toBe(true));

  it("does not classify Task as a direct write", () => {
    expect(isDirectWriteTool("Task")).toBe(false);
    expect(isSpawnTool("Task")).toBe(true);
  });

  it("classifies Shell/Bash as shell tools (#2711)", () => {
    expect(isShellTool("Shell")).toBe(true);
    expect(isShellTool("Bash")).toBe(true);
    expect(isShellTool("Write")).toBe(false);
    expect(isMcpTool("mcp__github__merge_pull_request")).toBe(true);
    expect(isMcpTool("Write")).toBe(false);
    // Bare push/merge names are not isMcpTool — decideHook routes via classifyMcpTool.
    expect(isMcpTool("merge_pull_request")).toBe(false);
  });
});

describe("runtimeAuthority shell/MCP push/merge in decideHook (#2711)", () => {
  const denyPushPolicy = {
    enabled: true,
    allowPaths: [] as string[],
    denyPaths: [] as string[],
    scopes: { edits: true, push: false, merge: false },
  };

  it("denies Shell git push when scopes.push is false", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "git push origin HEAD" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
    expect(decision.message).toMatch(/scopes\.push is false/);
  });

  it("denies Shell gh pr merge when scopes.merge is false", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Shell", tool_input: { command: "gh pr merge 12 --squash" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
    expect(decision.message).toMatch(/scopes\.merge is false/);
  });

  it("denies Shell git checkout -- and rm dest-forms when no active scope (#3438)", () => {
    const reporter =
      "git checkout -- apps/web/tsconfig.json apps/web/next-env.d.ts && rm apps/web/AGENTS.md apps/web/CLAUDE.md";
    const emptyScope = enforcingSeams({
      inspectScope: () => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }),
    });
    const checkout = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: reporter } },
      },
      emptyScope,
    );
    // Still denied, now through the fail-closed channel: the reporter is a
    // compound command, so no target is claimed for it (#3438).
    expect(checkout).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(checkout.message).toMatch(/not reconstructable/);

    const restore = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Shell", tool_input: { command: "git restore src/a.ts" } },
      },
      emptyScope,
    );
    expect(restore).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    // A simple command still resolves its target and denies through the gate.
    expect(restore.message).toMatch(/recognized Shell dest-form/);

    const rmdir = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "rmdir tmp/dir" } },
      },
      emptyScope,
    );
    expect(rmdir).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
  });

  it("keeps git status and hostile residual dest writers fail-open with empty active (#3438 / #2711)", () => {
    const emptyScope = readySeams({
      inspectScope: () => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }),
    });
    for (const command of [
      "git status",
      "python -c \"open('f','w').write('x')\"",
      "cmd /c copy a b",
      "bash -c 'rm apps/web/AGENTS.md'",
      "git checkout apps/web/tsconfig.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        emptyScope,
      );
      expect(decision, command).toMatchObject({
        verdict: "allow",
        code: "shell-op-unclassifiable",
      });
    }
  });

  it("allows recognized dest-forms under assist scratch and proposed lifecycle (#3438)", () => {
    const emptyScope = enforcingSeams({
      inspectScope: () => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }),
    });
    const scratch = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          posture: "assist",
          tool_input: { command: "rm .deft-scratch/notes.md" },
        },
      },
      emptyScope,
    );
    expect(scratch).toMatchObject({ verdict: "allow", code: "write-assist-scratch-ready" });

    const proposed = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "rm xbrief/proposed/2026-08-21-story.xbrief.json" },
        },
      },
      emptyScope,
    );
    expect(proposed).toMatchObject({ verdict: "allow", code: "write-propose-ready" });
  });

  it("applies story file_scope to Shell dest-forms (Edit/Write parity, #3438)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "git checkout -- docs/readme.md" },
        },
      },
      enforcingSeams({
        loadStoryWriteFence: () => ({
          fileScope: ["src/**"],
          denyPaths: [],
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-path" });
    expect(decision.message).toMatch(/story file_scope/);
  });

  it("fails closed on git -C instead of resolving it outside the root (#3438)", () => {
    const emptyScope = enforcingSeams({
      inspectScope: () => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }),
    });
    const outside = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "git -C /tmp checkout -- file.ts" },
        },
      },
      emptyScope,
    );
    // TRADEOFF (#3438): resolving `-C` used to let an out-of-root checkout
    // through, and that resolution produced two of the fence bypasses. Git
    // context is no longer resolved, so this legitimate cross-repo command is
    // now denied. Re-admitting `-C` composition means re-admitting the class.
    expect(outside).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(outside.message).toMatch(/not reconstructable/);

    const pipeline = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "cd /tmp | rm secret.ts" },
        },
      },
      emptyScope,
    );
    expect(pipeline).toMatchObject({ verdict: "deny", code: "scope-not-ready" });

    const inside = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "git -C packages checkout -- a.ts" },
        },
      },
      emptyScope,
    );
    expect(inside).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
  });

  it("denies glob dest-forms fail-closed even with ready scope", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "rm src/*.ts" },
        },
      },
      enforcingSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toMatch(/not reconstructable/);
  });

  it("denies subshell-grouped dest-forms fail-closed even with ready scope", () => {
    // Grouping moves cwd in ways the classifier does not model, so the fence
    // cannot prove it would inspect the path the shell mutates (#3438).
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "(cd apps/web && rm AGENTS.md)" },
        },
      },
      enforcingSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toMatch(/not reconstructable/);
    // The deny teaches the rewrite rather than just naming the construct.
    expect(decision.message).toMatch(/ONE simple command/);
  });

  it("carries the parent cwd onto a pipeline member so the fence cannot be bypassed", () => {
    // The fence allows docs/a.md and AGENTS.md only. `cd docs && rm a.md | rm
    // AGENTS.md` really removes docs/AGENTS.md, which is NOT in the fence.
    // Dropping the parent prefix on the pipeline member reconstructs the
    // in-fence AGENTS.md instead and lets the real target through (#3438).
    const fenced = enforcingSeams({
      loadStoryWriteFence: () => ({
        fileScope: ["docs/a.md", "AGENTS.md"],
        denyPaths: [],
      }),
    });
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "cd docs && rm a.md | rm AGENTS.md" },
        },
      },
      fenced,
    );
    // Previously this had to be caught by reconstructing docs/AGENTS.md and
    // matching it against the fence. Compound commands are now fail-closed, so
    // the bypass is unreachable without the fence needing to resolve anything.
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toMatch(/not reconstructable/);
  });

  it("is OFF by default: dest-forms stay fail-open exactly as before #3438", () => {
    // The whole point of the opt-in default (#3594): landing the classifier
    // must not deny anything a consumer runs today. `readySeams` deliberately
    // carries the production default, so these use it rather than
    // `enforcingSeams`.
    const emptyScope = readySeams({
      inspectScope: () => ({
        ready: false,
        path: null,
        message: "No active xBRIEF artifact was found under xbrief/active/",
      }),
    });
    for (const command of [
      "rm src/a.ts",
      "git checkout -- src/a.ts",
      "git restore src/a.ts",
      "rmdir tmp/dir",
      "cd x && rm y",
      "rm src/*.ts",
      "rm ~/secret",
      "git -C repo checkout -- f.ts",
      "(cd sub && rm secret.ts)",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        emptyScope,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });

  it("enforce turns on resolved gating and fail-closed together, not separately", () => {
    // Splitting the two halves would let `cd x && rm y` through while denying
    // `rm x/y`, or the reverse. Same policy value must move both.
    const emptyScope = { inspectScope: () => ({ ready: false, path: null, message: "none" }) };
    const resolved = "rm src/a.ts";
    const failClosed = "cd x && rm y";

    for (const command of [resolved, failClosed]) {
      expect(
        decideHook(
          {
            host: "claude",
            event: "tool.before",
            projectRoot: "/project",
            payload: { tool_name: "Bash", tool_input: { command } },
          },
          readySeams(emptyScope),
        ).verdict,
        `${command} @ off`,
      ).toBe("allow");
      expect(
        decideHook(
          {
            host: "claude",
            event: "tool.before",
            projectRoot: "/project",
            payload: { tool_name: "Bash", tool_input: { command } },
          },
          enforcingSeams(emptyScope),
        ).verdict,
        `${command} @ enforce`,
      ).toBe("deny");
    }
  });

  it("an unreadable runtimeAuthority policy resolves to off, not enforce", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "rm src/a.ts" } },
      },
      readySeams({
        inspectScope: () => ({ ready: false, path: null, message: "none" }),
        loadRuntimeAuthority: () => {
          throw new Error("unreadable policy");
        },
      }),
    );
    expect(decision.verdict).toBe("allow");
  });

  it("allows Shell dest-form when active scope is ready", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "git checkout -- src/a.ts" },
        },
      },
      enforcingSeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("still denies dest-form&&push when push is out of scope", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "git checkout -- src/a.ts && git push origin HEAD" },
        },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => ({
          enabled: true,
          allowPaths: [] as string[],
          denyPaths: [] as string[],
          scopes: { edits: true, push: false, merge: false },
        }),
      },
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "runtime-policy-deny-scope" });
  });

  it("allows Shell git status (unclassifiable) fail-open", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "git status" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
  });

  it("denies classifiable MCP merge tools when scopes.merge is false", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "mcp__github__merge_pull_request", tool_input: { pull_number: 1 } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
  });

  it("denies bare MCP merge_pull_request when scopes.merge is false (#2711)", () => {
    // isMcpTool("merge_pull_request") is false; classifyMcpTool still returns "merge".
    expect(isMcpTool("merge_pull_request")).toBe(false);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "merge_pull_request", tool_input: { pull_number: 1 } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
    expect(decision.message).toMatch(/scopes\.merge is false/);
  });

  it("denies bare git_push when scopes.push is false (#2711)", () => {
    expect(isMcpTool("git_push")).toBe(false);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "git_push", tool_input: { remote: "origin" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
    expect(decision.message).toMatch(/scopes\.push is false/);
  });

  it("allows push when scopes.push is true", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "git push" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => ({
          ...denyPushPolicy,
          scopes: { edits: true, push: true, merge: false },
        }),
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-ready");
  });

  it("denies compound merge&&push when push is out of scope even if merge is allowed", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "gh pr merge 1 --squash && git push origin HEAD" },
        },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => ({
          ...denyPushPolicy,
          scopes: { edits: true, push: false, merge: true },
        }),
      },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toBe("runtime-policy-deny-scope");
    expect(decision.message).toMatch(/scopes\.push is false/);
  });

  it("extracts shell command from tool_input", () => {
    expect(hookShellCommand({ tool_name: "Bash", tool_input: { command: "git push" } })).toBe(
      "git push",
    );
    expect(hookShellCommand({ tool_name: "Bash", tool_input: { cmd: "gh pr merge 1" } })).toBe(
      "gh pr merge 1",
    );
  });

  it("fails open when runtimeAuthority policy load throws (#2952)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "git push" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => {
          throw new Error("policy boom");
        },
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
    expect(decision.message).toMatch(/policy load failed/);
  });

  it("fails open when Shell payload has no command string (#2952)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: {} },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => denyPushPolicy,
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
  });

  it("allows classifiable MCP push when scopes.push is true (#2952)", () => {
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "mcp__git__git_push", tool_input: { remote: "origin" } },
      },
      {
        ...readySeams(),
        loadRuntimeAuthority: () => ({
          ...denyPushPolicy,
          scopes: { edits: true, push: true, merge: false },
        }),
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-ready");
  });
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
    if (process.platform === "win32") {
      expect(
        projectRootFromHookPayload(
          { workspace_roots: ["C:"], cwd: "C:" },
          "C:\\Users\\nicol\\OneDrive\\Documents\\Projects\\Aperture",
        ),
      ).toBe(resolve("C:\\Users\\nicol\\OneDrive\\Documents\\Projects\\Aperture"));
      expect(projectRootFromHookPayload({ workspaceRoot: "C:" }, "/fallback")).toBe(
        resolve("/fallback"),
      );
      expect(projectRootFromHookPayload({ workspace_root: "D:" }, "/fallback")).toBe(
        resolve("/fallback"),
      );
      expect(projectRootFromHookPayload({ workspace_root: "C:/" }, "/fallback")).toBe(
        resolve("/fallback"),
      );
    }
  });

  it.skipIf(process.platform !== "win32")(
    "collapses C:\\c:\\ doubled-drive ritual paths (#2787)",
    () => {
      const fallback = "C:\\Repos\\deft\\statusreport";
      const expectStatusreportRoot = (payload: unknown) => {
        const root = projectRootFromHookPayload(payload, fallback);
        expect(root).toBe(resolve(fallback));
        expect(hasDoubledWindowsDrivePrefix(root)).toBe(false);
        expect(hasDoubledWindowsDrivePrefix(ritualStatePath(root))).toBe(false);
        expect(ritualStatePath(root)).toBe(join(resolve(fallback), ".deft", "ritual-state.json"));
      };

      expectStatusreportRoot({ workspace_root: "C:\\c:\\Repos\\deft\\statusreport" });
      expectStatusreportRoot({
        workspace_root: "C:",
        cwd: "c:\\Repos\\deft\\statusreport",
      });
      expectStatusreportRoot({
        workspace_roots: ["C:", "c:\\Repos\\deft\\statusreport"],
        cwd: "C:",
      });
      expectStatusreportRoot({ workspace_root: "C:\\Repos\\deft\\statusreport" });
      expectStatusreportRoot({ cwd: "c:\\Repos\\deft\\statusreport" });

      expect(normalizeHookProjectRoot("C:\\c:\\Repos\\deft\\statusreport")).toBe(resolve(fallback));
      expect(normalizeHookProjectRoot("/c/Repos/deft/statusreport")).toBe(resolve(fallback));
      expect(normalizeHookProjectRoot("C:\\Repos\\deft\\statusreport")).toBe(resolve(fallback));
    },
  );

  it("keeps non-win32 hook roots on resolve-only path", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    try {
      expect(normalizeHookProjectRoot("/tmp/statusreport")).toBe(resolve("/tmp/statusreport"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores non-string workspace root entries when scanning payload candidates", () => {
    const fallback = "C:\\Repos\\deft\\statusreport";
    if (process.platform === "win32") {
      expect(
        projectRootFromHookPayload(
          { workspace_roots: ["C:", 42, null, "c:\\Repos\\deft\\statusreport"] },
          fallback,
        ),
      ).toBe(resolve(fallback));
    } else {
      expect(projectRootFromHookPayload({ workspace_roots: ["/project", 42] }, "/fallback")).toBe(
        resolve("/project"),
      );
    }
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
