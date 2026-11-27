/**
 * Runtime tests for TOTP delegation (#7420): the `deft delegate` verb, and the
 * agent-shell mints a live delegation completes (authz:grant release templates,
 * scope:record-approved-scope) versus the stops it never completes.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armDelegation,
  delegationAuditPath,
  isDelegatedOrigin,
  isHumanOrigin,
  listGrants,
  loadDelegationState,
  readLiveDelegation,
  totpCodeForStep,
  totpStepAt,
  writeEnrolledSecret,
} from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as authzMain } from "./authz.js";
import { routeArgv } from "./cli-router/route-argv.js";
import { parseArgs, run } from "./delegate.js";
import { DELEGATE_ALIAS_SUBCOMMANDS, resolveCanonicalVerb } from "./dispatch.js";
import {
  completeHarnessAttendedMintRequest,
  openHarnessAttendedMintRequest,
} from "./human-presence-mint.js";
import { run as recordApprovedScope } from "./scope-record-approved-scope.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Arm a real delegation in `root` (store = root; not a git checkout). */
function armIn(root: string, now = new Date()): string {
  const secretPath = join(root, "cfg", "totp-secret.json");
  writeEnrolledSecret(secretPath, { secretBase32: SECRET, enrolledAt: "x", account: "op" }, false);
  const out = armDelegation({
    projectRoot: root,
    storeRoot: root,
    secretPath,
    promptText: `deft delegate on ${totpCodeForStep(SECRET, totpStepAt(now))}`,
    hostSessionId: "session-A",
    host: "claude",
    now,
  });
  if (out.kind !== "armed") throw new Error(`arm failed: ${out.kind}`);
  return out.record.delegationId;
}

/** An agent shell: markers set, no TTY, no controlling terminal. */
const agentShell = {
  environ: { CLAUDECODE: "1" },
  isTty: () => false,
  hasControllingTerminal: () => false,
  readInteractiveConfirm: () => null,
  recordOperatorStop: () => undefined,
};

function captureIo(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  return { out, err };
}

describe("deft delegate verb", () => {
  it("parses actions and flags", () => {
    expect(parseArgs(["off"]).action).toBe("off");
    expect(parseArgs(["enroll", "--confirm", "--account", "scott"]).account).toBe("scott");
    expect(parseArgs(["on", "123456"]).error).toMatch(/unrecognized/);
    expect(parseArgs([]).error).toMatch(/missing action/);
  });

  it("routes delegate:* colon forms to the delegate handler", () => {
    expect(resolveCanonicalVerb("delegate")).toBe("delegate");
    expect(resolveCanonicalVerb("delegate:off")).toBe("delegate");
    expect(DELEGATE_ALIAS_SUBCOMMANDS).toEqual({
      "delegate:enroll": "enroll",
      "delegate:off": "off",
      "delegate:status": "status",
    });
    // A lone colon verb passes through to dispatch, which maps the alias.
    expect(routeArgv(["delegate:off"]).argv).toEqual(["delegate:off"]);
    expect(routeArgv(["delegate", "status", "--json"]).argv).toEqual([
      "delegate",
      "status",
      "--json",
    ]);
  });

  it("enroll refuses an agent shell and writes no secret", () => {
    const root = newRoot("deleg-enroll-agent-");
    const secretPath = join(root, "cfg", "s.json");
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      run(["enroll", "--confirm"], {
        ...agentShell,
        secretPath,
        writeOut: () => undefined,
        writeErr: (t) => err.push(t),
      }),
    ).toBe(2);
    expect(existsSync(secretPath)).toBe(false);
  });

  it("enroll at a terminal writes the secret outside the repo and prints the URI", () => {
    const root = newRoot("deleg-enroll-tty-");
    const secretPath = join(root, "cfg", "s.json");
    const out: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["enroll", "--confirm", "--account", "scott"], {
        environ: {},
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        secretPath,
        newSecret: () => SECRET,
        writeOut: (t) => out.push(t),
        writeErr: () => undefined,
      }),
    ).toBe(0);
    expect(JSON.parse(readFileSync(secretPath, "utf8")).secretBase32).toBe(SECRET);
    expect(out.join("")).toMatch(/otpauth:\/\/totp\/Directive%3Ascott/);
  });

  it("status, off and session-end", () => {
    const root = newRoot("deleg-cli-");
    armIn(root);
    const out: string[] = [];
    const seams = {
      storeRoot: root,
      writeOut: (t: string) => out.push(t),
      writeErr: () => undefined,
    };
    expect(run(["status", "--project-root", root], seams)).toBe(0);
    expect(out.join("")).toMatch(/Delegation LIVE/);
    // session-end from another session leaves it live.
    expect(
      run(["session-end", "--project-root", root], {
        ...seams,
        readStdin: () => JSON.stringify({ hook_event_name: "SessionEnd", session_id: "session-B" }),
      }),
    ).toBe(0);
    expect(readLiveDelegation(root, { storeRoot: root })).not.toBeNull();
    expect(run(["off", "--project-root", root], seams)).toBe(0);
    expect(out.join("")).toMatch(/\[delegated-totp\] delegation .* ended \(delegate off\)/);
    expect(readLiveDelegation(root, { storeRoot: root })).toBeNull();
  });

  it("session-end from the arming session ends it", () => {
    const root = newRoot("deleg-sessend-");
    armIn(root);
    expect(
      run(["session-end", "--project-root", root], {
        storeRoot: root,
        writeOut: () => undefined,
        readStdin: () => JSON.stringify({ hook_event_name: "SessionEnd", session_id: "session-A" }),
      }),
    ).toBe(0);
    const st = loadDelegationState(root);
    expect(st.ok && st.state.record?.endedReason).toBe("session-end");
  });
});

describe("agent-shell release grant under a live delegation (#7420 clauses 3 / 13 / 18)", () => {
  it("mints a delegated release-cut grant, posts one chat line and audits it", () => {
    const root = newRoot("deleg-grant-");
    const delegationId = armIn(root);
    const io = captureIo();
    const rc = authzMain(
      [
        "grant",
        "--project-root",
        root,
        "--template",
        "release-cut",
        "--target",
        "0.133.0",
        "--confirm",
      ],
      agentShell,
    );
    expect(rc).toBe(0);
    const grants = listGrants(root);
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    if (grant === undefined) throw new Error("no grant");
    expect(isDelegatedOrigin(grant.origin)).toBe(true);
    expect(isHumanOrigin(grant.origin)).toBe(false);
    expect(grant.origin.delegationId).toBe(delegationId);
    const chat = io.out.filter((l) => l.startsWith("[delegated-totp]"));
    expect(chat).toHaveLength(1);
    expect(readFileSync(delegationAuditPath(root), "utf8")).toMatch(/"event":"delegated-mint"/);
    // The harness-attended request records the delegated provenance.
    const store = join(root, ".deft", "harness-attended-mint");
    const req = readdirSync(store).find((n) => n.endsWith(".json")) as string;
    const parsed = JSON.parse(readFileSync(join(store, req), "utf8")) as {
      status: string;
      completedVia: string;
      delegationId: string;
    };
    expect(parsed).toMatchObject({
      status: "completed",
      completedVia: "delegated-totp",
      delegationId,
    });
  });

  it("without a live record the same agent-shell mint refuses as today", () => {
    const root = newRoot("deleg-grant-none-");
    captureIo();
    const rc = authzMain(
      [
        "grant",
        "--project-root",
        root,
        "--template",
        "release-cut",
        "--target",
        "0.133.0",
        "--confirm",
      ],
      agentShell,
    );
    expect(rc).toBe(2);
    expect(listGrants(root)).toHaveLength(0);
  });
});

describe("never-delegable stops still refuse with a live record (#7420 clause 17)", () => {
  const cases: Array<{ name: string; argv: (root: string) => string[] }> = [
    {
      name: "finish-loop",
      argv: (r) => ["grant", "--project-root", r, "--template", "finish-loop", "--confirm"],
    },
    {
      name: "gate-override",
      argv: (r) => [
        "grant",
        "--project-root",
        r,
        "--template",
        "gate-override",
        "--target",
        "coverage-applicability",
        "--plan-ref",
        "att-1",
        "--base-sha",
        "a",
        "--head-sha",
        "b",
        "--tree-hash",
        "c",
        "--confirm",
      ],
    },
    {
      name: "spec-drift-override",
      argv: (r) => [
        "grant",
        "--project-root",
        r,
        "--template",
        "spec-drift-override",
        "--target",
        "base",
        "--plan-ref",
        "p",
        "--story-ids",
        "clause.1",
        "--confirm",
      ],
    },
    {
      name: "raw-ops grant",
      argv: (r) => ["grant", "--project-root", r, "--operations", "edit", "--confirm"],
    },
    {
      name: "authz:uat-start",
      argv: (r) => ["uat-start", "--project-root", r, "--campaign", "c", "--confirm"],
    },
    { name: "authz:uat-suspend", argv: (r) => ["uat-suspend", "--project-root", r, "--confirm"] },
    { name: "authz:revoke", argv: (r) => ["revoke", "--project-root", r, "grant-x", "--confirm"] },
  ];
  for (const c of cases) {
    it(`${c.name} refuses and leaves the delegation live`, () => {
      const root = newRoot("deleg-never-");
      armIn(root);
      captureIo();
      expect(authzMain(c.argv(root), agentShell)).toBe(2);
      expect(listGrants(root)).toHaveLength(0);
      expect(readLiveDelegation(root, { storeRoot: root })).not.toBeNull();
    });
  }

  it("a terminal authz:revoke ends the delegation", () => {
    const root = newRoot("deleg-revoke-");
    armIn(root);
    captureIo();
    authzMain(["revoke", "--project-root", root, "grant-x", "--confirm"], {
      environ: {},
      isTty: () => true,
      hasControllingTerminal: () => true,
      readInteractiveConfirm: () => "mint",
    });
    const st = loadDelegationState(root);
    expect(st.ok && st.state.record?.endedReason).toBe("authz-revoke");
  });
});

describe("agent-shell approved-scope under a live delegation (#7420 clause 12)", () => {
  function seedBrief(root: string): void {
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/pending/story.xbrief.json"),
      `${JSON.stringify({ plan: { id: "story-1", metadata: { swarm: { file_scope: ["src/a.ts"] } } } })}\n`,
    );
  }
  const argv = (root: string) => [
    "xbrief/pending/story.xbrief.json",
    "--project-root",
    root,
    "--actor",
    "scott",
    "--confirm",
  ];

  it("writes a delegated stamp with a live record and posts one chat line", () => {
    const root = newRoot("deleg-scope-");
    seedBrief(root);
    const delegationId = armIn(root);
    const io = captureIo();
    expect(recordApprovedScope(argv(root), agentShell)).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(root, ".deft/approved-scope/story-1.json"), "utf8"),
    ) as {
      humanApproval: { kind: string; mintedVia: string; delegationId: string; expiresAt: string };
    };
    expect(rec.humanApproval).toMatchObject({
      kind: "operator-delegated",
      mintedVia: "delegated-totp",
      delegationId,
    });
    expect(io.out.filter((l) => l.startsWith("[delegated-totp]"))).toHaveLength(1);
  });

  it("without a record the mint refuses as today", () => {
    const root = newRoot("deleg-scope-none-");
    seedBrief(root);
    captureIo();
    expect(recordApprovedScope(argv(root), agentShell)).toBe(2);
    expect(existsSync(join(root, ".deft/approved-scope"))).toBe(false);
  });
});

describe("one compare-and-set from open to completed (#7420 clause 10)", () => {
  it("two completions of one request complete it once", () => {
    const root = newRoot("deleg-cas-");
    const opened = openHarnessAttendedMintRequest({
      verb: "authz:grant",
      projectRoot: root,
      destinations: [join(root, ".deft", "authz")],
      args: ["--template", "release-cut"],
    });
    if (!opened.ok) throw new Error(opened.error);
    const at = new Date();
    const a = completeHarnessAttendedMintRequest({
      projectRoot: root,
      requestId: opened.request.requestId,
      via: "delegated-totp",
      at,
      delegationId: "d1",
    });
    const b = completeHarnessAttendedMintRequest({
      projectRoot: root,
      requestId: opened.request.requestId,
      via: "controlling-tty-phrase",
      at,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.reason).toMatch(/already completed/);
  });
});
