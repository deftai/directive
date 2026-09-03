import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_READBACK_SUPPRESSION_HOURS } from "../../eval/readback.js";
import { VALUE_READBACK_SUPPRESSION_HOURS } from "../../value/readback.js";
import { readRepoFile, readSwarmSkillSurface, repoFileExists, resolveRepoPath } from "./helpers.js";

/** Port of tests/content/test_agents_entry_contract.py (#768, #1309, #2111, #2371). */

const OPEN_MARKER = "<!-- deft:managed-section v3 -->";
const CLOSE_MARKER = "<!-- /deft:managed-section -->";
const FIXTURES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "agents-md",
);

const PROPAGATION_COMMAND_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["deft session:start", "task session:start"],
  ["deft session:ready", "task session:ready"],
  ["deft verify:session-ritual", "task verify:session-ritual"],
  ["deft verify:tools", "task verify:tools"],
  ["deft triage:welcome --onboard", "task triage:welcome --onboard"],
  ["deft triage:queue", "task triage:queue"],
  ["deft verify:cache-fresh", "task verify:cache-fresh"],
  ["deft codebase:map", "task codebase:map"],
  ["deft verify:codebase-map-fresh", "task verify:codebase-map-fresh"],
  ["deft verify:branch", "task verify:branch"],
  ["deft verify:forward-coverage", "task verify:forward-coverage"],
  ["deft verify:story-ready", "task verify:story-ready"],
  ["deft doctor", "task doctor"],
  ["deft agents:refresh", "task agents:refresh"],
  ["deft packs:slice --list-packs", "deft packs:slice --list-packs"],
  ["npm i -g @deftai/directive@latest", "npm i -g @deftai/directive@latest"],
  ["git status --short --branch", "git status --short --branch"],
  ["deft scope:promote -- <path>", "task scope:promote -- <path>"],
  ["deft scope:activate -- <path>", "task scope:activate -- <path>"],
  ["deft scope:complete -- <active-story-path>", "task scope:complete -- <active-story-path>"],
  ["deft umbrella:current-shape", "task umbrella:current-shape"],
  ["deft xbrief:preflight", "task xbrief:preflight"],
  ["deft policy:enable-value-feedback", "task policy:enable-value-feedback"],
  ["deft policy:show --field=valueFeedback", "task policy:show --field=valueFeedback"],
  ["deft value:show", "task value:show"],
  ["deft eval:health", "task eval:health"],
  ["deft eval:run", "task eval:run"],
  ["deft eval:triggers", "task eval:triggers"],
  ["deft eval:report", "task eval:report"],
  ["deft feedback:file", "task feedback:file"],
  ["deft migrate:xbrief", "deft migrate:xbrief"],
  ['"version": "0.8"', '"version": "0.8"'],
  ["xbrief/PROJECT-DEFINITION.xbrief.json", "xbrief/PROJECT-DEFINITION.xbrief.json"],
  ["xbrief/active/", "xbrief/active/"],
];

const CONSUMER_FORBIDDEN_BARE_TASK_MARKERS = [
  "task session:start",
  "task session:ready",
  "task verify:session-ritual",
  "task verify:tools",
  "task doctor",
  "task agents:refresh",
  "task triage:welcome",
  "task triage:queue",
  "task verify:cache-fresh",
  "task codebase:map",
  "task verify:codebase-map-fresh",
  "task verify:branch",
  "task verify:forward-coverage",
  "task verify:story-ready",
  "task policy:show",
  "task policy:enforce-branches",
  "task policy:allow-direct-commits",
  "task policy:enable-value-feedback",
  "task value:show",
  "task feedback:file",
  "task scope:promote",
  "task scope:activate",
  "task scope:complete",
  "task scope:demote",
  "task xbrief:preflight",
  "task xbrief:activate",
  "task framework:doctor",
  "task check",
  "task setup",
  "task verify:hooks-installed",
] as const;

const PROPAGATION_POLICY_KEY_MARKERS = [
  "plan.policy.wipCap",
  "plan.policy.allowDirectCommitsToMaster",
  "plan.policy.sessionRitualStalenessHours",
  "plan.policy.forgeOutageRetryMinutes",
  "plan.policy.valueFeedback",
  "plan.policy.requireHumanMerge",
] as const;

const PROPAGATION_HEADER_MARKERS = [
  "## Temporary test kill-switch (#3039)",
  "## Session routing (#2176)",
  "## Session-start ritual (#1149)",
  "## Unmanaged project header (#2065)",
  "## Cache-as-authoritative work selection (#1149)",
  "## Deterministic questions runtime obligation (#1470)",
  "## Skills",
  "## Skill pin policy (#2508)",
  "## Rule Authority [AXIOM]",
  "## Thin Fail-Closed Design (#3265)",
  "## Writing bar (#3368)",
  "## Through-merge worker dispatch (#3032)",
  "## Mid-scope gate capability tier (#3158 / #954)",
  "## WIP cap",
  "## Codebase MAP Projection (#1595 / #1498)",
  "### Story Start Gate",
  "## Contextual guardrails (runtime-detect lazy-load)",
  "## Content packs",
] as const;

/** Always-on mid-scope gate capability tier (#3158) — retain vs split-dispatch. */
const MID_SCOPE_GATE_CAPABILITY_TIER_MARKERS = [
  "Mid-scope gate capability tier (#3158 / #954)",
  "split-dispatch",
  "continue-by-agent-id",
  "message-later",
  "constitution self-edit",
] as const;

/** Always-on temporary kill-switch (#3039) — check before further DD process load. */
const DEFT_DIRECTIVE_DISABLE_MARKERS = [
  "Temporary test kill-switch (#3039)",
  ".deft-directive-disable",
  "NEW agent session",
  "no-deft-directive",
] as const;

/**
 * Always-on hook-runtime lockout card (#3785). A session denied on exit 127
 * can still read files, so this card is the only channel that reaches it: it
 * must name the out-of-band recovery and forbid the failClosed hand-edit,
 * which the next `deft update` silently reverts.
 */
const HOOK_RUNTIME_UNAVAILABLE_MARKERS = [
  "Hook runtime unavailable (#3785)",
  "is not executable on this host",
  "policy:disable-host-hooks --host cursor --confirm",
  "hook-runtime-unavailable.md",
  "silently re-arms the lockout",
] as const;

/** Always-on through-merge dispatch doctrine (#3032) — parent must not implement. */
/** Pointer bodies for Rule Authority / #3265 — headings alone are not enough (#3313). */
const RULE_AUTHORITY_THIN_FAIL_CLOSED_POINTER_MARKERS = [
  "Prefer `task deft:*` over AGENTS.md prose",
  "One fail-closed `task deft:*` check + one remediation",
] as const;

/** Always-on writing bar (#3368) — three words must stay in the line. */
const WRITING_BAR_MARKERS = [
  "Clarity, simplicity, brevity",
  "documents and user communications",
  "sub-agent status and handbacks",
  "writing-ste100.md",
] as const;

const THROUGH_MERGE_DISPATCH_MARKERS = [
  "Through-merge worker dispatch (#3032)",
  "drive-to: merge-ready",
  "cohort size is 1",
  "swarm/solo-worker launch path",
  "Parent conversation implements or babysits",
] as const;

/** After-merge one-origin orphan-active DONE gate (#3429). */
const AFTER_MERGE_ORPHAN_ACTIVE_MARKERS = [
  "verify:orphan-active -- --issue",
  "ISSUE: closed",
  "#3429",
  "unresolved",
] as const;

/** Drive-to DONE completed-tracked on delivery tip (#3476). */
const AFTER_MERGE_COMPLETED_TRACKED_MARKERS = [
  "verify:completed-tracked -- --issue",
  "origin/<deliveryBranch>",
  "#3476",
  "swarm:finalize-cohort",
] as const;

const PROPAGATION_ACTION_VERBS = [
  "build",
  "implement",
  "ship",
  "swarm",
  "run agents",
  "start agent",
] as const;

const SKILLS_POINTER_MARKERS = ["## Skills", "Skills Index", "packs:slice skills list"] as const;

const INDEXED_SKILL_IDS = [
  "deft-directive-setup",
  "deft-directive-cost",
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-swarm",
  "deft-directive-decompose",
  "deft-directive-refinement",
  "deft-directive-triage",
  "deft-directive-sync",
  "deft-directive-interview",
  "deft-directive-probe",
  "deft-directive-debug",
  "deft-directive-glossary",
  "deft-directive-gh-arch",
  "deft-directive-gh-slice",
  "deft-directive-release",
  "deft-directive-write-skill",
  "deft-directive-article-review",
  "deft-directive-feedback",
] as const;

const DEFAULT_ALWAYS_PIN_SKILL_IDS = [
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-swarm",
] as const;

const SKILL_PIN_ANTI_PATTERN_MARKERS = [
  "Pin entire language packs",
  "false-negative-sensitive process gates",
] as const;

const UNMANAGED_HEADER_MARKERS = [
  "Do NOT treat the unmanaged AGENTS.md header as the work queue",
  "Do NOT add `Status`, `Next:`, or `Known Issues` blocks",
  "Session orientation",
] as const;

const SHELL_ORIENTATION_MARKERS = ["Detect OS/shell", "portable syntax", "explicit shell"] as const;

/** Not yet relocated to pointer form — retain full-text markers until Wave 2 (#2454). */
const PROPAGATION_UMBRELLA_STATUS_MARKERS = [
  "claim-cites-state-surface",
  "issues/<N>/comments",
  "Conclude umbrella or epic status from the issue body alone",
] as const;

type PointerShape = "skill" | "gate" | "doc";

interface PointerRuleSpec {
  id: string;
  shape: PointerShape;
  header: string;
  canonicalHome: string;
  pointerHints: readonly string[];
  canonicalBodyMarkers: readonly string[];
  /** Full-text markers that must NOT appear in the managed section once relocated (#2371). */
  retiredFullTextMarkers?: readonly string[];
}

/** Relocated rules: pointer-sufficient always-on surface (#2371 / #2369 DD-1). */
const POINTER_RELOCATED_RULES: readonly PointerRuleSpec[] = [
  {
    id: "review-surface-2308",
    shape: "skill",
    header: "Review-surface precedence (#2308)",
    canonicalHome: "skills/deft-directive-review-cycle/SKILL.md",
    pointerHints: [
      "deft-directive-review-cycle",
      "SKILL.md",
      "advisory",
      "#2308",
      "#2261",
      "babysit",
    ],
    canonicalBodyMarkers: ["deft-directive-review-cycle", "Greptile", "review cycle"],
    retiredFullTextMarkers: [
      "wrong-review-surface class",
      "harness-aware-reviewer path",
      "or any future host equivalent",
    ],
  },
  {
    id: "value-feedback-1709",
    shape: "skill",
    header: "Value feedback and attribution (#1709)",
    canonicalHome: "skills/deft-directive-feedback/SKILL.md",
    pointerHints: ["deft-directive-feedback", "SKILL.md", "plan.policy.valueFeedback", "#1709"],
    canonicalBodyMarkers: ["plan.policy.valueFeedback", "deft-directive-feedback", "attributed"],
    retiredFullTextMarkers: [
      "DEFT_VALUE_SELF_DOGFOOD",
      "without operator confirmation",
      "DEFT_VALUE_AUTOENABLE_ORGS",
    ],
  },
  {
    id: "eval-framework-1703",
    shape: "gate",
    header: "Eval and framework health (#1703)",
    canonicalHome: "packages/core/src/eval/health.ts",
    pointerHints: ["eval:health", "Tier 0", "#1703"],
    canonicalBodyMarkers: ["health-history", "contradictory"],
    retiredFullTextMarkers: ["crud-metrics.jsonl", "health-history.jsonl", "Tier 2"],
  },
  {
    id: "deterministic-questions-1470",
    shape: "doc",
    header: "Deterministic questions runtime obligation (#1470)",
    canonicalHome: "contracts/deterministic-questions.md",
    pointerHints: ["contracts/deterministic-questions.md", "Discuss", "Back", "#1470"],
    canonicalBodyMarkers: ["Discuss` and `Back`", "final two numbered options"],
    retiredFullTextMarkers: [
      "NOT substitutes for `Discuss`",
      "ask_user_question",
      "Emit a structured or numbered question without",
    ],
  },
  {
    id: "session-ritual-1149",
    shape: "doc",
    header: "Session-start ritual (#1149)",
    canonicalHome: "commands.md",
    pointerHints: [
      "deft session:start",
      "deft verify:session-ritual",
      "deft session:ready",
      "#1149",
    ],
    canonicalBodyMarkers: [
      "sessionRitualStalenessHours",
      "DEFT_SESSION_RITUAL_SKIP",
      "ritual-state.json",
    ],
    retiredFullTextMarkers: [
      "lazily records the doctor and cache-fresh Python entrypoints",
      "D2 4-hour suppression window",
      "triage:welcome` implementation (#1143 / #1279)",
    ],
  },
  {
    id: "wip-cap-2319",
    shape: "skill",
    header: "WIP cap",
    canonicalHome: "skills/deft-directive-swarm/SKILL.md",
    pointerHints: ["plan.policy.wipCap", "deft scope:demote", "#1121"],
    canonicalBodyMarkers: ["plan.policy.wipCap", "scope:demote --batch", "wip_cap_override"],
    retiredFullTextMarkers: ["raised from the original 10 per umbrella", "Phase 4 wipCap prompt"],
  },
  {
    id: "branch-policy-746",
    shape: "doc",
    header: "Branch policy & branch verification",
    canonicalHome: "scm/github.md",
    pointerHints: ["deft verify:branch", "#746", "#747"],
    canonicalBodyMarkers: ["allowDirectCommitsToMaster", "verify:branch", "pre-commit"],
    retiredFullTextMarkers: [
      "deft check:framework-source",
      "forward-coverage gate (#1310)",
      "Mirrors the `deft verify:encoding`",
    ],
  },
  {
    id: "branch-disclosure-746",
    shape: "doc",
    header: "Branch Policy Disclosure (#746)",
    canonicalHome: "scm/github.md",
    pointerHints: ["deft policy:show --field=allowDirectCommitsToMaster", "#746"],
    canonicalBodyMarkers: [
      "Direct commits to the default branch are ENABLED",
      "allowDirectCommitsToMaster",
    ],
    retiredFullTextMarkers: [
      "Override paths (`deft policy:show`",
      "absence of the disclosure line itself signals",
    ],
  },
  {
    id: "implementation-intent-810",
    shape: "doc",
    header: "Implementation Intent Gate (#810 / #1193)",
    canonicalHome: "commands.md",
    pointerHints: [
      "deft xbrief:preflight",
      "action-verb",
      "#810",
      "#1193",
      "DEFT_SESSION_SLASH_VERB",
    ],
    canonicalBodyMarkers: [
      "xbrief:preflight",
      'plan.status == "running"',
      "Slash-command intent containment",
      "DEFT_SESSION_SLASH_VERB",
    ],
    retiredFullTextMarkers: [
      "Workflow-shape vocabulary is NOT authorization",
      "Broad approval is not a substitute",
      "pre-`start_agent` gate stack (#1149/#1348)",
      "deft verify:cache-fresh` is gate-stack step 3",
    ],
  },
  {
    id: "writing-bar-3368",
    shape: "doc",
    header: "Writing bar (#3368)",
    canonicalHome: "docs/writing-ste100.md",
    pointerHints: [
      "Clarity, simplicity, brevity",
      "documents and user communications",
      "sub-agent status and handbacks",
      "writing-ste100.md",
      "#3368",
    ],
    canonicalBodyMarkers: [
      "clarity, simplicity, and brevity",
      "Short sentences",
      "does not govern reasoning",
      "fiction, game dialogue, marketing",
      "DONE",
    ],
    retiredFullTextMarkers: [],
  },
  {
    id: "human-merge-1193",
    shape: "doc",
    header: "Human merge gate (#1193)",
    canonicalHome: "commands.md",
    pointerHints: ["requireHumanMerge", "policy:allow-bot-merge", "DEFT_ALLOW_BOT_MERGE", "#1193"],
    canonicalBodyMarkers: ["requireHumanMerge", "allow-bot-merge", "DEFT_ALLOW_BOT_MERGE"],
    retiredFullTextMarkers: [],
  },
  {
    id: "story-start-1378",
    shape: "doc",
    header: "Story Start Gate",
    canonicalHome: "commands.md",
    pointerHints: ["deft verify:story-ready", "git status --short --branch", "#1378"],
    canonicalBodyMarkers: ["verify:story-ready", "git status --short --branch", "scope:complete"],
    retiredFullTextMarkers: [
      "A `swarm-cohort` section is ready only when",
      "checkpoint-commit it and proceed",
      "Ask the operator to choose one path",
      "Gate 0",
      "full workflow in",
    ],
  },
  {
    id: "commands-catalog-2492",
    shape: "doc",
    header: "Commands",
    canonicalHome: "commands.md",
    pointerHints: ["/deft:directive:*", "commands.md", "#418", "#1670"],
    canonicalBodyMarkers: ["/deft:directive:change", "/deft:continue", "Slash Command"],
    retiredFullTextMarkers: [
      "/deft:directive:change <name>",
      "/deft:directive:run:interview",
      "/deft:continue — Resume",
      "/deft:checkpoint — Save",
      "legacy Python `.deft/core/run` CLI is deprecated",
    ],
  },
  {
    id: "session-routing-2493",
    shape: "doc",
    header: "Session routing (#2176)",
    canonicalHome: "commands.md",
    pointerHints: [
      "commands.md",
      "read-only",
      "deft session:start",
      "addressing-name",
      "#2176",
      "mutation",
      "%APPDATA%\\deft\\USER.md",
      "USER.md resolved",
      "#2544",
    ],
    canonicalBodyMarkers: [
      "read-only posture",
      "mutation intent",
      "deft session:start --read-only",
      "task session:start -- --read-only",
      "%APPDATA%\\deft\\USER.md",
      "USER.md resolved",
    ],
    retiredFullTextMarkers: [
      "Global-first ladder (prose",
      "Pre-cutover detected** if ANY",
      "USER.md missing**",
      "xbrief/PROJECT-DEFINITION.xbrief.json` missing**",
      "Respond to any user query (greet",
      "When all config exists, before responding",
      "### Deft Alignment Confirmation",
      "Addressing you as: {Name}",
      "Read-only posture (default for Q&A",
      "## Cold-start bootstrap (#2273)",
      "## Pre-Cutover Check",
      "## First Session",
      "## Returning Sessions",
    ],
  },
  {
    id: "contextual-guardrails-2454",
    shape: "doc",
    header: "Contextual guardrails (runtime-detect lazy-load)",
    canonicalHome: "scm/github.md",
    pointerHints: [
      "scm/github.md",
      "runtime-detect",
      "#2157",
      "verify:encoding",
      "verify:scm-boundary",
    ],
    canonicalBodyMarkers: [
      "PowerShell platform-conditional rules for agents",
      "Safe subprocess capture",
      "Cascade automation surface",
      "verify:scm-boundary",
    ],
    retiredFullTextMarkers: [
      "piped/redirected commands leak wrapper text",
      "execSync",
      "hand-roll a cascade",
      "Raw `gh` calls outside the TS SCM shim",
      "authoritatively enforced at commit",
      "lazy-loaded, not rendered here",
      "platform-specific rules lazy-load",
      "load the matching section **before**",
      "PowerShell / Windows",
      "TS subprocess capture",
      "Cascade / batch merge",
      "GitHub CLI / SCM shim",
    ],
  },
  {
    id: "content-packs-2501",
    shape: "doc",
    header: "Content packs",
    canonicalHome: "commands.md",
    pointerHints: ["packs:slice --list-packs", "commands.md", "<pack> --list"],
    canonicalBodyMarkers: ["task packs:*", "content packs"],
    retiredFullTextMarkers: [
      "Deft ships versioned content packs",
      "Registry-driven, so new packs appear automatically",
      "short-name + version + one-line description",
    ],
  },
  {
    id: "codebase-map-2501",
    shape: "doc",
    header: "Codebase MAP Projection (#1595 / #1498)",
    canonicalHome: "commands.md",
    pointerHints: [
      "plan.architecture.codeStructure",
      "codebase:map",
      "verify:codebase-map-fresh",
      "commands.md",
      "#1595",
    ],
    canonicalBodyMarkers: [
      "codebase:map",
      "plan.architecture.codeStructure",
      ".planning/codebase/MAP.md",
    ],
    retiredFullTextMarkers: [
      "read it as orientation before broad codebase scanning",
      "provider/code-derived facts",
      "unless the current task edits `plan.architecture.codeStructure`",
    ],
  },
  {
    id: "skills-index-2501",
    shape: "doc",
    header: "Skills",
    canonicalHome: "packs/skills/skills-pack-0.1.json",
    pointerHints: ["Skills Index", "packs:slice skills list", "SKILL.md", "Level-0"],
    canonicalBodyMarkers: ["skills-pack-0.1", "deft-directive-build", "triggers"],
    retiredFullTextMarkers: [
      "Skill routing (which skill answers which trigger) is not a table",
      "unified with the framework doc routing so you consult one place",
      "skills are versioned and tested",
    ],
  },
  {
    id: "cache-triage-1149",
    shape: "doc",
    header: "Cache-as-authoritative work selection (#1149)",
    canonicalHome: "commands.md",
    pointerHints: ["deft triage:queue", "commands.md", "#1149", "D11", "#2402", "plan-sequence"],
    canonicalBodyMarkers: [
      "triage:queue --limit=10",
      "ranked candidate work",
      "Ordered-plan",
      "plan-sequence",
    ],
    retiredFullTextMarkers: [
      "consumer-side mirror of the maintainer rule",
      "open-GitHub-issue intuition",
      "source of truth for what to work on next",
      "what should I work on next",
    ],
  },
  {
    id: "umbrella-status-1152",
    shape: "doc",
    header: "Umbrella status reading (#1152 / #2066)",
    canonicalHome: "templates/agent-prompt-preamble.md",
    pointerHints: [
      "deft umbrella:current-shape",
      "issues/<N>/comments",
      "agent-prompt-preamble.md",
      "#1152",
    ],
    canonicalBodyMarkers: [
      "Current shape (as of pass-N)",
      "umbrella:current-shape",
      "amendment comments",
    ],
    retiredFullTextMarkers: [
      "LockedDecisions",
      "never falls back to the issue body",
      "validates #1152 sections",
      "gh api repos/<owner>/<repo>/issues",
      "task umbrella:current-shape",
    ],
  },
  {
    id: "issue-body-comments-2143",
    shape: "doc",
    header: "Issue body→comments reading (#2143)",
    canonicalHome: "templates/agent-prompt-preamble.md",
    pointerHints: ["agent-prompt-preamble.md", "deft issue:ingest", "issues/<N>/comments", "#2143"],
    canonicalBodyMarkers: [
      "body first, then the comment thread",
      "repos/<owner>/<repo>/issues/<N>/comments",
      "issue-ingest",
    ],
    retiredFullTextMarkers: [
      "Rationale + cross-references: preamble § 5.6",
      "repos/<owner>/<repo>/issues/<N>/comments",
      "folds the thread into the ingested overview",
      "chronological order",
      "task issue:ingest",
    ],
  },
  {
    id: "skill-pin-2508",
    shape: "doc",
    header: "Skill pin policy (#2508)",
    canonicalHome: "docs/skill-pin-policy.md",
    pointerHints: ["always-pin", "skill-pin-policy.md", "deft-directive-review-cycle", "#2508"],
    canonicalBodyMarkers: [
      "always-pin",
      "on-demand",
      "reference-only",
      "deft-directive-pre-pr",
      "false-negative",
    ],
    retiredFullTextMarkers: [],
  },
] as const;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\s+/)
    .join(" ");
}

function missingMarkers(haystack: string, markers: readonly string[]): string[] {
  const normalized = normalizeWhitespace(haystack);
  return markers.filter((m) => !normalized.includes(normalizeWhitespace(m)));
}

function managedSection(text: string): string {
  const start = text.search(/<!-- deft:managed-section v3\b/);
  const end = text.indexOf(CLOSE_MARKER);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + CLOSE_MARKER.length);
}

function extractSection(text: string, heading: string): string {
  for (const level of [2, 3] as const) {
    const hashes = "#".repeat(level);
    const headingRe = new RegExp(
      `^${hashes}\\s+${heading.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}\\s*$`,
      "m",
    );
    const match = headingRe.exec(text);
    if (!match || match.index === undefined) {
      continue;
    }
    const start = match.index;
    const afterHeading = text.slice(start + match[0].length);
    const nextHeading = afterHeading.search(/^#{2,3}\s/m);
    return nextHeading === -1
      ? text.slice(start)
      : text.slice(start, start + match[0].length + nextHeading);
  }
  return "";
}

function validatePointerRule(section: string, spec: PointerRuleSpec): string[] {
  const errors: string[] = [];
  if (!section) {
    errors.push(`${spec.id}: missing section header "## ${spec.header}"`);
    return errors;
  }

  const missingHints = missingMarkers(section, spec.pointerHints);
  if (missingHints.length > 0) {
    errors.push(`${spec.id}: missing pointer hints: ${missingHints.join(", ")}`);
  }

  if (!repoFileExists(spec.canonicalHome)) {
    errors.push(`${spec.id}: canonical home missing at ${spec.canonicalHome}`);
  } else {
    const homeText =
      spec.canonicalHome === "skills/deft-directive-swarm/SKILL.md"
        ? readSwarmSkillSurface()
        : readRepoFile(spec.canonicalHome);
    const missingBody = missingMarkers(homeText, spec.canonicalBodyMarkers);
    if (missingBody.length > 0) {
      errors.push(
        `${spec.id}: canonical home ${spec.canonicalHome} missing: ${missingBody.join(", ")}`,
      );
    }
  }

  if (spec.shape === "skill" && !/SKILL\.md|deft-directive-[\w-]+/.test(section)) {
    errors.push(`${spec.id}: skill pointer shape not detected`);
  }
  if (spec.shape === "gate" && !/eval:health|verify:[\w-]+/.test(section)) {
    errors.push(`${spec.id}: gate pointer shape not detected`);
  }
  if (
    spec.shape === "doc" &&
    !/commands\.md|scm\/|contracts\/[\w.-]+\.md|docs\/[\w.-]+\.md|\.deft\/core\/contracts\/|\.deft\/core\/docs\/|REFERENCES\.md|templates\/agent-prompt-preamble\.md|packs:slice/.test(
      section,
    )
  ) {
    errors.push(`${spec.id}: doc pointer shape not detected`);
  }

  if (spec.retiredFullTextMarkers) {
    const normalizedSection = normalizeWhitespace(section);
    const leaked = spec.retiredFullTextMarkers.filter((m) =>
      normalizedSection.includes(normalizeWhitespace(m)),
    );
    if (leaked.length > 0) {
      errors.push(
        `${spec.id}: retired full-text markers still in managed section: ${leaked.join(", ")}`,
      );
    }
  }

  return errors;
}

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("test_agents_entry_contract", () => {
  const template = readRepoFile("templates/agents-entry.md");
  const agents = readRepoFile("AGENTS.md");
  const templateManaged = managedSection(template);
  const agentsManaged = managedSection(agents);

  it("template_carries_managed_section_markers", () => {
    expect(template).toContain(OPEN_MARKER);
    expect(template).toContain(CLOSE_MARKER);
    expect(template.indexOf(OPEN_MARKER)).toBeLessThan(template.indexOf(CLOSE_MARKER));
  });

  it("xbrief_layout_pins_completed_record_not_next (#3383)", () => {
    expect(templateManaged).toContain("zero authority over");
    expect(templateManaged).toContain("what to build next");
    expect(templateManaged).toContain("#3383");
    expect(templateManaged).toContain("Treat a completed xBRIEF as the next-build contract");
  });

  it("xbrief_layout_names_current_write_paths (#4086)", () => {
    expect(templateManaged).toContain("./xbrief/");
    expect(templateManaged).toContain("xBRIEFInfo");
    expect(templateManaged).toContain("PROJECT-DEFINITION.xbrief.json");
    expect(templateManaged).toContain("plan.xbrief.json");
    expect(templateManaged).toContain("specification.xbrief.json");
    expect(templateManaged).toContain('"version": "0.8"');
    expect(templateManaged).toContain("deft migrate:xbrief");
  });

  it("managed_section_contains_implementation_intent_gate", () => {
    expect(templateManaged).toContain("Implementation Intent Gate");
  });

  it("propagation_command_markers_present_in_both_files", () => {
    const templateMissing = missingMarkers(
      template,
      PROPAGATION_COMMAND_MARKERS.map(([consumer]) => consumer),
    );
    const agentsMissing = missingMarkers(
      agents,
      PROPAGATION_COMMAND_MARKERS.map(([, maintainer]) => maintainer),
    );
    expect(templateMissing).toEqual([]);
    expect(agentsMissing).toEqual([]);
  });

  it("consumer_template_does_not_use_unresolved_bare_task_names", () => {
    const leaked = CONSUMER_FORBIDDEN_BARE_TASK_MARKERS.filter((m) => template.includes(m));
    expect(leaked).toEqual([]);
  });

  it("propagation_policy_key_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_POLICY_KEY_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_POLICY_KEY_MARKERS)).toEqual([]);
  });

  it("propagation_header_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_HEADER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_HEADER_MARKERS)).toEqual([]);
  });

  it("rule_authority_thin_fail_closed_pointer_bodies_present_in_both_files", () => {
    expect(missingMarkers(template, RULE_AUTHORITY_THIN_FAIL_CLOSED_POINTER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, RULE_AUTHORITY_THIN_FAIL_CLOSED_POINTER_MARKERS)).toEqual([]);
  });

  it("writing_bar_markers_present_in_both_files", () => {
    expect(missingMarkers(template, WRITING_BAR_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, WRITING_BAR_MARKERS)).toEqual([]);
  });

  it("through_merge_dispatch_markers_present_in_both_files", () => {
    expect(missingMarkers(template, THROUGH_MERGE_DISPATCH_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, THROUGH_MERGE_DISPATCH_MARKERS)).toEqual([]);
  });

  it("after_merge_orphan_active_markers_present_in_both_files", () => {
    expect(missingMarkers(template, AFTER_MERGE_ORPHAN_ACTIVE_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, AFTER_MERGE_ORPHAN_ACTIVE_MARKERS)).toEqual([]);
  });

  it("after_merge_completed_tracked_markers_present_in_both_files", () => {
    expect(missingMarkers(template, AFTER_MERGE_COMPLETED_TRACKED_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, AFTER_MERGE_COMPLETED_TRACKED_MARKERS)).toEqual([]);
  });

  it("mid_scope_gate_capability_tier_markers_present_in_both_files", () => {
    expect(missingMarkers(template, MID_SCOPE_GATE_CAPABILITY_TIER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, MID_SCOPE_GATE_CAPABILITY_TIER_MARKERS)).toEqual([]);
  });

  it("deft_directive_disable_markers_present_in_both_files", () => {
    expect(missingMarkers(template, DEFT_DIRECTIVE_DISABLE_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, DEFT_DIRECTIVE_DISABLE_MARKERS)).toEqual([]);
  });

  it("hook_runtime_unavailable_markers_present_in_both_files", () => {
    expect(missingMarkers(template, HOOK_RUNTIME_UNAVAILABLE_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, HOOK_RUNTIME_UNAVAILABLE_MARKERS)).toEqual([]);
  });

  it("portable_shell_orientation_markers_present_in_both_files", () => {
    expect(missingMarkers(template, SHELL_ORIENTATION_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, SHELL_ORIENTATION_MARKERS)).toEqual([]);
  });

  it("propagation_action_verb_list_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_ACTION_VERBS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_ACTION_VERBS)).toEqual([]);
  });

  it("skill_routing_table_removed_from_policy_files", () => {
    expect(agents).not.toContain("## Skill Routing");
    expect(template).not.toContain("## Skill Routing");
  });

  it("skills_pointer_present_in_both_files", () => {
    expect(missingMarkers(template, SKILLS_POINTER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, SKILLS_POINTER_MARKERS)).toEqual([]);
  });

  it("references_md_indexes_every_skill", () => {
    const references = readRepoFile("REFERENCES.md");
    expect(references).toContain("Skills Index");
    expect(missingMarkers(references, INDEXED_SKILL_IDS)).toEqual([]);
  });

  it("unmanaged_header_contract_markers_present_in_both_files", () => {
    expect(missingMarkers(template, UNMANAGED_HEADER_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, UNMANAGED_HEADER_MARKERS)).toEqual([]);
  });

  it("propagation_umbrella_status_markers_present_in_both_files", () => {
    expect(missingMarkers(template, PROPAGATION_UMBRELLA_STATUS_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, PROPAGATION_UMBRELLA_STATUS_MARKERS)).toEqual([]);
  });

  it.each(
    POINTER_RELOCATED_RULES,
  )("pointer_sufficient_rule_in_consumer_managed_section $id", (spec) => {
    const section = extractSection(templateManaged, spec.header);
    expect(validatePointerRule(section, spec)).toEqual([]);
  });

  it.each(
    POINTER_RELOCATED_RULES,
  )("pointer_sufficient_rule_in_maintainer_managed_section $id", (spec) => {
    const section = extractSection(agentsManaged, spec.header);
    expect(validatePointerRule(section, spec)).toEqual([]);
  });

  it("value_readback_suppression_window_is_four_hours", () => {
    expect(VALUE_READBACK_SUPPRESSION_HOURS).toBe(4);
  });

  it("eval_readback_suppression_window_is_four_hours", () => {
    expect(EVAL_READBACK_SUPPRESSION_HOURS).toBe(4);
  });

  it("content_packs_note_references_discovery_commands", () => {
    expect(templateManaged).toContain("--list-packs");
    expect(templateManaged).toContain("<pack> --list");
    expect(templateManaged).not.toContain("Deft ships versioned content packs");
  });

  it("skill_pin_policy_default_pins_present_in_both_files", () => {
    expect(missingMarkers(template, DEFAULT_ALWAYS_PIN_SKILL_IDS)).toEqual([]);
    expect(missingMarkers(agents, DEFAULT_ALWAYS_PIN_SKILL_IDS)).toEqual([]);
  });

  it("skill_pin_policy_anti_pattern_present_in_both_files", () => {
    expect(missingMarkers(template, SKILL_PIN_ANTI_PATTERN_MARKERS)).toEqual([]);
    expect(missingMarkers(agents, SKILL_PIN_ANTI_PATTERN_MARKERS)).toEqual([]);
  });

  it("references_md_documents_pin_tiers", () => {
    const references = readRepoFile("REFERENCES.md");
    expect(references).toContain("Pin tiers (#2508)");
    expect(references).toContain("skill-pin-policy.md");
    expect(references).toContain("always-pin");
    expect(missingMarkers(references, DEFAULT_ALWAYS_PIN_SKILL_IDS)).toEqual([]);
  });
});

describe("test_agents_entry_pointer_fixtures", () => {
  it("fixture_pointer_to_skill_passes_without_full_rule_body", () => {
    const fixture = readFixture("pointer-sufficient-skill.md");
    const spec = POINTER_RELOCATED_RULES.find((r) => r.id === "review-surface-2308");
    expect(spec).toBeDefined();
    if (!spec) {
      return;
    }
    const section = extractSection(fixture, spec.header);
    expect(validatePointerRule(section, spec)).toEqual([]);
    expect(section).not.toContain("wrong-review-surface class");
  });

  it("fixture_pointer_to_gate_passes_without_full_rule_body", () => {
    const fixture = readFixture("pointer-sufficient-gate.md");
    const spec = POINTER_RELOCATED_RULES.find((r) => r.id === "eval-framework-1703");
    expect(spec).toBeDefined();
    if (!spec) {
      return;
    }
    const section = extractSection(fixture, spec.header);
    expect(validatePointerRule(section, spec)).toEqual([]);
    expect(section).not.toContain("crud-metrics.jsonl");
  });

  it("fixture_pointer_to_doc_passes_without_full_rule_body", () => {
    const fixture = readFixture("pointer-sufficient-doc.md");
    const spec = POINTER_RELOCATED_RULES.find((r) => r.id === "deterministic-questions-1470");
    expect(spec).toBeDefined();
    if (!spec) {
      return;
    }
    const section = extractSection(fixture, spec.header);
    expect(validatePointerRule(section, spec)).toEqual([]);
    expect(section).not.toContain("Discuss-pause semantic");
  });

  it("canonical_homes_resolve_on_disk", () => {
    for (const spec of POINTER_RELOCATED_RULES) {
      expect(resolveRepoPath(spec.canonicalHome)).toBeTruthy();
      expect(repoFileExists(spec.canonicalHome)).toBe(true);
    }
  });
});
