import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearWriteFenceMemosForTests } from "../policy/write-fence.js";
import { buildApprovedScopeRecord } from "../scope-provenance/digest.js";
import { extractIntentFromRaw } from "../scope-provenance/extract-intent.js";
import { computeAuthHashV1 } from "../scope-provenance/forge-approval.js";
import { computeIntentDigest } from "../scope-provenance/intent-digest.js";
import type { GitRunner } from "../session/git.js";
import {
  DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  newRitualStatePayload,
  ritualStep,
  writeRitualState,
} from "../session/index.js";
import { decideHook, type HookPolicySeams, renderHostDecision } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "write-gate-dispatch-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return root;
}

function fakeGit(root: string, head = HEAD, calls?: string[][]): GitRunner {
  const worktree = resolve(root);
  return (_r, args) => {
    calls?.push([...args]);
    if (args.includes("--show-toplevel") && args.includes("--abbrev-ref")) {
      return {
        code: 0,
        stdout: `${head}\n${worktree}\nfix/3736-hook-latency`,
        stderr: "",
      };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") {
      return { code: 0, stdout: "fix/3736-hook-latency", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function seedCleanRearmRitual(root: string, now: Date): void {
  writeRitualState(root, {
    ...newRitualStatePayload({
      sessionId: "s",
      gitHead: HEAD,
      worktreePath: resolve(root),
      startedAt: now,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: now }),
        branch_policy: ritualStep({ ok: true, ts: now }),
        triage_welcome: ritualStep({ ok: true, ts: now }),
        verify_tools: ritualStep({ ok: true, ts: now }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts: now }),
        doctor: ritualStep({ ok: true, ts: now }),
        cache_fresh: ritualStep({ ok: true, ts: now }),
      },
    }),
    drift_probe: DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  });
}

describe("write-gate dispatch surface (#3738)", () => {
  it("renders allow on the clean-cache re-arm path without forge I/O", () => {
    const root = tempRoot();
    const now = new Date();
    seedCleanRearmRitual(root, now);
    const commands: string[][] = [];
    const gitCalls: string[][] = [];

    const seams: HookPolicySeams = {
      inspectScope: () => ({
        ready: true,
        path: join(root, "xbrief", "active", "story.xbrief.json"),
        message: "OK active scope",
      }),
      // #5656: fixture stubs lack merge-base fence bytes; default positive allow.
      loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
      ritualRunGit: fakeGit(root, HEAD, gitCalls),
      detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
      ritualRunner: (command) => {
        commands.push([...command]);
        if (command[0] === "verify:cache-fresh" || command[0] === "doctor") {
          throw new Error(`write path must not execute ${command[0]}`);
        }
        return { code: 0, stdout: "hooks ready", stderr: "" };
      },
    };

    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Write", file_path: join(root, "src", "app.ts") },
      },
      seams,
    );
    const wire = renderHostDecision("cursor", decision);

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(JSON.parse(wire)).toMatchObject({ permission: "allow", code: "write-ready" });
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(commands.some((command) => command[0] === "verify:cache-fresh")).toBe(false);
    // #3736: five spawns before, one now. Stated as a count rather than a
    // duration because wall clock on this path is a function of machine load.
    expect(gitCalls).toEqual([["rev-parse", "HEAD", "--show-toplevel", "--abbrev-ref", "HEAD"]]);
  });

  it("keeps its git cost flat as concurrent tool calls pile up (#3736)", () => {
    const root = tempRoot();
    seedCleanRearmRitual(root, new Date());
    const gitCalls: string[][] = [];
    const runGit = fakeGit(root, HEAD, gitCalls);

    const seams: HookPolicySeams = {
      inspectScope: () => ({
        ready: true,
        path: join(root, "xbrief", "active", "story.xbrief.json"),
        message: "OK active scope",
      }),
      // #5656: fixture stubs lack merge-base fence bytes; default positive allow.
      loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
      ritualRunGit: runGit,
      detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
      ritualRunner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    };

    const toolCalls = 7;
    for (let i = 0; i < toolCalls; i += 1) {
      expect(
        decideHook(
          {
            host: "cursor",
            event: "tool.before",
            projectRoot: root,
            payload: { toolName: "Write", file_path: join(root, "src", `app-${i}.ts`) },
          },
          seams,
        ),
      ).toMatchObject({ verdict: "allow", code: "write-ready" });
    }

    // The load the hook itself adds to the host grows with the number of tool
    // calls, so its per-call spawn count has to be a constant, not a multiple.
    // Concurrent agents were paying 5 spawns each; this holds the line at 1.
    expect(gitCalls).toHaveLength(toolCalls);
  });
});

describe("write gate on a one-PR mint brief through the real fence loader (#6361)", () => {
  const PLAN_ID = "s-6361";
  const BRIEF_REL = "xbrief/active/s-6361.xbrief.json";
  const RECORD_REL = `.deft/approved-scope/${PLAN_ID}.json`;
  const INTENT_REL = `.deft/approved-scope/${PLAN_ID}.intent.json`;
  const SCOPE = ["src/a.ts", RECORD_REL, INTENT_REL];
  const prevDeft = process.env.DEFT_BASE_REF;
  const prevGithub = process.env.GITHUB_BASE_REF;

  afterEach(() => {
    clearWriteFenceMemosForTests();
    if (prevDeft === undefined) delete process.env.DEFT_BASE_REF;
    else process.env.DEFT_BASE_REF = prevDeft;
    if (prevGithub === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = prevGithub;
  });

  function write(root: string, rel: string, text: string): void {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }

  function brief(scope: readonly string[]): Record<string, unknown> {
    return {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: PLAN_ID,
        title: "S",
        status: "running",
        metadata: { swarm: { file_scope: scope } },
      },
    };
  }

  /** origin/master sets onePrScopeProof=mint with no brief; the branch holds brief + human mint. */
  function mintRepo(): string {
    const root = tempRoot();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@t.local");
    git("config", "user.name", "T");
    write(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        plan: { title: "t", status: "running", policy: { onePrScopeProof: "mint" } },
      }),
    );
    git("add", "xbrief");
    git("commit", "-q", "-m", "base");
    const bare = tempRoot();
    execFileSync("git", ["clone", "--bare", "-q", root, join(bare, "o.git")]);
    git("remote", "add", "origin", join(bare, "o.git"));
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-b", "feature/6361");
    const payload = brief(SCOPE);
    write(root, BRIEF_REL, JSON.stringify(payload));
    const extracted = extractIntentFromRaw(JSON.stringify(payload), {});
    if (!extracted.ok) throw new Error(extracted.error);
    const record = {
      ...buildApprovedScopeRecord({
        xbriefRelPath: BRIEF_REL,
        payload,
        humanApproval: { kind: "operator", actor: "scott", mintedAt: "2026-11-16T00:00:00Z" },
        intentDigest: computeIntentDigest(extracted.preimage),
        digestAlgo: "intent-extract-v1",
      }),
      authHashV1: computeAuthHashV1(payload, BRIEF_REL) ?? "",
    };
    write(root, RECORD_REL, JSON.stringify(record));
    write(root, INTENT_REL, JSON.stringify(extracted.preimage));
    seedCleanRearmRitual(root, new Date());
    delete process.env.DEFT_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    clearWriteFenceMemosForTests();
    return root;
  }

  function writeTo(root: string, rel: string, toolName = "Write") {
    const seams: HookPolicySeams = {
      inspectScope: () => ({
        ready: true,
        path: join(root, ...BRIEF_REL.split("/")),
        message: "OK",
      }),
      // No loadStoryWriteFence seam: the production loader reads the real repo.
      ritualRunGit: fakeGit(root),
      detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
      ritualRunner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    };
    return decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName, file_path: join(root, ...rel.split("/")) },
      },
      seams,
    );
  }

  it("admits a Write inside the minted file_scope", () => {
    const root = mintRepo();
    expect(writeTo(root, "src/a.ts")).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(writeTo(root, "src/a.ts", "Edit")).toMatchObject({ verdict: "allow" });
  });

  it("refuses a Write outside the minted file_scope", () => {
    const root = mintRepo();
    expect(writeTo(root, "src/b.ts")).toMatchObject({ verdict: "deny" });
  });

  it("refuses Write and Edit to the mint record even though file_scope lists it", () => {
    const root = mintRepo();
    for (const tool of ["Write", "Edit"]) {
      for (const rel of [RECORD_REL, INTENT_REL]) {
        const decision = writeTo(root, rel, tool);
        expect(decision).toMatchObject({ verdict: "deny", code: "authz-uat-deny" });
      }
    }
  });

  it("refuses the next Write with the mint reject reason after the brief is edited", () => {
    const root = mintRepo();
    expect(writeTo(root, "src/a.ts")).toMatchObject({ verdict: "allow" });
    write(root, BRIEF_REL, JSON.stringify(brief([...SCOPE, "src/widened.ts"])));
    const decision = writeTo(root, "src/a.ts");
    expect(decision).toMatchObject({ verdict: "deny", code: "scope-not-ready" });
    expect(decision.message).toContain("record fileScope differs from the head brief file_scope");
    expect(decision.message).toContain("scope:record-approved-scope");
    expect(decision.message).not.toMatch(/scope:promote|scope:activate/);
  });
});
