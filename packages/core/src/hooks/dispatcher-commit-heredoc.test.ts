import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decideHook, type HookDecision, type HookPolicySeams } from "./dispatcher.js";

// End to end: the prospective-cover entry in the hook reads the same
// heredoc-stripped command as the exported #5656 detectors (#6187).

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

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

function seams(staged: string[]): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    loadStoryWriteFence: () => ({ fileScope: ["src/**"], denyPaths: [] }),
    listStagedRelPaths: () => staged,
  };
}

function decideBash(command: string, staged: string[] = []): HookDecision {
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: "/project",
      payload: { tool_name: "Bash", tool_input: { command } },
    },
    seams(staged),
  );
}

const NOTE_BODY = "- the hook refuses `cd <wt> && git commit -F <file>`; a standalone commit works";

describe("commit-shape check ignores heredoc bodies end to end (#6187)", () => {
  it("does not refuse a note whose quoted heredoc body names a commit", () => {
    const note = `cat >> /tmp/notes.md <<'NOTE'\n${NOTE_BODY}\nNOTE`;
    // The staged path is outside the story fence, so a real commit would be refused.
    const decision = decideBash(note, ["docs/out.md"]);
    expect(decision.code).not.toBe("prospective-scope-cover-deny");
  });

  it("still refuses a real -am commit after a heredoc that closes", () => {
    const command = `cat > /tmp/m.txt <<'EOF'\n${NOTE_BODY}\nEOF\ngit commit -am msg`;
    const decision = decideBash(command);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(decision.message).toMatch(/-a\/--all\/-am/);
  });

  it("still runs scope-cover for a real commit after a heredoc", () => {
    const command = "cat > /tmp/m.txt <<EOF\nmessage\nEOF\ngit commit -F /tmp/m.txt";
    const decision = decideBash(command, ["docs/out.md"]);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(decision.message).toMatch(/docs\/out\.md/);
  });

  it("refuses a commit named inside an executable unquoted heredoc body", () => {
    const command = "cat <<EOF\n$(\ngit commit -am msg\n)\nEOF";
    const decision = decideBash(command, ["src/a.ts"]);
    expect(decision).toMatchObject({ verdict: "deny", code: "prospective-scope-cover-deny" });
    expect(decision.message).toMatch(/unquoted heredoc body/);
  });
});
