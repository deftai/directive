/**
 * Verb classification table loader + schema validation (#1095 Wave 4).
 * SoT file: conventions/verb-classification.json (repo root).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IRREVERSIBILITY_VALUES = [
  "reversible-via-git-revert",
  "reversible-via-release-rollback",
  "destructive",
  "reversible",
] as const;

export type Irreversibility = (typeof IRREVERSIBILITY_VALUES)[number];

export interface VerbClassificationRow {
  readonly closure_set: readonly string[];
  readonly explicit_required: readonly string[];
  readonly irreversibility: string;
  readonly wildcard_allowed: boolean;
  readonly recurring_allowed: boolean;
  readonly default_expiry: string;
  readonly skill: string;
  readonly phase: string;
  /** AuthzOperation names that satisfy this closed verb (Wave 1 grant ops). */
  readonly authz_operations: readonly string[];
  /** Ephemeral env bypass key, e.g. DEFT_ALLOW_RELEASE_PUBLISH. */
  readonly env_bypass: string;
}

export interface VerbClassificationTable {
  readonly schemaVersion: number;
  readonly description?: string;
  readonly verbs: Readonly<Record<string, VerbClassificationRow>>;
}

export class VerbClassificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VerbClassificationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new VerbClassificationError("verb-class-schema", `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new VerbClassificationError(
        "verb-class-schema",
        `${field} entries must be non-empty strings`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function parseRow(name: string, raw: unknown): VerbClassificationRow {
  if (!isRecord(raw)) {
    throw new VerbClassificationError("verb-class-schema", `verb '${name}' must be an object`);
  }
  const irreversibility = raw.irreversibility;
  if (typeof irreversibility !== "string" || irreversibility.trim().length === 0) {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' requires irreversibility string`,
    );
  }
  if (typeof raw.wildcard_allowed !== "boolean") {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' requires wildcard_allowed boolean`,
    );
  }
  if (typeof raw.recurring_allowed !== "boolean") {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' requires recurring_allowed boolean`,
    );
  }
  if (typeof raw.default_expiry !== "string" || raw.default_expiry.trim().length === 0) {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' requires default_expiry string`,
    );
  }
  if (typeof raw.skill !== "string" || raw.skill.trim().length === 0) {
    throw new VerbClassificationError("verb-class-schema", `verb '${name}' requires skill string`);
  }
  if (typeof raw.phase !== "string" || raw.phase.trim().length === 0) {
    throw new VerbClassificationError("verb-class-schema", `verb '${name}' requires phase string`);
  }
  if (typeof raw.env_bypass !== "string" || !raw.env_bypass.startsWith("DEFT_ALLOW_")) {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' requires env_bypass starting with DEFT_ALLOW_`,
    );
  }
  const ops = asStringArray(raw.authz_operations, `${name}.authz_operations`);
  if (ops.length === 0) {
    throw new VerbClassificationError(
      "verb-class-schema",
      `verb '${name}' authz_operations must be non-empty`,
    );
  }
  if (raw.wildcard_allowed === true) {
    throw new VerbClassificationError(
      "verb-class-policy",
      `verb '${name}' must set wildcard_allowed=false for Wave 4 release-class closed verbs`,
    );
  }
  return {
    closure_set: asStringArray(raw.closure_set, `${name}.closure_set`),
    explicit_required: asStringArray(raw.explicit_required, `${name}.explicit_required`),
    irreversibility: irreversibility.trim(),
    wildcard_allowed: false,
    recurring_allowed: raw.recurring_allowed,
    default_expiry: raw.default_expiry.trim(),
    skill: raw.skill.trim(),
    phase: raw.phase.trim(),
    authz_operations: ops,
    env_bypass: raw.env_bypass.trim(),
  };
}

/**
 * Validate and normalise a raw JSON payload into a VerbClassificationTable.
 * Throws VerbClassificationError on schema violations.
 */
export function parseVerbClassification(raw: unknown): VerbClassificationTable {
  if (!isRecord(raw)) {
    throw new VerbClassificationError("verb-class-schema", "root must be an object");
  }
  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new VerbClassificationError(
      "verb-class-schema",
      "schemaVersion must be a positive integer",
    );
  }
  if (!isRecord(raw.verbs)) {
    throw new VerbClassificationError("verb-class-schema", "verbs must be an object");
  }
  const verbs: Record<string, VerbClassificationRow> = {};
  for (const [name, row] of Object.entries(raw.verbs)) {
    if (name.trim().length === 0) {
      throw new VerbClassificationError("verb-class-schema", "verb name must be non-empty");
    }
    verbs[name.trim()] = parseRow(name.trim(), row);
  }
  if (Object.keys(verbs).length === 0) {
    throw new VerbClassificationError("verb-class-schema", "verbs must include at least one row");
  }
  return {
    schemaVersion,
    description: typeof raw.description === "string" ? raw.description : undefined,
    verbs,
  };
}

/** Built-in Wave 4/5 rows used when the file is unavailable (tests / install). */
export function builtinReleaseVerbClassification(): VerbClassificationTable {
  return parseVerbClassification({
    schemaVersion: 1,
    description: "builtin release-class + finish-loop closed verbs (#1095 / #871)",
    verbs: {
      "release-cut": {
        closure_set: [
          "changelog-promote",
          "roadmap-render",
          "tag-create",
          "tag-push",
          "gh-release-create-draft",
        ],
        explicit_required: ["release-publish", "release-rollback"],
        irreversibility: "reversible-via-release-rollback",
        wildcard_allowed: false,
        recurring_allowed: false,
        default_expiry: "4h",
        skill: "content/skills/deft-directive-release/SKILL.md",
        phase: "Phase 4",
        authz_operations: ["release-cut", "deployment"],
        env_bypass: "DEFT_ALLOW_RELEASE_CUT",
      },
      "release-publish": {
        closure_set: [],
        explicit_required: [],
        irreversibility: "destructive",
        wildcard_allowed: false,
        recurring_allowed: false,
        default_expiry: "1h",
        skill: "content/skills/deft-directive-release/SKILL.md",
        phase: "Phase 5",
        authz_operations: ["release-publish", "deployment"],
        env_bypass: "DEFT_ALLOW_RELEASE_PUBLISH",
      },
      "release-rollback": {
        closure_set: [],
        explicit_required: [],
        irreversibility: "destructive",
        wildcard_allowed: false,
        recurring_allowed: false,
        default_expiry: "1h",
        skill: "content/skills/deft-directive-release/SKILL.md",
        phase: "Phase 7",
        authz_operations: ["release-rollback", "deployment"],
        env_bypass: "DEFT_ALLOW_RELEASE_ROLLBACK",
      },
      "finish-loop": {
        closure_set: [
          "edit",
          "push",
          "pr",
          "merge",
          "pr-watch",
          "pr-finish-loop",
          "directive-finish-loop",
        ],
        explicit_required: ["release-cut", "release-publish", "release-rollback"],
        irreversibility: "reversible-via-git-revert",
        wildcard_allowed: false,
        recurring_allowed: true,
        default_expiry: "8h",
        skill: "content/contracts/finish-loop.md",
        phase: "walk-away",
        authz_operations: ["edit", "push", "pr", "merge"],
        env_bypass: "DEFT_ALLOW_FINISH_LOOP",
      },
    },
  });
}

/**
 * Resolve conventions/verb-classification.json relative to a project root, then
 * walk up from this module for framework source layouts.
 */
export function resolveVerbClassificationPath(projectRoot?: string | null): string | null {
  const candidates: string[] = [];
  if (projectRoot !== null && projectRoot !== undefined && projectRoot.trim().length > 0) {
    candidates.push(resolve(projectRoot, "conventions", "verb-classification.json"));
  }
  // packages/core/src/authz → repo root: ../../../../conventions
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(
      resolve(here, "..", "..", "..", "..", "conventions", "verb-classification.json"),
    );
    candidates.push(resolve(here, "..", "..", "..", "conventions", "verb-classification.json"));
  } catch {
    // ignore import.meta failures in non-ESM test shims
  }
  candidates.push(join(process.cwd(), "conventions", "verb-classification.json"));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadVerbClassification(projectRoot?: string | null): VerbClassificationTable {
  const path = resolveVerbClassificationPath(projectRoot);
  if (path === null) {
    return builtinReleaseVerbClassification();
  }
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new VerbClassificationError(
      "verb-class-parse",
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseVerbClassification(raw);
}

export function getVerbRow(
  table: VerbClassificationTable,
  verb: string,
): VerbClassificationRow | null {
  const key = verb.trim().toLowerCase();
  const direct = table.verbs[key];
  if (direct !== undefined) return direct;
  for (const [name, row] of Object.entries(table.verbs)) {
    if (name.toLowerCase() === key) return row;
  }
  return null;
}
