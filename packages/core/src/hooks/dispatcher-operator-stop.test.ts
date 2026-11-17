import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthzState } from "../authz/index.js";
import type { OperatorStopInput } from "../escalation/operator-stop.js";
import { listOpenEscalations } from "../escalation/store.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { decideHook, type HookPolicySeams } from "./dispatcher.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
  boundSessionId: "owner",
};

const UAT_ACTIVE: AuthzState = {
  schemaVersion: 1,
  uat: {
    active: true,
    campaignId: "uat-6275",
    startedAt: "2026-11-17T00:00:00.000Z",
    startedBy: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-11-17T00:00:00.000Z",
      mintedVia: "cli",
      eventRef: null,
    },
    suspendedAt: null,
    note: null,
  },
  activeGrantIds: [],
} as AuthzState;

function seams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({
      ready: true,
      path: "/project/xbrief/active/story.xbrief.json",
      message: "OK active scope",
    }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
    loadAuthzState: () => UAT_ACTIVE,
    loadAuthzGrants: () => [],
    authzAudit: false,
    ...overrides,
  };
}

function ownerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-6275-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  applyWorktreeOccupancy(root, { sessionId: "owner", intent: "mutation" });
  return root;
}

function writeSrc(root: string, s: HookPolicySeams) {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: {
        tool_name: "Write",
        tool_input: { file_path: join(root, "src", "a.ts"), contents: "x" },
      },
      environ: { DEFT_SESSION_ID: "owner" },
    },
    s,
  );
}

describe("authz-grant deny records an operator stop (#6275 limb 2)", () => {
  it("records the exact authz:grant command and leaves the verdict unchanged", () => {
    const root = ownerRoot();
    const recorded: OperatorStopInput[] = [];
    const withRecord = writeSrc(root, seams({ recordOperatorStop: (i) => recorded.push(i) }));
    const without = writeSrc(root, seams({ recordOperatorStop: () => undefined }));
    expect(withRecord.verdict).toBe("deny");
    expect(withRecord.code).toMatch(/^authz-grant-/);
    expect(withRecord).toEqual(without);
    expect(recorded).toHaveLength(1);
    const stop = recorded[0] as OperatorStopInput;
    expect(stop).toMatchObject({ kind: "mint", code: withRecord.code, sessionId: "owner" });
    expect(stop.projectRoot).toBe(resolve(root));
    expect(stop.commands[0]).toMatch(
      /; deft authz:grant -- --operations edit --surfaces \S+ --confirm$/,
    );
    expect(stop.commands[0]).toContain("src/a.ts");
  });

  it("a recorder that throws never changes the verdict", () => {
    const root = ownerRoot();
    const decision = writeSrc(
      root,
      seams({
        recordOperatorStop: () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(decision.verdict).toBe("deny");
  });

  it("with the default recorder and the notifier off, nothing is written under .deft/escalations", () => {
    const root = ownerRoot();
    const decision = writeSrc(root, seams());
    expect(decision.verdict).toBe("deny");
    expect(readdirSync(join(root, ".deft"))).not.toContain("escalations");
    expect(listOpenEscalations(root)).toEqual([]);
  });

  it("does not record non-grant denies or allows", () => {
    const root = ownerRoot();
    const recorded: OperatorStopInput[] = [];
    const allowed = writeSrc(
      root,
      seams({
        loadAuthzState: () => ({ schemaVersion: 1, uat: null, activeGrantIds: [] }) as AuthzState,
        recordOperatorStop: (i) => recorded.push(i),
      }),
    );
    expect(allowed.verdict).toBe("allow");
    expect(recorded).toEqual([]);
  });
});
