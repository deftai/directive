import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_CONFIG_ERROR = 2;

export const DEFAULT_MAP_PATH = "conventions/rule-ownership.json";

export const VALID_AUTHORITIES = new Set([
  "MUST",
  "SHOULD",
  "MUST_NOT",
  "SHOULD_NOT",
  "AXIOM",
  "lesson",
]);

export const REQUIRED_FIELDS = [
  "id",
  "text",
  "owner_file",
  "owner_section",
  "authority",
  "last_verified",
] as const;

export interface RomRule {
  readonly id: string;
  readonly text: string;
  readonly owner_file: string;
  readonly owner_section: string;
  readonly authority: string;
  readonly last_verified: string;
}

export interface RomPayload {
  readonly rules: RomRule[];
}

/** Parse markdown ATX heading: returns [level, text] or null. Linear scan, no backtracking regex. */
export function parseHeading(line: string): [number, string] | null {
  let level = 0;
  while (level < line.length && line.charAt(level) === "#") {
    level += 1;
  }
  if (level === 0 || level > 6) {
    return null;
  }
  if (line.charAt(level) !== " ") {
    return null;
  }
  const i = level + 1;
  let end = line.length;
  while (end > i && (line.charAt(end - 1) === " " || line.charAt(end - 1) === "\t")) {
    end -= 1;
  }
  const text = line.slice(i, end).trim();
  return [level, text];
}

export function extractSectionBody(content: string, ownerSection: string): string | null {
  const parsed = parseHeading(ownerSection.trim());
  if (parsed === null) {
    return null;
  }
  const [targetLevel, targetText] = parsed;
  const lines = content.split("\n");
  let inSection = false;
  const body: string[] = [];
  for (const line of lines) {
    const heading = parseHeading(line);
    if (!inSection) {
      if (heading && heading[0] === targetLevel && heading[1] === targetText) {
        inSection = true;
      }
      continue;
    }
    if (heading && heading[0] <= targetLevel) {
      break;
    }
    body.push(line);
  }
  if (!inSection) {
    return null;
  }
  return body.join("\n");
}

export function loadMap(mapPath: string): RomPayload {
  if (!existsSync(mapPath)) {
    throw new Error(`ROM data file not found: ${mapPath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(mapPath, { encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ROM data file ${mapPath}: ${msg}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed JSON in ROM data file ${mapPath}: ${msg}`);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      `ROM data file ${mapPath} must contain a JSON object at the top level (got ${typeof payload}).`,
    );
  }
  const rules = (payload as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw new Error(`ROM data file ${mapPath} must contain a 'rules' array (got ${typeof rules}).`);
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (typeof rule !== "object" || rule === null) {
      throw new Error(`ROM rule at index ${index} must be a JSON object (got ${typeof rule}).`);
    }
    const rec = rule as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in rec)) {
        throw new Error(`ROM rule at index ${index} is missing required field '${field}'.`);
      }
      const val = rec[field];
      if (typeof val !== "string" || val.length === 0) {
        throw new Error(`ROM rule at index ${index} field '${field}' must be a non-empty string.`);
      }
    }
    const ruleId = rec.id as string;
    if (seenIds.has(ruleId)) {
      throw new Error(`Duplicate ROM rule id: '${ruleId}'`);
    }
    seenIds.add(ruleId);
    const authority = rec.authority as string;
    if (!VALID_AUTHORITIES.has(authority)) {
      const sorted = [...VALID_AUTHORITIES].sort();
      throw new Error(
        `ROM rule '${ruleId}' has invalid authority '${authority}'; expected one of ${JSON.stringify(sorted)}.`,
      );
    }
  }
  return { rules: rules as RomRule[] };
}

export function lintRules(payload: RomPayload, root: string): string[] {
  const diagnostics: string[] = [];
  for (const rule of payload.rules) {
    const { id: ruleId, owner_file: ownerFile, owner_section: ownerSection, text } = rule;
    const target = join(root, ownerFile);
    if (!existsSync(target)) {
      diagnostics.push(
        `[${ruleId}] owner_file not found: ${ownerFile} -- either restore the file or update the ROM row to point at the new owner.`,
      );
      continue;
    }
    let content: string;
    try {
      content = readFileSync(target, { encoding: "utf8" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push(`[${ruleId}] failed to read ${ownerFile}: ${msg}`);
      continue;
    }
    const body = extractSectionBody(content, ownerSection);
    if (body === null) {
      diagnostics.push(
        `[${ruleId}] owner_section '${ownerSection}' not found in ${ownerFile} -- either restore the heading or update the ROM row to point at the new section.`,
      );
      continue;
    }
    if (!body.includes(text)) {
      diagnostics.push(
        `[${ruleId}] rule text not found in ${ownerFile} '${ownerSection}' -- the rule has been moved, deleted, or rewritten. Update the ROM row's 'text' (or 'owner_file' / 'owner_section') to match. Looked for: '${text}'`,
      );
    }
  }
  return diagnostics;
}

export interface RuleOwnershipResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface RuleOwnershipOptions {
  readonly mapPath?: string;
  readonly root?: string;
}

export function evaluateRuleOwnership(
  projectRoot: string,
  options: RuleOwnershipOptions = {},
): RuleOwnershipResult {
  const root = resolve(options.root ?? projectRoot);
  const mapPath = resolve(options.mapPath ?? join(root, DEFAULT_MAP_PATH));

  try {
    const payload = loadMap(mapPath);
    const diagnostics = lintRules(payload, root);
    if (diagnostics.length > 0) {
      const lines = [
        `FAIL: rule ownership map drift detected in ${diagnostics.length} row(s):`,
        ...diagnostics.map((d) => `  - ${d}`),
      ];
      return { code: EXIT_DRIFT, message: lines.join("\n"), stream: "stderr" };
    }
    return {
      code: EXIT_OK,
      message: `OK: rule ownership map clean -- ${payload.rules.length} row(s) verified against their owner files (root=${root}).`,
      stream: "stderr",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: EXIT_CONFIG_ERROR, message: `Error: ${msg}`, stream: "stderr" };
  }
}
