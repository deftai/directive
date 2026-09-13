/**
 * Host-env identity transport on the write gate (#3873).
 *
 * The probe matrix here is the acceptance evidence for the claim / deny / fix /
 * allow inversion: it asserts the **occupancy verdict**, not end-to-end write
 * success. An occupancy admission in a tree whose ritual is not ready still
 * denies `ritual-not-ready`, and that is the correct outcome -- treating "the
 * Write tool succeeds" as proof of an identity fix is the mis-statement the
 * design-critique arc corrected.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHostSessionId } from "../session/host-session-owner.js";
import {
  applyWorktreeOccupancy,
  grantOccupancyMembership,
  releaseOccupancy,
  resolveOccupancySessionId,
} from "../session/occupancy.js";
import {
  decideHook,
  formatHookHostArgv,
  type HookPolicySeams,
  renderHostDecision,
} from "./index.js";

const GROK_RAW_SESSION_ID = "grok-session-a";
const GROK_OWNER = "host:grok:v1:Z3Jvay1zZXNzaW9uLWE";
const HOST_ENVIRON = { GROK_SESSION_ID: GROK_RAW_SESSION_ID } as const;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function leasedRoot(sessionId: string = GROK_OWNER): string {
  const root = mkdtempSync(join(tmpdir(), "hook-grok-identity-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  applyWorktreeOccupancy(root, { sessionId, intent: "mutation" });
  return root;
}

/** Ritual state bound to `boundSessionId`, the owner #3611 requires it to name. */
function readyRitual(boundSessionId: string) {
  return () => ({
    code: 0,
    message: "OK session ritual gated tier is fresh.",
    tier: "gated",
    statePath: "/ritual-state.json",
    bypassed: false,
    wouldFailCode: null,
    posture: "mutation" as const,
    ritualStateRequired: true,
    boundSessionId,
  });
}

function seams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: readyRitual(GROK_OWNER),
    inspectScope: () => ({ ready: true, path: "/story.xbrief.json", message: "OK active scope" }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    ...overrides,
  };
}

function writeDecision(
  root: string,
  environ: NodeJS.ProcessEnv,
  overrides: Partial<HookPolicySeams> = {},
) {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: "Write", tool_input: { file_path: join(root, "src", "app.ts") } },
      environ,
    },
    seams(overrides),
  );
}

describe("Grok write-gate probe matrix (#3873)", () => {
  it("denies when the lease is live and no identity resolves", () => {
    const decision = writeDecision(leasedRoot(), {});

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain(`Worktree occupied by session ${GROK_OWNER}`);
    expect(decision.message).toContain("presented no session identity");
  });

  it("admits the lease holder at occupancy when the host publishes its identity", () => {
    const decision = writeDecision(leasedRoot(), HOST_ENVIRON);

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("denies when the resolved identity is a different session", () => {
    const decision = writeDecision(leasedRoot("some-other-session"), HOST_ENVIRON);

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(decision.message).toContain("Worktree occupied by session some-other-session");
    expect(decision.message).toContain(`presented session ${GROK_OWNER}`);
  });

  it("stops making occupancy the verdict once the lease is released", () => {
    const root = leasedRoot();
    const before = writeDecision(root, {});
    releaseOccupancy(root, { sessionId: GROK_OWNER });
    const after = writeDecision(root, {});

    expect(before).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(after).toMatchObject({ verdict: "allow", code: "write-ready" });
  });

  it("separates the occupancy verdict from later gates", () => {
    // The identity fix moves the verdict past occupancy; it does not make an
    // unprepared tree writable. Both halves are asserted so acceptance evidence
    // cannot be read as "the Write tool succeeds".
    const notReady = {
      verifyRitual: () => ({
        code: 1,
        message: "ritual state missing",
        tier: "gated",
        statePath: "/ritual-state.json",
        bypassed: false,
        wouldFailCode: null,
        posture: "mutation" as const,
        ritualStateRequired: true,
      }),
    };
    const unidentified = writeDecision(leasedRoot(), {}, notReady);
    const owner = writeDecision(leasedRoot(), HOST_ENVIRON, notReady);

    expect(unidentified).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(owner).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
  });
});

describe("Grok claim binding and fail-closed residue (#3873)", () => {
  it("claims under the same owner the write gate later presents", () => {
    // Grok's wire cannot carry a rewritten tool input, so the claim is bound in
    // the CLI instead: both ends read the host variable and agree on the owner.
    // Without this the lease is minted under an id no hook can ever present.
    expect(resolveOccupancySessionId({ env: HOST_ENVIRON })).toBe(GROK_OWNER);

    const root = mkdtempSync(join(tmpdir(), "hook-grok-claim-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    applyWorktreeOccupancy(root, {
      sessionId: resolveOccupancySessionId({ env: HOST_ENVIRON }),
      intent: "mutation",
    });

    expect(writeDecision(root, HOST_ENVIRON)).toMatchObject({
      verdict: "allow",
      code: "write-ready",
    });
  });

  it("does not offer a lifecycle rewrite a host cannot receive", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-grok-lifecycle-"));
    temps.push(root);

    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "Bash", tool_input: { command: "deft session:start", cwd: root } },
        environ: HOST_ENVIRON,
      },
      seams(),
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.updatedInput).toBeUndefined();
    expect(renderHostDecision("grok", decision)).toBe("");
  });

  it("leaves the explicit owner flow alone when the host publishes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-grok-lifecycle-legacy-"));
    temps.push(root);

    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "Bash", tool_input: { command: "deft session:start" } },
        environ: { DEFT_SESSION_ID: "manual-owner" },
      },
      seams(),
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.updatedInput).toBeUndefined();
  });

  it("keeps the explicit owner as the actor when the host variable is absent", () => {
    const manual = { verifyRitual: readyRitual("manual-owner") };
    const holder = writeDecision(
      leasedRoot("manual-owner"),
      { DEFT_SESSION_ID: "manual-owner" },
      manual,
    );
    const stranger = writeDecision(
      leasedRoot("manual-owner"),
      { DEFT_SESSION_ID: "someone-else" },
      manual,
    );

    expect(holder).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(stranger).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
  });

  it("fails closed on a malformed host variable instead of falling back", () => {
    const decision = writeDecision(leasedRoot(), {
      GROK_SESSION_ID: " padded ",
      DEFT_SESSION_ID: GROK_OWNER,
    });

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-unavailable" });
    expect(decision.message).toContain("hook --host grok");
    expect(decision.message).toContain("has invalid GROK_SESSION_ID");
  });

  it("fails closed when an ambient owner contradicts the host identity", () => {
    const decision = writeDecision(leasedRoot(), {
      ...HOST_ENVIRON,
      DEFT_SESSION_ID: "some-other-session",
    });

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-conflict" });
    expect(decision.message).toContain("hook --host grok");
    expect(decision.message).toContain(`Host owner ${GROK_OWNER} conflicts with`);
  });

  it("admits a granted child because the presented id is now grantable", () => {
    // The occupied message recommends occupant-run occupancy:grant with --session-id.
    // That recommendation was unreachable while the hook presented an empty id:
    // grantOccupancyMembership refuses a zero-length child.
    const root = leasedRoot("some-other-session");
    const occupant = { verifyRitual: readyRitual("some-other-session") };
    const denied = writeDecision(root, HOST_ENVIRON, occupant);
    expect(denied.message).toContain(
      `occupancy:grant --session-id=some-other-session --child-session-id=${GROK_OWNER}`,
    );

    expect(
      grantOccupancyMembership(root, {
        sessionId: "some-other-session",
        childSessionId: "",
        role: "leaf-implementation",
      }).code,
    ).toBe(2);
    const grant = grantOccupancyMembership(root, {
      sessionId: "some-other-session",
      childSessionId: GROK_OWNER,
      role: "leaf-implementation",
    });
    expect(grant.code).toBe(0);

    expect(writeDecision(root, HOST_ENVIRON, occupant)).toMatchObject({
      verdict: "allow",
      code: "write-ready",
    });
  });
});

describe("Grok child argv --host remainder (#4409)", () => {
  const CLAUDE_RAW = "01a09164-982a-7002-96a3-18d23edecb86";
  const OBSERVED_CLAUDE_OWNER = canonicalHostSessionId("claude", CLAUDE_RAW);
  const CLAUDE_LEAK_ENV = {
    CLAUDECODE: "1",
    CLAUDE_CODE: "1",
    CLAUDE_CODE_SESSION_ID: CLAUDE_RAW,
    CLAUDE_CODE_HOST_SESSION_ID: CLAUDE_RAW,
    CLAUDE_CODE_ENTRYPOINT: "cli",
    DEFT_SESSION_ID: "b6349785-5f9f-4af9-a807-509280395ba1",
  } as const;

  it("does not produce a claude owner from inherited CLAUDE_* under --host grok", () => {
    const holder = CLAUDE_LEAK_ENV.DEFT_SESSION_ID;
    const decision = writeDecision(
      leasedRoot(holder),
      { ...CLAUDE_LEAK_ENV },
      {
        verifyRitual: readyRitual(holder),
      },
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(decision.message ?? "").not.toContain("host:claude:");
  });

  it("does not honour DEFT_SESSION_ID over a derived grok host owner", () => {
    const decision = writeDecision(leasedRoot(), {
      ...HOST_ENVIRON,
      ...CLAUDE_LEAK_ENV,
    });

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-conflict" });
    expect(decision.message).toContain("hook --host grok");
    expect(decision.message).toContain(GROK_OWNER);
    expect(decision.message).not.toContain("host:claude:");
  });

  it("reproduces the observed owner from --host claude plus payload session_id", () => {
    const root = leasedRoot("b6349785-5f9f-4af9-a807-509280395ba1");
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "Write",
          tool_input: { file_path: join(root, "src", "app.ts") },
          session_id: CLAUDE_RAW,
        },
        environ: { ...CLAUDE_LEAK_ENV },
      },
      seams({ verifyRitual: readyRitual(OBSERVED_CLAUDE_OWNER) }),
    );

    expect(OBSERVED_CLAUDE_OWNER).toBe(
      "host:claude:v1:MDFhMDkxNjQtOTgyYS03MDAyLTk2YTMtMThkMjNlZGVjYjg2",
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-conflict" });
    expect(decision.message).toContain("hook --host claude");
    expect(decision.message).toContain(OBSERVED_CLAUDE_OWNER);
  });

  it("pins the child argv --host spelling independently of denial assertions", () => {
    expect(formatHookHostArgv("grok")).toBe("hook --host grok");
    expect(formatHookHostArgv("claude")).toBe("hook --host claude");
  });

  it("names hook --host on lifecycle payload identity conflict with DEFT_SESSION_ID", () => {
    const root = leasedRoot();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "Bash",
          session_id: CLAUDE_RAW,
          tool_input: { command: "deft session:start" },
        },
        environ: { DEFT_SESSION_ID: "some-other-session" },
      },
      seams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-conflict" });
    expect(decision.message).toContain("hook --host claude");
    expect(decision.message).toContain(OBSERVED_CLAUDE_OWNER);
  });

  it("names hook --host when exact lifecycle cannot bind missing payload identity", () => {
    const root = leasedRoot();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "Bash",
          tool_input: { command: "deft session:start --rearm" },
        },
        environ: {},
      },
      seams(),
    );

    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-identity-unavailable" });
    expect(decision.message).toContain("hook --host claude");
  });
});
