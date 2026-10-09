import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateRuleToVerbParity,
  expandFamilyGlob,
  extractRuleCitations,
  firstInvocationToken,
  loadRegisteredCliVerbs,
  RULE_TO_VERB_PARITY_GATE_ID,
  SCM_BODY_FAMILY_MEMBERS,
  taskNameResolves,
} from "./rule-to-verb-parity.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("rule-to-verb-parity (#5521)", () => {
  it("firstInvocationToken strips flags and trailing punctuation", () => {
    expect(firstInvocationToken("scm:body:issue:fetch --out-file")).toBe("scm:body:issue:fetch");
    expect(firstInvocationToken("verify:docs-impact.")).toBe("verify:docs-impact");
    expect(firstInvocationToken("")).toBeNull();
  });

  it("expands scm:body:* family glob to eight members", () => {
    const expanded = expandFamilyGlob("scm:body:*");
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) throw new Error("expected expand");
    expect(expanded.members).toEqual([...SCM_BODY_FAMILY_MEMBERS]);
    expect(expanded.members).toHaveLength(8);
  });

  it("refuses unknown family globs (no naive literal-only green)", () => {
    const refused = expandFamilyGlob("swarm:*");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected refuse");
    expect(refused.reason).toMatch(/not expandable/);
  });

  it("keeps named family globs through extract so expandFamilyGlob can refuse", () => {
    const text = [
      "! Do not cite `deft swarm:*` as a catch-all.",
      "! Prefer `task deft:*` as the generic placeholder.",
    ].join("\n");
    const citations = extractRuleCitations("fixture.md", text);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "swarm:*")).toBe(true);
    expect(citations.some((c) => c.raw === "deft:*" || c.raw === "*")).toBe(false);
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) return `${text}\n`;
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      cliVerbs: new Set(["check"]),
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.kind === "glob" && f.name === "swarm:*")).toBe(true);
  });

  it("extracts deft and task citations from template prose", () => {
    const text = [
      "! Use `deft scm:body:issue:fetch --out-file` then `deft scm:body:issue:edit --body-file`.",
      "! Also `task scm:body:issue:lint` and `deft scm:body:* --body-file`.",
      "Prose mention without ticks is ignored: deft check",
    ].join("\n");
    const citations = extractRuleCitations("fixture.md", text);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "scm:body:issue:fetch")).toBe(true);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "scm:body:*")).toBe(true);
    expect(citations.some((c) => c.kind === "task" && c.raw === "scm:body:issue:lint")).toBe(true);
  });

  it("extracts bare deft/task lines from fenced code blocks", () => {
    const text = [
      "Use the wrapper:",
      "```bash",
      'deft scm:body:issue:fetch --repo OWNER/REPO --issue 1 --out-file "$bodyFile"',
      'task scm:body:issue:edit --repo OWNER/REPO --issue 1 --body-file "$bodyFile"',
      "4. Also `deft pr:watch -- <N>` inside the fence.",
      "```",
      "Inline still works: `deft check`.",
    ].join("\n");
    const citations = extractRuleCitations("fixture.md", text);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "scm:body:issue:fetch")).toBe(true);
    expect(citations.some((c) => c.kind === "task" && c.raw === "scm:body:issue:edit")).toBe(true);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "pr:watch")).toBe(true);
    expect(citations.some((c) => c.kind === "deft" && c.raw === "check")).toBe(true);
  });

  it("refuses multi-colon dead spellings that only match via replaceAll hyphenation", () => {
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) {
          return "! Run `deft rule:to:verb:parity`.\n";
        }
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      // Registered hyphen stem must NOT green the multi-colon dead spelling.
      cliVerbs: new Set(["rule-to-verb-parity", "check"]),
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.name === "rule:to:verb:parity")).toBe(true);
  });

  it("loads registered CLI verbs including SUBCOMMAND_ROUTES scm:body:*", () => {
    const verbs = loadRegisteredCliVerbs(REPO_ROOT);
    expect(verbs.has("scm:body:issue:fetch")).toBe(true);
    expect(verbs.has("github-body")).toBe(true);
    expect(verbs.has("check")).toBe(true);
    expect(verbs.has("scope:promote")).toBe(true);
    // Deferred/stubbed top-level UX verbs must not green dead citations.
    expect(verbs.has("feature")).toBe(false);
  });

  it("loads router-branch colon verbs (framework:doctor, scm:issue:work-claim)", () => {
    const verbs = loadRegisteredCliVerbs(REPO_ROOT);
    expect(verbs.has("framework:doctor")).toBe(true);
    expect(verbs.has("scm:issue:work-claim")).toBe(true);
    expect(verbs.has("agents:refresh")).toBe(true);
  });

  it("excludes deferred and stubbed TOP_LEVEL_UX_VERBS from the registry set", () => {
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) return "! Run `deft feature`.\n";
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        if (p.endsWith("route-argv.ts")) {
          return [
            'export const TOP_LEVEL_UX_VERBS = ["check", "feature"] as const;',
            "export const STUBBED_TOP_LEVEL_VERBS = new Set<string>([]);",
            'export const DEFERRED_TOP_LEVEL_VERBS = new Set<string>(["feature"]);',
            "export const SUBCOMMAND_ROUTES = {};",
            "export const PR_VERB_MAP = {};",
            "export const VERIFY_VERB_MAP = {};",
            "export const SCOPE_LIFECYCLE_VERBS = new Set([]);",
          ].join("\n");
        }
        if (p.endsWith("dispatch.ts")) {
          return [
            'export const CLI_MODULE_VERBS = ["check"] as const;',
            "export const CORE_MODULE_VERBS = [];",
            "export const VERB_ALIASES = {};",
          ].join("\n");
        }
        return "";
      },
      exists: () => true,
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.name === "feature")).toBe(true);
  });

  it("does not invent policy:<POLICY_SET_COMMANDS> spellings as CLI verbs", () => {
    const verbs = loadRegisteredCliVerbs(REPO_ROOT);
    expect(verbs.has("policy:show")).toBe(true);
    expect(verbs.has("policy:wip-cap")).toBe(false);
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) return "! Run `deft policy:wip-cap`.\n";
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.name === "policy:wip-cap")).toBe(true);
  });

  it("resolves framework task scm:body:issue:fetch from tasks/scm.yml", () => {
    expect(taskNameResolves(REPO_ROOT, "scm:body:issue:fetch")).toBe(true);
    expect(taskNameResolves(REPO_ROOT, "scm:body:missing:verb")).toBe(false);
  });

  it("requires a complete Taskfile key (no prefix match)", () => {
    // `body:issue:fetch` exists; a prefix citation must not green.
    expect(taskNameResolves(REPO_ROOT, "scm:body:issue")).toBe(false);
    expect(taskNameResolves(REPO_ROOT, "scm:body:issue:fetch")).toBe(true);
  });

  it("does not treat Taskfile include namespaces as root tasks", () => {
    // `includes: scm:` must not green a bare `task scm` citation.
    expect(taskNameResolves(REPO_ROOT, "scm")).toBe(false);
  });

  it("passes on the live agents-entry + preamble templates after aliases", () => {
    const result = evaluateRuleToVerbParity(REPO_ROOT);
    expect(result.ok, result.message).toBe(true);
    expect(result.code).toBe(0);
    expect(result.message).toContain(RULE_TO_VERB_PARITY_GATE_ID);
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it("fails when a concrete deft verb is missing from the CLI registry", () => {
    const files: Record<string, string> = {
      [join(REPO_ROOT, "content/templates/agents-entry.md")]:
        "! Run `deft totally-missing:verb` now.\n",
      [join(REPO_ROOT, "content/templates/agent-prompt-preamble.md")]: "# empty\n",
      [join(REPO_ROOT, "packages/cli/src/dispatch.ts")]:
        'export const CLI_MODULE_VERBS = ["check"] as const;\nexport const CORE_MODULE_VERBS = [];\n',
      [join(REPO_ROOT, "packages/cli/src/cli-router/route-argv.ts")]:
        'export const TOP_LEVEL_UX_VERBS = ["check"] as const;\nexport const SUBCOMMAND_ROUTES = {};\n',
      [join(REPO_ROOT, "Taskfile.yml")]: "includes:\n  scm:\n    taskfile: tasks/scm.yml\n",
      [join(REPO_ROOT, "tasks/scm.yml")]: "tasks:\n  body:issue:fetch:\n    cmds: []\n",
    };
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      exists: (p) => p in files || p.endsWith("Taskfile.yml") || p.includes("tasks"),
      readText: (p) => files[p] ?? null,
      cliVerbs: new Set(["check"]),
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.name === "totally-missing:verb")).toBe(true);
  });

  it("fails when a body-family member is omitted from registration", () => {
    const partial = new Set<string>(
      SCM_BODY_FAMILY_MEMBERS.filter((m) => m !== "scm:body:pr:lint"),
    );
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) {
          return "! Use `deft scm:body:* --body-file`.\n";
        }
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      cliVerbs: partial,
      taskResolves: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.name === "scm:body:pr:lint")).toBe(true);
  });

  it("fails when a namespaced task is missing", () => {
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) {
          return "! Run `task scm:body:issue:fetch`.\n";
        }
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      cliVerbs: new Set(SCM_BODY_FAMILY_MEMBERS),
      taskResolves: (name) => name !== "scm:body:issue:fetch",
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.kind === "task" && f.name === "scm:body:issue:fetch"),
    ).toBe(true);
  });

  it("accepts a valid top-level/scope command citation", () => {
    const result = evaluateRuleToVerbParity(REPO_ROOT, {
      readText: (p) => {
        if (p.endsWith("agents-entry.md")) {
          return "! Run `deft check` and `deft scope:promote`.\n";
        }
        if (p.endsWith("agent-prompt-preamble.md")) return "# ok\n";
        return "";
      },
      exists: () => true,
      cliVerbs: new Set(["check", "scope:promote"]),
      taskResolves: () => true,
    });
    expect(result.ok, result.message).toBe(true);
  });
});
