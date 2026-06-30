import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isExtensionKey } from "@deftai/directive-types";
import type { JsonObject } from "./schema.js";
import { validateVbriefSchema } from "./schema.js";

/** Relative path to extension round-trip conformance fixtures (#715). */
export const EXTENSION_CONFORMANCE_FIXTURES_DIR = "content/vbrief/conformance/extensions/valid";

export interface ExtensionEntry {
  readonly jsonPath: string;
  readonly key: string;
  readonly value: unknown;
}

export interface ExtensionRoundtripFinding {
  readonly path: string;
  readonly message: string;
}

/** Thrown when `reEmitVbriefArtifact` rejects an artifact that fails schema validation. */
export class VbriefSchemaValidationError extends Error {
  constructor(
    readonly relPath: string,
    readonly errors: readonly string[],
  ) {
    super(`schema validation failed for ${relPath}: ${errors.join("; ")}`);
    this.name = "VbriefSchemaValidationError";
  }
}

/** Recursively collect every `x-<consumer>/` key in `value` using the contract pattern. */
export function collectExtensionEntries(value: unknown, jsonPath = "$"): ExtensionEntry[] {
  if (Array.isArray(value)) {
    const entries: ExtensionEntry[] = [];
    for (let index = 0; index < value.length; index += 1) {
      entries.push(...collectExtensionEntries(value[index], `${jsonPath}[${index}]`));
    }
    return entries;
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const obj = value as Record<string, unknown>;
  const entries: ExtensionEntry[] = [];
  for (const [key, entryValue] of Object.entries(obj)) {
    const childPath = `${jsonPath}.${JSON.stringify(key)}`;
    if (isExtensionKey(key)) {
      entries.push({ jsonPath: childPath, key, value: entryValue });
    }
    entries.push(...collectExtensionEntries(entryValue, childPath));
  }
  return entries;
}

function entriesByPath(entries: readonly ExtensionEntry[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const entry of entries) {
    map.set(entry.jsonPath, entry.value);
  }
  return map;
}

/** Compare extension keys/values between two parsed artifacts (JSON structural equality). */
export function findExtensionPreservationViolations(
  original: unknown,
  roundtripped: unknown,
): string[] {
  const before = collectExtensionEntries(original);
  const afterMap = entriesByPath(collectExtensionEntries(roundtripped));
  const violations: string[] = [];

  for (const entry of before) {
    if (!afterMap.has(entry.jsonPath)) {
      violations.push(`dropped extension key '${entry.key}' at ${entry.jsonPath}`);
      continue;
    }
    const afterValue = afterMap.get(entry.jsonPath);
    if (JSON.stringify(entry.value) !== JSON.stringify(afterValue)) {
      violations.push(`mutated extension key '${entry.key}' at ${entry.jsonPath}`);
    }
  }

  return violations;
}

/**
 * Canonical reference-consumer read/write pipeline: validate, serialize, re-parse.
 * Extension properties MUST survive this path verbatim (xBRIEF v0.8 §7).
 */
export function reEmitVbriefArtifact(artifact: JsonObject, relPath = "<roundtrip>"): JsonObject {
  const schemaErrors = validateVbriefSchema(artifact, relPath);
  if (schemaErrors.length > 0) {
    throw new VbriefSchemaValidationError(relPath, schemaErrors);
  }
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  return JSON.parse(serialized) as JsonObject;
}

export function renderExtensionRoundtripFinding(finding: ExtensionRoundtripFinding): string {
  return `  ${finding.path}: ${finding.message}`;
}

export interface ExtensionRoundtripEvaluateResult {
  readonly exitCode: number;
  readonly findings: readonly ExtensionRoundtripFinding[];
  readonly message: string;
}

/** Run extension round-trip preservation over packaged conformance fixtures. */
export function evaluateExtensionRoundtrip(projectRoot: string): ExtensionRoundtripEvaluateResult {
  const root = resolve(projectRoot);
  const fixturesDir = join(root, EXTENSION_CONFORMANCE_FIXTURES_DIR);

  if (!existsSync(fixturesDir)) {
    return {
      exitCode: 0,
      findings: [],
      message: "",
    };
  }

  let fixtureNames: string[];
  try {
    fixtureNames = readdirSync(fixturesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".vbrief.json"))
      .map((entry) => entry.name)
      .sort();
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 2,
      findings: [],
      message: `\u274c verify_vbrief_conformance: cannot read extension fixtures: ${e.message ?? err}`,
    };
  }

  if (fixtureNames.length === 0) {
    return {
      exitCode: 2,
      findings: [],
      message:
        `\u274c verify_vbrief_conformance: no *.vbrief.json fixtures under ` +
        `${EXTENSION_CONFORMANCE_FIXTURES_DIR}/.`,
    };
  }

  const findings: ExtensionRoundtripFinding[] = [];
  for (const name of fixtureNames) {
    const relPath = `${EXTENSION_CONFORMANCE_FIXTURES_DIR}/${name}`;
    const fullPath = join(fixturesDir, name);
    let text: string;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      findings.push({
        path: relPath,
        message: `unreadable fixture: ${e.message ?? String(err)}`,
      });
      continue;
    }

    let parsed: JsonObject;
    try {
      parsed = JSON.parse(text) as JsonObject;
    } catch (err: unknown) {
      findings.push({
        path: relPath,
        message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const schemaErrors = validateVbriefSchema(parsed, relPath);
    for (const error of schemaErrors) {
      findings.push({ path: relPath, message: error });
    }
    if (schemaErrors.length > 0) {
      continue;
    }

    const roundtripped = reEmitVbriefArtifact(parsed, relPath);
    for (const violation of findExtensionPreservationViolations(parsed, roundtripped)) {
      findings.push({ path: relPath, message: violation });
    }
  }

  if (findings.length > 0) {
    const header =
      `\u274c verify_vbrief_conformance: extension round-trip preservation failed ` +
      `(${findings.length} finding(s), #715).\n` +
      "  Every key matching ^x-[a-z0-9-]+/ MUST survive load->re-emit verbatim at every object level.";
    const body = findings.slice(0, 50).map(renderExtensionRoundtripFinding).join("\n");
    const tail = findings.length > 50 ? `\n  ... and ${findings.length - 50} more` : "";
    return { exitCode: 1, findings, message: `${header}\n${body}${tail}` };
  }

  return {
    exitCode: 0,
    findings,
    message:
      `\u2713 verify_vbrief_conformance: ${fixtureNames.length} extension fixture(s) ` +
      "round-trip clean (#715).",
  };
}
