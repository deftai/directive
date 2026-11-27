import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArmDelegationInput,
  delegationStatePath,
  totpCodeForStep,
  totpStepAt,
  writeEnrolledSecret,
} from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_DELEGATION_HOST,
  extractClaudePromptSubmit,
  extractClaudeSessionEnd,
  runClaudeDelegateAdapter,
} from "./delegate-adapter-claude.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const T0 = new Date("2026-11-27T12:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function payload(prompt: string, session = "sess-1"): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    prompt,
    cwd: "/ignored",
    transcript_path: "/ignored",
  });
}

describe("Claude delegation adapter (#7420 clause 20)", () => {
  it("extracts only prompt text and session id", () => {
    expect(extractClaudePromptSubmit(payload("hello"))).toEqual({
      promptText: "hello",
      hostSessionId: "sess-1",
    });
    expect(
      extractClaudePromptSubmit(
        JSON.stringify({ hook_event_name: "PreToolUse", prompt: "x", session_id: "s" }),
      ),
    ).toBeNull();
    expect(extractClaudePromptSubmit("not json")).toBeNull();
    expect(
      extractClaudeSessionEnd(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s9" })),
    ).toBe("s9");
  });

  it("passes the core verb nothing but prompt text and session id (plus where the store is)", () => {
    const seen: ArmDelegationInput[] = [];
    const res = runClaudeDelegateAdapter({
      stdinText: payload("deft delegate on 123456"),
      projectRoot: "/proj",
      arm: (input) => {
        seen.push(input);
        return { kind: "not-a-command" };
      },
    });
    expect(res.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      projectRoot: "/proj",
      promptText: "deft delegate on 123456",
      hostSessionId: "sess-1",
      host: CLAUDE_DELEGATION_HOST,
    });
  });

  it("never blocks: a thrown arm still exits 0", () => {
    const res = runClaudeDelegateAdapter({
      stdinText: payload("deft delegate on 123456"),
      projectRoot: "/proj",
      arm: () => {
        throw new Error("boom");
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/not armed/);
  });

  it("arms through core, then a repeat of the same prompt is quiet", () => {
    const root = mkdtempSync(join(tmpdir(), "deleg-claude-"));
    roots.push(root);
    const secretPath = join(root, "cfg", "s.json");
    writeEnrolledSecret(
      secretPath,
      { secretBase32: SECRET, enrolledAt: "x", account: "op" },
      false,
    );
    const prompt = `deft delegate on ${totpCodeForStep(SECRET, totpStepAt(T0))}`;
    const seams = { now: T0, secretPath, storeRoot: root };
    const first = runClaudeDelegateAdapter({
      stdinText: payload(prompt),
      projectRoot: root,
      armSeams: seams,
    });
    expect(first.outcome?.kind).toBe("armed");
    const parsed = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(
      /^\[delegated-totp\] delegation armed/,
    );
    expect(existsSync(delegationStatePath(root))).toBe(true);
    const again = runClaudeDelegateAdapter({
      stdinText: payload(prompt),
      projectRoot: root,
      armSeams: seams,
    });
    expect(again.outcome?.kind).toBe("noop-replay");
    expect(again.stdout).toBe("");
  });

  it("is quiet for ordinary prompts", () => {
    const res = runClaudeDelegateAdapter({
      stdinText: payload("what next?"),
      projectRoot: "/proj",
    });
    expect(res.outcome?.kind).toBe("not-a-command");
    expect(res.stdout).toBe("");
  });
});
