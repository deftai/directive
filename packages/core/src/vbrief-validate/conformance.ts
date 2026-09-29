import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GitCommandError,
  GitNotFoundError,
  gitStagedFiles,
  gitTrackedFiles,
} from "../encoding/git.js";
import { fnmatchCase } from "../encoding/text.js";
import {
  isLifecycleArtifactPath,
  LIFECYCLE_DIR_NAMES,
  projectDefinitionRelPath,
  resolveProjectDefinitionPath,
} from "../layout/resolve.js";
import { validateCreatedUpdatedChronology } from "./chronology.js";
import { filenameConventionExamples, isScopeLifecyclePath, validateFilename } from "./filename.js";
import { evaluateExtensionRoundtrip } from "./roundtrip.js";
import type { JsonObject } from "./schema.js";

export const DOC_CORE = new Set(["vBRIEFInfo", "xBRIEFInfo", "plan"]);

export const PLAN_CORE = new Set([
  "id",
  "uid",
  "title",
  "status",
  "items",
  "narratives",
  "architecture",
  "edges",
  "tags",
  "metadata",
  "created",
  "updated",
  "author",
  "reviewers",
  "uris",
  "references",
  "timezone",
  "agent",
  "lastModifiedBy",
  "changeLog",
  "sequence",
  "fork",
  // Product-first done-gate (#3284): plan.acceptance.commands / none_stated / source_rung.
  "acceptance",
]);

export const ITEM_CORE = new Set([
  "id",
  "uid",
  "type",
  "summary",
  "title",
  "status",
  "narrative",
  "subItems",
  "planRef",
  "planRefs",
  "tags",
  "metadata",
  "created",
  "updated",
  "completed",
  "priority",
  "dueDate",
  "startDate",
  "endDate",
  "percentComplete",
  "participants",
  "location",
  "uris",
  "recurrence",
  "reminders",
  "classification",
  "relatedComments",
  "timezone",
  "sequence",
  "lastModifiedBy",
  "lockedBy",
  "items",
  // Optional PlanItem.effort enum S/M/L/XL (#1581) — schema-validated, core not extension.
  "effort",
  // #3305 Option B: acceptance evidence/disposition are NOT ITEM_CORE.
  // Canonical keys: plan.items[].x-directive/evidence and x-directive/disposition
  // (accepted via EXTENSION_PREFIXES). Bare evidence/disposition fail #1620.
]);

export const EXTENSION_PREFIXES = ["x-directive/", "x-vbrief/", "x-xbrief/"] as const;

export interface ConformanceFinding {
  readonly path: string;
  readonly level: string;
  readonly key: string;
  readonly location: string;
}

const SAFE_FINDING_KEY = /^[A-Za-z][A-Za-z0-9._/-]{0,63}$/;
const SENSITIVE_FINDING_KEY = /(?:auth|credential|password|private|secret|token|api.?key)/i;

/**
 * Bounded presentation of a raw finding key (#3796). `finding.key` stays exact
 * for machine consumers; only this rendered form is sanitised, so a hostile or
 * sensitive key cannot ride a stderr diagnostic out of the process.
 */
function renderFindingKey(key: string): string {
  return SAFE_FINDING_KEY.test(key) && !SENSITIVE_FINDING_KEY.test(key)
    ? key
    : `<redacted-key length=${[...key].length}>`;
}

export function renderFinding(finding: ConformanceFinding): string {
  return (
    `  ${finding.path} [${finding.level}] bare key ` +
    `'${renderFindingKey(finding.key)}' at ${finding.location}`
  );
}

function isConformant(key: string, core: ReadonlySet<string>): boolean {
  if (core.has(key)) {
    return true;
  }
  for (const prefix of EXTENSION_PREFIXES) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  // No allow-list exceptions: every non-core key MUST be namespaced (#1650).
  return false;
}

function planPlanRefFinding(relPath: string, value: unknown): ConformanceFinding | null {
  if (typeof value === "string" && value.trim().startsWith("#")) {
    return {
      path: relPath,
      level: "plan",
      key: "planRef",
      location: "plan (issue-style -- migrate to references[])",
    };
  }
  return null;
}

function scanItem(relPath: string, item: JsonObject, location: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const key of Object.keys(item)) {
    if (!isConformant(key, ITEM_CORE)) {
      findings.push({ path: relPath, level: "item", key, location });
    }
  }
  for (const nestedKey of ["items", "subItems"] as const) {
    const nested = item[nestedKey];
    if (Array.isArray(nested)) {
      for (let index = 0; index < nested.length; index += 1) {
        const child = nested[index];
        if (typeof child === "object" && child !== null && !Array.isArray(child)) {
          findings.push(
            ...scanItem(relPath, child as JsonObject, `${location}.${nestedKey}[${index}]`),
          );
        }
      }
    }
  }
  return findings;
}

/** Scan a parsed vBRIEF document for bare keys at doc / plan / item level (#1620). */
export function scanVbrief(relPath: string, data: unknown): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return findings;
  }
  const doc = data as JsonObject;

  for (const key of Object.keys(doc)) {
    if (!isConformant(key, DOC_CORE)) {
      findings.push({ path: relPath, level: "document", key, location: "<root>" });
    }
  }

  const plan = doc.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return findings;
  }
  const planObj = plan as JsonObject;

  for (const key of Object.keys(planObj)) {
    if (key === "planRef") {
      const hit = planPlanRefFinding(relPath, planObj.planRef);
      if (hit !== null) {
        findings.push(hit);
      }
      continue;
    }
    if (!isConformant(key, PLAN_CORE)) {
      findings.push({ path: relPath, level: "plan", key, location: "plan" });
    }
  }

  const items = planObj.items;
  if (Array.isArray(items)) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        findings.push(...scanItem(relPath, item as JsonObject, `plan.items[${index}]`));
      }
    }
  }

  return findings;
}

function loadAllowList(path: string | null): string[] {
  if (path === null) {
    return [];
  }
  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    out.push(stripped);
  }
  return out;
}

function isAllowListed(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pat) => fnmatchCase(relPath, pat));
}

function isVbriefPath(posix: string): boolean {
  // Layout-aware (#2109 part 1): accept either lifecycle root + either suffix.
  return isLifecycleArtifactPath(posix);
}

/**
 * Canonical PROJECT-DEFINITION on disk (#4876). Untracked / non-injected PD
 * must still enter the candidate set; absence is not an error (Setup may not
 * have written it yet). Legacy vbrief-only trees keep the on-disk path without
 * forcing migrate:xbrief here.
 */
function canonicalProjectDefinitionOnDisk(
  root: string,
): { fullPath: string; displayPath: string } | null {
  let fullPath: string;
  let displayPath: string;
  try {
    fullPath = resolveProjectDefinitionPath(root);
    displayPath = projectDefinitionRelPath(root).replace(/\\/g, "/");
  } catch {
    fullPath = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    displayPath = "vbrief/PROJECT-DEFINITION.vbrief.json";
  }
  if (!existsSync(fullPath)) {
    return null;
  }
  return { fullPath, displayPath };
}

type ConformanceCandidate = {
  displayPath: string;
  fullPath: string;
  /** Fail-closed on IO/parse; true for DEFT_PROJECT_PATH and on-disk PD (#4876). */
  required: boolean;
  /** Display/recovery label from DEFT_PROJECT_PATH (#3796). */
  configured: boolean;
};

function injectProjectDefinitionCandidate(
  candidates: ConformanceCandidate[],
  input: {
    lexicalPath: string;
    displayPath: string;
    configured: boolean;
    missingMessage: string;
    unreadableMessage: string;
  },
): ConformanceEvaluateResult | null {
  if (!existsSync(input.lexicalPath)) {
    return {
      exitCode: 2,
      findings: [],
      message: input.missingMessage,
    };
  }
  let fullPath: string;
  try {
    fullPath = realpathSync(input.lexicalPath);
  } catch {
    return {
      exitCode: 2,
      findings: [],
      message: input.unreadableMessage,
    };
  }
  const existing = candidates.find((candidate) => {
    try {
      return realpathSync(candidate.fullPath) === fullPath;
    } catch {
      return resolve(candidate.fullPath) === fullPath;
    }
  });
  if (existing === undefined) {
    candidates.push({
      displayPath: input.displayPath,
      fullPath,
      required: true,
      configured: input.configured,
    });
  } else {
    existing.displayPath = input.displayPath;
    existing.fullPath = fullPath;
    existing.required = true;
    existing.configured = input.configured;
  }
  return null;
}

function formatChronologyWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  const header =
    `verify_vbrief_conformance: ${warnings.length} created/updated ` +
    "chronology warning(s) (#4423).";
  return [header, ...warnings.map((warning) => `WARN: ${warning}`)].join("\n");
}

function withChronologyMessage(message: string, warnings: readonly string[]): string {
  const extra = formatChronologyWarnings(warnings);
  if (extra.length === 0) {
    return message;
  }
  if (message.length === 0) {
    return extra;
  }
  return `${message}\n${extra}`;
}

export type ConformanceMode = "all" | "staged";

export interface ConformanceEvaluateResult {
  readonly exitCode: number;
  readonly findings: readonly ConformanceFinding[];
  readonly message: string;
}

/** Pure driver returning exit code, findings, and human message. */
export function evaluateConformance(
  projectRoot: string,
  options: {
    mode?: ConformanceMode;
    allowListPath?: string | null;
    projectDefinitionPath?: string | null;
  } = {},
): ConformanceEvaluateResult {
  const mode = options.mode ?? "all";
  const root = resolve(projectRoot);

  if (mode !== "all" && mode !== "staged") {
    return {
      exitCode: 2,
      findings: [],
      message:
        `\u274c verify_vbrief_conformance: unrecognised mode '${mode}' ` +
        "(expected 'all' or 'staged').",
    };
  }

  if (!LIFECYCLE_DIR_NAMES.some((dir) => existsSync(join(root, dir)))) {
    return {
      exitCode: 2,
      findings: [],
      message:
        `\u274c verify_vbrief_conformance: no vbrief/ directory under ` +
        `${root}.\n` +
        "  Recovery: run from a project root that contains vbrief/.",
    };
  }

  let customGlobs: string[];
  try {
    customGlobs = loadAllowList(options.allowListPath ?? null);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        exitCode: 2,
        findings: [],
        message:
          `\u274c verify_vbrief_conformance: --allow-list file not found: Error: ENOENT: no such file or directory, open '${options.allowListPath}'\n` +
          "  Recovery: pass an existing path or omit the flag.",
      };
    }
    return {
      exitCode: 2,
      findings: [],
      message: `\u274c verify_vbrief_conformance: --allow-list unreadable: ${e.message ?? err}`,
    };
  }

  let relPaths: string[];
  try {
    relPaths = mode === "staged" ? gitStagedFiles(root) : gitTrackedFiles(root);
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return {
        exitCode: 2,
        findings: [],
        message: "\u274c verify_vbrief_conformance: 'git' executable not found on PATH.",
      };
    }
    if (err instanceof GitCommandError) {
      return {
        exitCode: 2,
        findings: [],
        message:
          `\u274c verify_vbrief_conformance: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a git working tree.",
      };
    }
    throw err;
  }

  const candidates: ConformanceCandidate[] = relPaths
    .map((p) => p.replace(/\\/g, "/"))
    .filter((posix) => isVbriefPath(posix) && !isAllowListed(posix, customGlobs))
    .map((posix) => ({
      displayPath: posix,
      fullPath: join(root, posix),
      required: false,
      configured: false,
    }));

  // Prefer DEFT_PROJECT_PATH / projectDefinitionPath; otherwise force on-disk
  // canonical PD into the candidate set so clean-zero cannot false-certify (#4876).
  const configuredPath = options.projectDefinitionPath?.trim();
  if (configuredPath) {
    const injected = injectProjectDefinitionCandidate(candidates, {
      lexicalPath: resolve(root, configuredPath),
      displayPath: "<configured PROJECT-DEFINITION>",
      configured: true,
      missingMessage:
        "❌ verify_vbrief_conformance: configured PROJECT-DEFINITION does not exist.\n" +
        "  Recovery: fix or unset DEFT_PROJECT_PATH, then rerun conformance.",
      unreadableMessage:
        "❌ verify_vbrief_conformance: configured PROJECT-DEFINITION is unreadable.\n" +
        "  Recovery: fix its permissions or DEFT_PROJECT_PATH, then rerun conformance.",
    });
    if (injected !== null) {
      return injected;
    }
  } else if (mode === "all") {
    // #4876 / Greptile: force on-disk PD for --all only. --staged must not pull
    // an unstaged/untracked PROJECT-DEFINITION into the candidate set.
    const canonical = canonicalProjectDefinitionOnDisk(root);
    if (canonical !== null && !isAllowListed(canonical.displayPath, customGlobs)) {
      const injected = injectProjectDefinitionCandidate(candidates, {
        lexicalPath: canonical.fullPath,
        displayPath: canonical.displayPath,
        configured: false,
        missingMessage:
          "❌ verify_vbrief_conformance: PROJECT-DEFINITION on disk was not counted.\n" +
          "  Recovery: rerun conformance; if this persists, report a gate defect (#4876).",
        unreadableMessage:
          "❌ verify_vbrief_conformance: PROJECT-DEFINITION on disk is unreadable.\n" +
          "  Recovery: fix its permissions, then rerun conformance.",
      });
      if (injected !== null) {
        return injected;
      }
    }
  } else if (mode === "staged") {
    // #4876: staged canonical PD stays in the git candidate set (no on-disk
    // inject), but must be required so invalid JSON cannot clean-pass.
    const canonical = canonicalProjectDefinitionOnDisk(root);
    if (canonical !== null && !isAllowListed(canonical.displayPath, customGlobs)) {
      let canonicalReal: string | null = null;
      try {
        canonicalReal = realpathSync(canonical.fullPath);
      } catch {
        canonicalReal = resolve(canonical.fullPath);
      }
      for (const candidate of candidates) {
        let candidateReal: string;
        try {
          candidateReal = realpathSync(candidate.fullPath);
        } catch {
          candidateReal = resolve(candidate.fullPath);
        }
        if (candidateReal === canonicalReal) {
          // Keep staged displayPath so D7 filename validation still runs (#4876).
          candidate.required = true;
        }
      }
    }
  }

  const findings: ConformanceFinding[] = [];
  const filenameErrors: string[] = [];
  const chronologyWarnings: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.required && isScopeLifecyclePath(candidate.displayPath)) {
      filenameErrors.push(...validateFilename(candidate.displayPath));
    }
    let text: string;
    try {
      text = readFileSync(candidate.fullPath, "utf8");
    } catch {
      if (candidate.required) {
        return {
          exitCode: 2,
          findings,
          message: candidate.configured
            ? "❌ verify_vbrief_conformance: configured PROJECT-DEFINITION is unreadable.\n" +
              "  Recovery: fix its permissions or DEFT_PROJECT_PATH, then rerun conformance."
            : "❌ verify_vbrief_conformance: PROJECT-DEFINITION on disk is unreadable.\n" +
              "  Recovery: fix its permissions, then rerun conformance.",
        };
      }
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (candidate.required) {
        return {
          exitCode: 2,
          findings,
          message: candidate.configured
            ? "❌ verify_vbrief_conformance: configured PROJECT-DEFINITION is not valid JSON.\n" +
              "  Recovery: repair the JSON, then rerun conformance."
            : "❌ verify_vbrief_conformance: PROJECT-DEFINITION on disk is not valid JSON.\n" +
              "  Recovery: repair the JSON, then rerun conformance.",
        };
      }
      continue;
    }
    findings.push(...scanVbrief(candidate.displayPath, data));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      chronologyWarnings.push(
        ...validateCreatedUpdatedChronology(data as JsonObject, candidate.displayPath),
      );
    }
  }

  if (filenameErrors.length > 0 || findings.length > 0) {
    const parts: string[] = [];
    if (filenameErrors.length > 0) {
      const d7Header =
        `\u274c verify_vbrief_conformance: ${filenameErrors.length} D7 filename ` +
        `error(s) (#4245).\n` +
        `  Scope filenames MUST match ${filenameConventionExamples()}; ` +
        "dots in the slug are not exempt.";
      let d7Body = filenameErrors
        .slice(0, 50)
        .map((err) => `FAIL: ${err}`)
        .join("\n");
      if (filenameErrors.length > 50) {
        d7Body += `\n  ... and ${filenameErrors.length - 50} more`;
      }
      parts.push(`${d7Header}\n${d7Body}`);
    }
    if (findings.length > 0) {
      const uniquePaths = new Set(findings.map((f) => f.path));
      const header =
        `\u274c verify_vbrief_conformance: detected ${findings.length} bare ` +
        `key(s) across ${uniquePaths.size} file(s) (#1620).\n` +
        "  Every vBRIEF key MUST be spec-core, x-directive/-namespaced, " +
        "x-vbrief/-namespaced, or x-xbrief/-namespaced -- never bare.\n" +
        "  Fix: migrate misused/misspelled core fields to their core home " +
        "(see scripts/vbrief_migrate_conformance.py), or namespace a genuine\n" +
        "  extension under x-directive/. Allow-list a documented file " +
        "exception via --allow-list <path> (newline-separated globs).";
      let body = findings.slice(0, 50).map(renderFinding).join("\n");
      if (findings.length > 50) {
        body += `\n  ... and ${findings.length - 50} more`;
      }
      parts.push(`${header}\n${body}`);
    }
    return {
      exitCode: 1,
      findings,
      message: withChronologyMessage(parts.join("\n"), chronologyWarnings),
    };
  }

  const extensionRoundtrip = evaluateExtensionRoundtrip(root);
  if (extensionRoundtrip.exitCode !== 0) {
    return {
      exitCode: extensionRoundtrip.exitCode,
      findings,
      message: withChronologyMessage(extensionRoundtrip.message, chronologyWarnings),
    };
  }

  const bareKeysMessage =
    `\u2713 verify_vbrief_conformance: ${candidates.length} vBRIEF file(s) ` +
    "clean -- no bare keys (#1620).";

  return {
    exitCode: 0,
    findings,
    message: withChronologyMessage(
      [extensionRoundtrip.message, bareKeysMessage].filter(Boolean).join("\n"),
      chronologyWarnings,
    ),
  };
}
