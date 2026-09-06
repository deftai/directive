import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Relative path to skill-pi-trigger-eval compatible case rows (#1586). */
export const TRIGGER_CASES_REL = "evals/trigger-cases.jsonl";

/** Default Skills Index source for AGENTS.md skill routing (#1586). */
export const SKILLS_INDEX_REL = "REFERENCES.md";

/** Parsed Skills Index row. */
export interface SkillsIndexEntry {
  readonly skillId: string;
  readonly triggers: readonly string[];
}

/** One row in evals/trigger-cases.jsonl (skill-pi-trigger-eval eval-set + skill id). */
export interface TriggerCaseRow {
  readonly id: string;
  readonly query: string;
  readonly skill: string;
  readonly should_trigger: boolean;
}

/** Outcome for a single trigger case. */
export interface TriggerCaseResult {
  readonly id: string;
  readonly query: string;
  readonly skill: string;
  readonly should_trigger: boolean;
  readonly actual: boolean;
  readonly pass: boolean;
  readonly matchedTrigger?: string;
  readonly winnerSkill?: string;
}

/** Aggregate eval:triggers report. */
export interface TriggerEvalReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pass_rate: number | null;
  readonly results: readonly TriggerCaseResult[];
  readonly coverageErrors: readonly string[];
}

export interface RunTriggerEvalOptions {
  readonly projectRoot?: string;
  readonly casesPath?: string;
  readonly indexPath?: string;
  readonly cases?: readonly TriggerCaseRow[];
  readonly indexText?: string;
}

export interface RunTriggerEvalResult {
  readonly code: 0 | 1 | 2;
  readonly report: TriggerEvalReport | null;
  readonly message: string;
}

/** Normalize user text for deterministic substring trigger matching. */
export function normalizeTriggerText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True when *trigger* occurs in *normalizedQuery* as a phrase, not as a
 * substring of a longer token. Bare `arc` must not match `architecture`.
 */
export function triggerOccurs(normalizedQuery: string, trigger: string): boolean {
  if (trigger.length === 0) {
    return false;
  }
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(normalizedQuery);
}

/** Collapse embedded newlines before interpolating user/data into log lines. */
export function sanitizeTriggerLogLine(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

/** Extract backtick trigger phrases from a Skills Index triggers cell. */
export function parseTriggerCell(cell: string): string[] {
  const triggers: string[] = [];
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const phrase = normalizeTriggerText(match[1] ?? "");
    if (phrase.length > 0) {
      triggers.push(phrase);
    }
  }
  return triggers;
}

/** Parse the Skills Index markdown table in REFERENCES.md. */
export function parseSkillsIndex(markdown: string): SkillsIndexEntry[] {
  const entries: SkillsIndexEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("| [deft-directive-")) {
      continue;
    }
    const columns = line.split("|").map((col) => col.trim());
    if (columns.length < 5) {
      continue;
    }
    const linkCell = columns[1] ?? "";
    const triggersCell = columns[3] ?? "";
    // Avoid nested character-class regex (CodeQL js/polynomial-redos on \[([^\]]+)\]).
    const open = linkCell.indexOf("[");
    const close = open === -1 ? -1 : linkCell.indexOf("]", open + 1);
    if (open === -1 || close === -1) {
      continue;
    }
    const skillId = linkCell.slice(open + 1, close).trim();
    if (skillId.length === 0) {
      continue;
    }
    const triggers = parseTriggerCell(triggersCell);
    if (triggers.length === 0) {
      continue;
    }
    entries.push({ skillId, triggers });
  }
  return entries;
}

interface TriggerMatch {
  readonly skillId: string;
  readonly trigger: string;
}

/** Find the winning skill for a query using longest-trigger-wins disambiguation. */
export function resolveTriggerWinner(
  query: string,
  index: readonly SkillsIndexEntry[],
): TriggerMatch | null {
  const normalized = normalizeTriggerText(query);
  let best: TriggerMatch | null = null;
  for (const entry of index) {
    for (const trigger of entry.triggers) {
      if (!triggerOccurs(normalized, trigger)) {
        continue;
      }
      if (
        best === null ||
        trigger.length > best.trigger.length ||
        (trigger.length === best.trigger.length && entry.skillId.localeCompare(best.skillId) < 0)
      ) {
        best = { skillId: entry.skillId, trigger };
      }
    }
  }
  return best;
}

/** True when the Skills Index routing would send *query* to *skillId*. */
export function wouldRouteToSkill(
  query: string,
  skillId: string,
  index: readonly SkillsIndexEntry[],
): boolean {
  const winner = resolveTriggerWinner(query, index);
  return winner !== null && winner.skillId === skillId;
}

/** Validate one JSONL row against the skill-pi-trigger-eval row contract. */
export function parseTriggerCaseRow(raw: unknown, lineNumber: number): TriggerCaseRow | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `line ${lineNumber}: expected a JSON object`;
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const query = record.query;
  const skill = record.skill;
  const shouldTrigger = record.should_trigger;
  if (typeof id !== "string" || id.trim().length === 0) {
    return `line ${lineNumber}: id must be a non-empty string`;
  }
  if (typeof query !== "string" || query.trim().length === 0) {
    return `line ${lineNumber}: query must be a non-empty string`;
  }
  if (typeof skill !== "string" || !skill.startsWith("deft-directive-")) {
    return `line ${lineNumber}: skill must be a deft-directive-* id`;
  }
  if (typeof shouldTrigger !== "boolean") {
    return `line ${lineNumber}: should_trigger must be true or false`;
  }
  return {
    id: id.trim(),
    query: query.trim(),
    skill: skill.trim(),
    should_trigger: shouldTrigger,
  };
}

/** Load evals/trigger-cases.jsonl. */
export function loadTriggerCases(path: string): TriggerCaseRow[] | { error: string } {
  if (!existsSync(path)) {
    return { error: `missing trigger cases at ${path}` };
  }
  const text = readFileSync(path, "utf8");
  const rows: TriggerCaseRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: `line ${i + 1}: invalid JSON` };
    }
    const row = parseTriggerCaseRow(parsed, i + 1);
    if (typeof row === "string") {
      return { error: row };
    }
    rows.push(row);
  }
  if (rows.length === 0) {
    return { error: "trigger-cases.jsonl has no cases" };
  }
  return rows;
}

/** Verify at least two positive and one negative case per indexed skill. */
export function validateTriggerCoverage(
  cases: readonly TriggerCaseRow[],
  index: readonly SkillsIndexEntry[],
): string[] {
  const errors: string[] = [];
  const bySkill = new Map<string, { positive: number; negative: number }>();
  for (const entry of index) {
    bySkill.set(entry.skillId, { positive: 0, negative: 0 });
  }
  for (const row of cases) {
    const bucket = bySkill.get(row.skill);
    if (bucket === undefined) {
      errors.push(`case '${row.id}' references unknown skill '${row.skill}'`);
      continue;
    }
    if (row.should_trigger) {
      bucket.positive += 1;
    } else {
      bucket.negative += 1;
    }
  }
  for (const [skillId, counts] of bySkill) {
    if (counts.positive < 2) {
      errors.push(`${skillId}: need at least 2 positive trigger cases (have ${counts.positive})`);
    }
    if (counts.negative < 1) {
      errors.push(`${skillId}: need at least 1 negative trigger case (have ${counts.negative})`);
    }
  }
  return errors;
}

/** Run deterministic trigger routing eval (offline skill-pi-trigger-eval counterpart). */
export function runTriggerEval(options: RunTriggerEvalOptions = {}): RunTriggerEvalResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const casesPath = options.casesPath ?? resolve(projectRoot, TRIGGER_CASES_REL);
  const indexPath = options.indexPath ?? resolve(projectRoot, SKILLS_INDEX_REL);

  let cases: TriggerCaseRow[];
  if (options.cases !== undefined) {
    cases = [...options.cases];
  } else {
    const loaded = loadTriggerCases(casesPath);
    if ("error" in loaded) {
      return { code: 2, report: null, message: `eval:triggers: ${loaded.error}` };
    }
    cases = loaded;
  }

  let indexText: string;
  if (options.indexText !== undefined) {
    indexText = options.indexText;
  } else if (!existsSync(indexPath)) {
    return { code: 2, report: null, message: `eval:triggers: missing ${SKILLS_INDEX_REL}` };
  } else {
    indexText = readFileSync(indexPath, "utf8");
  }

  const index = parseSkillsIndex(indexText);
  if (index.length === 0) {
    return {
      code: 2,
      report: null,
      message: `eval:triggers: no Skills Index rows parsed from ${SKILLS_INDEX_REL}`,
    };
  }

  const coverageErrors = validateTriggerCoverage(cases, index);
  const results: TriggerCaseResult[] = [];
  for (const row of cases) {
    const winner = resolveTriggerWinner(row.query, index);
    const actual = wouldRouteToSkill(row.query, row.skill, index);
    results.push({
      id: row.id,
      query: row.query,
      skill: row.skill,
      should_trigger: row.should_trigger,
      actual,
      pass: actual === row.should_trigger,
      matchedTrigger: winner?.trigger,
      winnerSkill: winner?.skillId,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const report: TriggerEvalReport = {
    total: results.length,
    passed,
    failed,
    pass_rate: results.length > 0 ? passed / results.length : null,
    results,
    coverageErrors,
  };

  if (coverageErrors.length > 0) {
    const detail = coverageErrors.map((err) => `   - ${sanitizeTriggerLogLine(err)}`).join("\n");
    return {
      code: 1,
      report,
      message: `eval:triggers: trigger coverage incomplete\n${detail}`,
    };
  }

  if (failed > 0) {
    const detail = results
      .filter((result) => !result.pass)
      .slice(0, 8)
      .map(
        (result) =>
          `   - ${sanitizeTriggerLogLine(result.id)}: expected ${result.should_trigger ? "trigger" : "no-trigger"} ` +
          `for ${sanitizeTriggerLogLine(result.skill)}; winner=${sanitizeTriggerLogLine(result.winnerSkill ?? "none")}`,
      )
      .join("\n");
    return {
      code: 1,
      report,
      message:
        `eval:triggers: ${failed}/${results.length} trigger cases failed ` +
        `(offline skill-pi-trigger-eval routing against ${SKILLS_INDEX_REL})\n${detail}`,
    };
  }

  return {
    code: 0,
    report,
    message:
      `eval:triggers: ${passed}/${results.length} trigger cases passed ` +
      `(offline skill-pi-trigger-eval routing against ${SKILLS_INDEX_REL})`,
  };
}
