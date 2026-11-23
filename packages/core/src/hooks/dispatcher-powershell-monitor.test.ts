import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { canonicalHostSessionId } from "../session/host-session-owner.js";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { COMMIT_TARGET_ACCEPTED_FORMS } from "./commit-target.js";
import { decideHook, type HookDecision, type HookPolicySeams } from "./dispatcher.js";
import {
  HOST_TOOL_SURFACE_AUDIT,
  isShellTool,
  matcherHasLiteralToken,
  SHELL_HOOK_MATCHER,
  SHELL_TOOL_NAMES,
} from "./tools.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// #6981: Claude Code's `PowerShell` and `Monitor` tools are shell tools, so every
// existing shell guard (kill-switch plant, protected-store write, commit target)
// reads their commands the way it reads `Bash`. PowerShell-only forms are #7050.

const SHELL_TOOLS_6981 = ["PowerShell", "Monitor"] as const;
const RAW_SESSION = "owner-6981";
const CLAUDE_OWNER = canonicalHostSessionId("claude", RAW_SESSION);
const kill = "." + ["deft", "directive", "disable"].join("-");
const authzStore = [".deft", "authz"].join("/");
const scopeStore = [".deft", "approved-scope"].join("/");

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

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function seams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => ({ ...READY_RITUAL, boundSessionId: CLAUDE_OWNER }),
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => resolve(path),
    loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
    loadAuthzState: () => ({ schemaVersion: 1, uat: null, activeGrantIds: [] }),
    loadAuthzGrants: () => [],
    authzAudit: false,
    ...overrides,
  };
}

// A release cut folds changelog.d fragments into CHANGELOG.md and deletes them,
// so read the fragment while it exists and the folded #6981 entry after that.
const FRAGMENT_6981 = "changelog.d/6981-powershell-monitor-shell-tools.md";

function changelogEntry6981(root: string): string {
  const fragment = join(root, FRAGMENT_6981);
  if (existsSync(fragment)) return readFileSync(fragment, "utf8");
  const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    .split(/\r?\n/)
    .filter((line) => /\(#6981\)\.?\s*$/.test(line));
  if (lines.length === 0) throw new Error(`no #6981 entry in ${FRAGMENT_6981} or CHANGELOG.md`);
  return lines.join("\n");
}

function ownerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hook-6981-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  applyWorktreeOccupancy(root, { sessionId: CLAUDE_OWNER, intent: "mutation" });
  return root;
}

function decide(
  toolName: string,
  command: string,
  root: string,
  overrides: Partial<HookPolicySeams> = {},
): HookDecision {
  return decideHook(
    {
      host: "claude",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: toolName, tool_input: { command }, session_id: RAW_SESSION },
      environ: { DEFT_SESSION_ID: CLAUDE_OWNER },
    },
    seams(overrides),
  );
}

describe("PowerShell and Monitor are shell tools (#6981)", () => {
  it("lists both names in the shell catalog and the deposited matcher", () => {
    for (const name of SHELL_TOOLS_6981) {
      expect(SHELL_TOOL_NAMES).toContain(name);
      expect(isShellTool(name)).toBe(true);
      expect(matcherHasLiteralToken(SHELL_HOOK_MATCHER, name)).toBe(true);
    }
  });

  it.each(SHELL_TOOLS_6981)("refuses a %s kill-switch plant through the existing guard", (tool) => {
    const command =
      tool === "PowerShell" ? `New-Item -Path ${kill} -ItemType File` : `touch ${kill}`;
    const decision = decide(tool, command, ownerRoot());
    expect(decision.verdict, command).toBe("deny");
    expect(decision.message).toMatch(/kill-switch|opt-out|human-origin|settings grant/i);
  });

  it.each([
    ["PowerShell", `Set-Content -Path ${authzStore}/x.json -Value x`],
    ["Monitor", `echo x > ${scopeStore}/x.json`],
  ])("refuses a %s write into a protected store through the existing guard", (tool, command) => {
    const decision = decide(tool, command, ownerRoot());
    expect(decision.verdict, command).toBe("deny");
    expect(decision.message).toMatch(/inventoried authz store|protected/i);
  });

  it("does not read the same command from a tool outside the shell list (control)", () => {
    const command = `Set-Content -Path ${authzStore}/x.json -Value x`;
    expect(isShellTool("PowerShellPreview")).toBe(false);
    const decision = decide("PowerShellPreview", command, ownerRoot());
    expect(decision.verdict, command).toBe("allow");
  });

  it.each(SHELL_TOOLS_6981)("refuses a %s commit after `cd <abs>;` as unresolvable", (tool) => {
    const listStagedRelPaths = vi.fn((_root: string): string[] => []);
    const command = "cd /elsewhere; git commit -m x";
    const decision = decide(tool, command, "/project", { listStagedRelPaths });
    expect(decision, command).toMatchObject({
      verdict: "deny",
      code: "prospective-scope-cover-deny",
    });
    expect(decision.message).toContain(COMMIT_TARGET_ACCEPTED_FORMS);
    expect(listStagedRelPaths).not.toHaveBeenCalled();
  });

  it.each([
    "Get-Content README.md",
    "Select-String -Path README.md -Pattern x",
    "Get-ChildItem -Recurse src",
  ])("admits the PowerShell read %j", (command) => {
    const decision = decide("PowerShell", command, ownerRoot());
    expect(decision.verdict, command).toBe("allow");
  });

  it("lists both names on the Claude audit shell row", () => {
    expect(HOST_TOOL_SURFACE_AUDIT.claude.mutation.shell).toEqual([
      "Bash",
      "PowerShell",
      "Monitor",
    ]);
  });

  it.each([
    ".claude/settings.json",
    ".codex/hooks.json",
    ".cursor/hooks.json",
    ".grok/hooks/deft.json",
  ])("deposits the new shell matcher in %s", (rel) => {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    expect(text).toContain(`"matcher": "${SHELL_HOOK_MATCHER}"`);
  });

  it("states the repair step, the two tools and the #7050 pointer in the docs and changelog", () => {
    const doc = readFileSync(join(REPO_ROOT, "content/docs/deft-directive-disable.md"), "utf8");
    const entry = changelogEntry6981(REPO_ROOT);
    for (const text of [doc, entry]) {
      expect(text).toContain("`PowerShell`");
      expect(text).toContain("`Monitor`");
      expect(text).toContain("directive install --repair");
      expect(text).toContain("#7050");
    }
    expect(doc).toMatch(/file-writing cmdlets and their aliases, program runners/);
  });

  it("reads the folded CHANGELOG.md entry once a release cut removes the fragment", () => {
    const bullet = changelogEntry6981(REPO_ROOT)
      .split(/\r?\n/)
      .find((line) => line.startsWith("- ") && line.includes("(#6981)"));
    expect(bullet).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "changelog-6981-"));
    temps.push(root);
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n- Complete #6981 after merge of #7084.\n",
    );
    expect(() => changelogEntry6981(root)).toThrow(/no #6981 entry/);
    writeFileSync(
      join(root, "CHANGELOG.md"),
      ["# Changelog", "", "### Fixed", "- Complete #6981 after merge of #7084.", bullet, ""].join(
        "\n",
      ),
    );
    expect(changelogEntry6981(root)).toBe(bullet);
    mkdirSync(join(root, "changelog.d"));
    writeFileSync(join(root, FRAGMENT_6981), "fragment wins while it exists\n");
    expect(changelogEntry6981(root)).toBe("fragment wins while it exists\n");
  });
});
