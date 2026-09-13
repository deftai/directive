import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exactLifecycleCommandVerb,
  hintUninspectableLifecycleCommand,
  inspectHintedLifecycleSessionId,
} from "../hooks/classify/host-session-identity.js";
import {
  canonicalHostSessionId,
  detectDeclaredIdentityHosts,
  HOST_ENV_IDENTITY_VARIABLES,
  printCompanionHostOwner,
} from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  formatOccupancyRemediation,
  OccupancyMintRefusedError,
  occupancyPath,
  readOccupancy,
  resolveOccupancySessionClaim,
  resolveOccupancySessionId,
} from "./occupancy.js";

const CLAUDE_RAW = "3d367ca0-6f5d-4152-82fe-31b3b8ff8de6";
const CLAUDE_OWNER = canonicalHostSessionId("claude", CLAUDE_RAW);

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-4431-"));
  temps.push(root);
  return root;
}

describe("payload-host mint refusal (#4431)", () => {
  it("does not add CLAUDE_CODE_SESSION_ID as a host-env identity source", () => {
    expect(HOST_ENV_IDENTITY_VARIABLES).toEqual(["GROK_SESSION_ID"]);
    expect(() =>
      resolveOccupancySessionId({
        env: { CLAUDE_CODE_SESSION_ID: CLAUDE_RAW },
        newSessionId: () => "must-not-claim-from-companion",
      }),
    ).toThrow(OccupancyMintRefusedError);
  });

  it("print-only companion names the hook owner without claiming from it", () => {
    const env = { CLAUDE_CODE_SESSION_ID: CLAUDE_RAW };
    expect(printCompanionHostOwner("claude", env)).toBe(CLAUDE_OWNER);
    const claim = resolveOccupancySessionClaim({
      env,
      newSessionId: () => "minted-uuid",
    });
    expect(claim.status).toBe("refuse-mint");
    if (claim.status !== "refuse-mint") return;
    expect(claim.suggestedSessionId).toBe(CLAUDE_OWNER);
    expect(claim.message).toContain(`--session-id=${CLAUDE_OWNER}`);
    expect(claim.message).toContain("refuses to mint");
  });

  it("CLAUDECODE without a printable companion still refuses the mint", () => {
    const claim = resolveOccupancySessionClaim({
      env: { CLAUDECODE: "1" },
      newSessionId: () => "minted-uuid",
    });
    expect(claim.status).toBe("refuse-mint");
    if (claim.status !== "refuse-mint") return;
    expect(claim.suggestedSessionId).toBeNull();
    expect(claim.message).toContain("Directive hook registered");
    expect(() =>
      resolveOccupancySessionId({ env: { CLAUDECODE: "1" }, newSessionId: () => "minted-uuid" }),
    ).toThrow(OccupancyMintRefusedError);
  });

  it("still mints when no declared identity host is visible", () => {
    expect(resolveOccupancySessionId({ env: {}, newSessionId: () => "minted-uuid" })).toBe(
      "minted-uuid",
    );
    const claim = resolveOccupancySessionClaim({
      env: {},
      newSessionId: () => "minted-uuid",
    });
    expect(claim).toEqual({ status: "ok", sessionId: "minted-uuid", provenance: "minted" });
  });

  it("detects declared hosts from presence markers", () => {
    expect(detectDeclaredIdentityHosts({ CLAUDECODE: "1" })).toEqual(["claude"]);
    expect(detectDeclaredIdentityHosts({ GROK_AGENT: "1" })).toEqual(["grok"]);
    expect(detectDeclaredIdentityHosts({})).toEqual([]);
  });

  it("applyWorktreeOccupancy denies instead of minting on a payload host", () => {
    const root = tempRoot();
    const denied = applyWorktreeOccupancy(root, {
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: CLAUDE_RAW },
      newSessionId: () => "minted-uuid",
    });
    expect(denied.action).toBe("denied");
    expect(denied.code).toBe(1);
    expect(denied.message).toContain(`--session-id=${CLAUDE_OWNER}`);
    expect(readOccupancy(root)).toBeNull();
  });

  it("records claim-time identity provenance on the lease", () => {
    const root = tempRoot();
    const claimed = applyWorktreeOccupancy(root, {
      sessionId: "explicit-owner",
      env: {},
      intent: "mutation",
    });
    expect(claimed.action).toBe("claimed");
    expect(readOccupancy(root)?.identityProvenance).toBe("explicit");
    const payload = JSON.parse(readFileSync(occupancyPath(root), "utf8")) as {
      identity_provenance: string;
    };
    expect(payload.identity_provenance).toBe("explicit");
  });

  it("keys stranger denial on minted provenance rather than write history", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, {
      env: {},
      newSessionId: () => "minted-uuid",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const record = readOccupancy(root);
    expect(record?.identityProvenance).toBe("minted");
    const message = formatOccupancyRemediation(
      record as NonNullable<typeof record>,
      new Date("2026-08-17T12:00:09Z"),
      "stranger",
      {},
    );
    expect(message).toContain("minted owner");
    expect(message).toContain("Do not steal this lease");
    expect(message).not.toContain("--steal");
  });

  it("does not treat a silent live peer as a minted phantom", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, {
      sessionId: "live-peer",
      env: {},
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const record = readOccupancy(root);
    expect(record?.identityProvenance).toBe("explicit");
    expect(record?.lastWriteAt).toBeNull();
    const message = formatOccupancyRemediation(
      record as NonNullable<typeof record>,
      new Date("2026-08-17T12:00:09Z"),
      "stranger",
    );
    expect(message).not.toContain("minted owner");
    expect(message).toContain("no recorded write");
  });
});

describe("uninspectable lifecycle identity rewrite (#4431)", () => {
  it("filed bare session:ready is inspectable; chained/piped forms are not", () => {
    expect(
      exactLifecycleCommandVerb({
        tool_name: "Bash",
        tool_input: { command: "deft session:ready" },
      }),
    ).toBe("session:ready");
    expect(
      exactLifecycleCommandVerb({
        tool_name: "Bash",
        tool_input: { command: "deft session:ready 2>&1" },
      }),
    ).toBeNull();
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:ready 2>&1" },
      }),
    ).toBe("session:ready");
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "cd wt && deft session:ready 2>&1 | tail -20" },
      }),
    ).toBe("session:ready");
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "deft session:ready" },
      }),
    ).toBeNull();
  });

  it("does not treat quoted or comment lifecycle text as an invocation", () => {
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: 'echo "deft session:start"' },
      }),
    ).toBeNull();
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: 'grep "task occupancy:steal" file' },
      }),
    ).toBeNull();
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "echo hi # deft session:start" },
      }),
    ).toBeNull();
  });

  it("reads an explicit matching --session-id from a chained command", () => {
    expect(
      inspectHintedLifecycleSessionId({
        tool_name: "Bash",
        tool_input: {
          command: "deft session:start --session-id=host:claude:v1:c2Vzc2lvbi1h && echo ok",
        },
      }),
    ).toEqual({ status: "present", sessionId: "host:claude:v1:c2Vzc2lvbi1h" });
  });

  it("still hints a quoted executable name as a lifecycle invocation", () => {
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: '"deft" session:start && echo ok' },
      }),
    ).toBe("session:start");
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: 'd"ef"t session:start | cat' },
      }),
    ).toBe("session:start");
  });

  it("does not treat a sibling --session-id as binding the lifecycle command", () => {
    expect(
      inspectHintedLifecycleSessionId({
        tool_name: "Bash",
        tool_input: {
          command: "deft session:start && other-command --session-id=host:claude:v1:c2Vzc2lvbi1h",
        },
      }),
    ).toEqual({ status: "absent", sessionId: null });
  });

  it("does not reconstruct argument-position quote fragments as a lifecycle executable", () => {
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: 'echo d"ef"t session:start' },
      }),
    ).toBeNull();
  });

  it("does not fail-open an env-assignment prefix before a lifecycle executable", () => {
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "FOO=bar deft session:start && echo ok" },
      }),
    ).toBe("session:start");
    expect(
      hintUninspectableLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command: "FOO=bar BAZ=1 deft session:start && echo ok" },
      }),
    ).toBe("session:start");
    expect(
      exactLifecycleCommandVerb({
        tool_name: "Bash",
        tool_input: { command: "FOO=bar deft session:start" },
      }),
    ).toBe("session:start");
    expect(
      inspectHintedLifecycleSessionId({
        tool_name: "Bash",
        tool_input: {
          command: "FOO=bar deft session:start --session-id=host:claude:v1:c2Vzc2lvbi1h && echo ok",
        },
      }),
    ).toEqual({ status: "present", sessionId: "host:claude:v1:c2Vzc2lvbi1h" });
  });

  it("requires every lifecycle segment to carry the same matching --session-id", () => {
    expect(
      inspectHintedLifecycleSessionId({
        tool_name: "Bash",
        tool_input: {
          command:
            "deft session:start --session-id=host:claude:v1:c2Vzc2lvbi1h && deft session:end --session-id=foreign",
        },
      }),
    ).toEqual({ status: "invalid", sessionId: null });
    expect(
      inspectHintedLifecycleSessionId({
        tool_name: "Bash",
        tool_input: {
          command:
            "deft session:start --session-id=host:claude:v1:c2Vzc2lvbi1h && deft session:end --session-id=host:claude:v1:c2Vzc2lvbi1h",
        },
      }),
    ).toEqual({ status: "present", sessionId: "host:claude:v1:c2Vzc2lvbi1h" });
  });
});
