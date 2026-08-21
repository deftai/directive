import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseTaskfileIncludes,
  taskDefinedInTaskfileYaml,
} from "../../check/consumer-gate-integrity.js";
import { ROUTING_SET_CMD } from "../../swarm/routing-verify.js";
import { formatSummary } from "../../triage/bootstrap/index.js";
import {
  REPO_ROOT,
  readRepoFile,
  readSkill,
  SWARM_REFERENCE_ORDER,
  SWARM_SKILL_REL,
} from "./helpers.js";

/**
 * #3483 — Every `task <verb>` named at MUST/⊗ level in the swarm skill must
 * resolve in the shipped task graph.
 *
 * The #2109 vbrief→xbrief rename added `xbrief:`-prefixed verbs where the
 * surface was rewritten (`xbrief:preflight`) but skipped `validate` and
 * `activate`, while the skill prose was updated as if it had. The result was
 * four MUST/⊗-level cohort-close instructions naming `task xbrief:validate`,
 * a verb that exited 200 ("task does not exist"). An orchestrator following
 * the skill literally either improvised the real verb or treated a green
 * cohort as blocked.
 *
 * This contract generalizes the fix: it walks the swarm surface, extracts the
 * task verbs named at MUST/⊗ level, and resolves each against the real root
 * Taskfile `includes:` + `tasks/<ns>.yml` definitions. A future rename that
 * moves a verb without moving the prose (or vice versa) fails here instead of
 * at a live cohort close.
 *
 * Same class as #3479 (skill prose naming a surface the runtime does not
 * match). Refs #1487 (the recurrence the cohort-close gate exists to prevent).
 */

/** Swarm surface files, addressed individually so findings can cite file:line. */
const SWARM_FILES: readonly string[] = [
  SWARM_SKILL_REL,
  ...SWARM_REFERENCE_ORDER.map((n) => `skills/deft-directive-swarm/references/${n}`),
];

/**
 * Consumer-projection include key (#2893): a consumer's root Taskfile includes
 * `.deft/core/Taskfile.yml` under `deft:`, so `task deft:pr:watch` is the
 * consumer spelling of this repo's `task pr:watch`. Strip it before resolving.
 */
const CONSUMER_INCLUDE_PREFIX = "deft:";

/** `task <verb>` inside backticks. Stops at whitespace, `*`, `<`, or the closing tick. */
const TASK_VERB = /`task ([A-Za-z_][\w.:-]*)/g;

/** RFC2119 legend: `!` = MUST, `⊗` = MUST NOT. Both are binding on an orchestrator. */
function isBindingLine(line: string): boolean {
  // Strip leading list markers (`- `, `1. `, `* `, and nestings thereof).
  const body = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)+/, "");
  return body.startsWith("!") || body.startsWith("⊗") || /\bMUST\b/.test(line);
}

interface NamedVerb {
  readonly verb: string;
  readonly file: string;
  readonly line: number;
}

/** Collect task verbs named on MUST/⊗-level lines across the swarm surface. */
export function bindingTaskVerbs(): readonly NamedVerb[] {
  const found: NamedVerb[] = [];
  for (const rel of SWARM_FILES) {
    const lines = readRepoFile(rel).split("\n");
    for (const [idx, line] of lines.entries()) {
      if (!isBindingLine(line)) {
        continue;
      }
      for (const match of line.matchAll(TASK_VERB)) {
        const raw = match[1];
        if (raw === undefined) {
          continue;
        }
        const verb = raw.startsWith(CONSUMER_INCLUDE_PREFIX)
          ? raw.slice(CONSUMER_INCLUDE_PREFIX.length)
          : raw;
        // Skip prose placeholders and globs: `task swarm:*` and `task deft:<verb>`
        // both truncate to a trailing colon under TASK_VERB.
        if (verb === "" || verb.endsWith(":")) {
          continue;
        }
        found.push({ verb, file: rel, line: idx + 1 });
      }
    }
  }
  return found;
}

function readRootTaskfile(): string {
  return readFileSync(join(REPO_ROOT, "Taskfile.yml"), "utf8");
}

function readIncludeTaskfile(namespace: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, "tasks", `${namespace}.yml`), "utf8");
  } catch {
    return null;
  }
}

/**
 * True when `verb` resolves in the shipped task graph: either a root Taskfile
 * task key (root keys may themselves be namespaced, e.g. `check:consumer`), or
 * a task defined in the `tasks/<ns>.yml` reached by the root `includes:` entry.
 */
export function taskVerbResolves(verb: string): boolean {
  const root = readRootTaskfile();
  if (taskDefinedInTaskfileYaml(root, verb)) {
    return true;
  }
  const colon = verb.indexOf(":");
  if (colon <= 0) {
    return false;
  }
  const namespace = verb.slice(0, colon);
  const local = verb.slice(colon + 1);
  const include = parseTaskfileIncludes(root).get(namespace);
  if (include === undefined) {
    return false;
  }
  const text = readIncludeTaskfile(namespace);
  return text !== null && taskDefinedInTaskfileYaml(text, local);
}

describe("swarm MUST/⊗ task verbs resolve in the task graph (#3483)", () => {
  it("finds binding task verbs to check (guards the extractor against silent zero)", () => {
    const verbs = bindingTaskVerbs();
    expect(verbs.length).toBeGreaterThan(20);
    const names = new Set(verbs.map((v) => v.verb));
    // Anchors: the #3483 regression itself, plus a stable neighbour.
    expect(names).toContain("xbrief:validate");
    expect(names).toContain("swarm:complete-cohort");
  });

  it("every task verb named at MUST/⊗ level resolves", () => {
    const unresolved = bindingTaskVerbs().filter((v) => !taskVerbResolves(v.verb));
    const detail = unresolved
      .map((v) => `  ${v.file}:${v.line} names \`task ${v.verb}\` (no such task)`)
      .join("\n");
    expect(
      unresolved,
      `Swarm skill names ${unresolved.length} non-existent task verb(s) at MUST/⊗ level.\n` +
        `${detail}\n` +
        "Add the verb to the task graph (tasks/<ns>.yml + the root Taskfile include), " +
        "or correct the skill prose. See #3483.",
    ).toEqual([]);
  });

  it("ships the xbrief: lifecycle aliases the swarm surface names (#3483)", () => {
    for (const verb of ["xbrief:validate", "xbrief:activate", "xbrief:preflight"]) {
      expect(taskVerbResolves(verb), `${verb} must resolve`).toBe(true);
    }
    // The legacy vbrief: spelling stays live — gate ids on CONSUMER_CHECK_GATES
    // and `task check` still wire it; the xbrief: verbs are aliases, not moves.
    for (const verb of ["vbrief:validate", "vbrief:activate", "vbrief:preflight"]) {
      expect(taskVerbResolves(verb), `${verb} must stay resolvable`).toBe(true);
    }
  });

  it("keeps the xbrief include non-optional so a deposit cannot omit it (#3483)", () => {
    const include = parseTaskfileIncludes(readRootTaskfile()).get("xbrief");
    expect(include).toBeDefined();
    expect(include?.optional).toBe(false);
  });

  it("cohort-close MUST/⊗ sites name xbrief:validate (#1487 recurrence gate)", () => {
    const phase56 = readRepoFile("skills/deft-directive-swarm/references/core-phase-5-6.md");
    expect(phase56).toMatch(/MUST run `task xbrief:validate` and confirm it exits 0/);
    expect(phase56).toMatch(
      /⊗ Declare a swarm closed while any cohort story xBRIEF remains[\s\S]*?`task xbrief:validate`/,
    );
    const ops = readRepoFile("skills/deft-directive-swarm/references/core-ops.md");
    expect(ops).toMatch(/⊗ Declare a swarm closed without running[\s\S]*?`task xbrief:validate`/);
  });

  it("drops the hedges that papered over the missing verb (#3483)", () => {
    // commands.md hedged with a parenthetical alternative; sync hedged "if available".
    const commands = readRepoFile("commands.md");
    expect(commands).not.toContain("(or `task xbrief:validate`)");
    expect(commands).toContain("After local `task xbrief:validate` exits 0");

    const sync = readSkill("skills/deft-directive-sync/SKILL.md");
    expect(sync).not.toContain("`task xbrief:validate` if available");
    expect(sync).toContain("Use `task xbrief:validate` for deeper validation");
  });
});

/**
 * Include-only consumer root (#3218 / #3439). Operators run `task deft:<verb>`;
 * bare `task <verb>` does not exist at this layer.
 */
const CONSUMER_INCLUDE_ONLY_TASKFILE = `version: "3"

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
`;

interface PrescribedCmd {
  readonly form: "deft" | "task" | "task-deft";
  readonly verb: string;
  readonly file: string;
  readonly line: number;
  readonly raw: string;
}

function classifyTaskToken(raw: string): Pick<PrescribedCmd, "form" | "verb"> {
  if (raw.startsWith(CONSUMER_INCLUDE_PREFIX)) {
    return { form: "task-deft", verb: raw.slice(CONSUMER_INCLUDE_PREFIX.length) };
  }
  return { form: "task", verb: raw };
}

/** True when `verb` resolves on an include-only consumer Taskfile (#3439). */
export function consumerTaskVerbResolves(verb: string): boolean {
  if (taskDefinedInTaskfileYaml(CONSUMER_INCLUDE_ONLY_TASKFILE, verb)) {
    return true;
  }
  const colon = verb.indexOf(":");
  if (colon <= 0) {
    return false;
  }
  const namespace = verb.slice(0, colon);
  const local = verb.slice(colon + 1);
  const include = parseTaskfileIncludes(CONSUMER_INCLUDE_ONLY_TASKFILE).get(namespace);
  if (include === undefined) {
    return false;
  }
  if (namespace === CONSUMER_INCLUDE_PREFIX.slice(0, -1)) {
    return taskVerbResolves(local);
  }
  return false;
}

/** Fenced copy-paste lines are unquoted (`deft verify:branch || exit 1`). */
const FENCE_CMD = /(?:^|\s)(deft|task) ([A-Za-z_][\w.:-]*)/g;

function extractFromFenceLine(line: string, file: string, lineNo: number): PrescribedCmd[] {
  const found: PrescribedCmd[] = [];
  for (const match of line.matchAll(FENCE_CMD)) {
    const prefix = match[1];
    const raw = match[2];
    if (prefix === undefined || raw === undefined || raw === "" || raw.endsWith(":")) {
      continue;
    }
    if (prefix === "deft") {
      found.push({ form: "deft", verb: raw, file, line: lineNo, raw: `deft ${raw}` });
      continue;
    }
    const classified = classifyTaskToken(raw);
    found.push({
      form: classified.form,
      verb: classified.verb,
      file,
      line: lineNo,
      raw: `task ${raw}`,
    });
  }
  return found;
}

/**
 * Fenced command lines that follow a MUST/⊗ intro on the swarm dispatch card.
 * Binding-line `task` mentions stay on the source-oracle walk above; this
 * extractor is the consumer-projection walk that #3483's source resolve
 * (which strips `deft:`) cannot catch.
 */
export function bindingFenceCommands(rel: string = SWARM_SKILL_REL): readonly PrescribedCmd[] {
  const lines = readRepoFile(rel).split("\n");
  const found: PrescribedCmd[] = [];
  for (const [idx, line] of lines.entries()) {
    if (!isBindingLine(line)) {
      continue;
    }
    let j = idx + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") {
      j += 1;
    }
    const fence = (lines[j] ?? "").trim();
    if (!fence.startsWith("```")) {
      continue;
    }
    j += 1;
    while (j < lines.length && !(lines[j] ?? "").trim().startsWith("```")) {
      found.push(...extractFromFenceLine(lines[j] ?? "", rel, j + 1));
      j += 1;
    }
  }
  return found;
}

function twoPathsSlice(): string {
  const commands = readRepoFile("commands.md");
  const start = commands.indexOf("### Two paths");
  const end = commands.indexOf("### Triage Tasks");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("commands.md Two paths section not found");
  }
  return commands.slice(start, end);
}

describe("consumer-projection oracle (#3439)", () => {
  it("source-resolve of verify:branch is not enough -- consumer bare task cannot run it", () => {
    expect(taskVerbResolves("verify:branch"), "source Taskfile still has verify:branch").toBe(true);
    expect(
      consumerTaskVerbResolves("verify:branch"),
      "include-only consumer cannot run task verify:branch",
    ).toBe(false);
    expect(consumerTaskVerbResolves("deft:verify:branch")).toBe(true);
  });

  it("swarm SKILL.md binding fences prescribe deft <verb>, not bare task <verb>", () => {
    const cmds = bindingFenceCommands();
    expect(cmds.length).toBeGreaterThan(0);
    const bare = cmds.filter((c) => c.form === "task");
    const detail = bare
      .map((c) => `  ${c.file}:${c.line} prescribes \`${c.raw}\` (consumer cannot run)`)
      .join("\n");
    expect(
      bare,
      `Swarm SKILL.md fence names ${bare.length} bare task verb(s) a consumer include-only Taskfile cannot run.\n${detail}\nPrescribe \`deft <verb>\` (#3439).`,
    ).toEqual([]);
    expect(cmds.some((c) => c.form === "deft" && c.verb === "verify:branch")).toBe(true);
  });

  it("routing-verify remediation and bootstrap recap emit deft <verb>", () => {
    expect(ROUTING_SET_CMD.startsWith("deft ")).toBe(true);
    expect(ROUTING_SET_CMD).not.toMatch(/^task (?!deft:)/);
    const recap = formatSummary({
      projectRoot: ".",
      repo: "OWNER/NAME",
      exitCode: 0,
      steps: [{ name: "seed", ok: true, message: "ok", details: {} }],
    });
    expect(recap).toContain("deft triage:accept");
    expect(recap).not.toMatch(/task (?!deft:)(cache|triage):/);
  });

  it("commands.md Two paths uses deft plan-sequence / deft triage:queue", () => {
    const slice = twoPathsSlice();
    expect(slice).toContain("`deft plan-sequence:current`");
    expect(slice).toContain("`deft triage:queue`");
    expect(slice).toContain("plan-sequence:status");
    expect(slice).not.toMatch(/`task plan-sequence:/);
    expect(slice).not.toMatch(/`task triage:queue`/);
  });
});
