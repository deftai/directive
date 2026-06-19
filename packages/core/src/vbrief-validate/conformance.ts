import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GitCommandError,
  GitNotFoundError,
  gitStagedFiles,
  gitTrackedFiles,
} from "../encoding/git.js";
import { fnmatchCase } from "../encoding/text.js";
import type { JsonObject } from "./schema.js";

export const DOC_CORE = new Set(["vBRIEFInfo", "plan"]);

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
]);

export const ITEM_CORE = new Set([
  "id",
  "uid",
  "title",
  "status",
  "narrative",
  "subItems",
  "planRef",
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
]);

export const EXTENSION_PREFIXES = ["x-directive/", "x-vbrief/"] as const;

export const ALLOW_LIST = new Set(["plan.policy", "plan.completedNote"]);

export interface ConformanceFinding {
  readonly path: string;
  readonly level: string;
  readonly key: string;
  readonly location: string;
}

export function renderFinding(finding: ConformanceFinding): string {
  return `  ${finding.path} [${finding.level}] bare key '${finding.key}' at ${finding.location}`;
}

function isConformant(level: string, key: string, core: ReadonlySet<string>): boolean {
  if (core.has(key)) {
    return true;
  }
  for (const prefix of EXTENSION_PREFIXES) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return ALLOW_LIST.has(`${level}.${key}`);
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
    if (!isConformant("item", key, ITEM_CORE)) {
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
    if (!isConformant("document", key, DOC_CORE)) {
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
    if (!isConformant("plan", key, PLAN_CORE)) {
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
  return posix.startsWith("vbrief/") && posix.endsWith(".vbrief.json");
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
  options: { mode?: ConformanceMode; allowListPath?: string | null } = {},
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

  if (!existsSync(join(root, "vbrief"))) {
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

  const candidates = relPaths
    .map((p) => p.replace(/\\/g, "/"))
    .filter((posix) => isVbriefPath(posix) && !isAllowListed(posix, customGlobs));

  const findings: ConformanceFinding[] = [];
  for (const posix of candidates) {
    const full = join(root, posix);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    try {
      findings.push(...scanVbrief(posix, JSON.parse(text)));
    } catch {}
  }

  if (findings.length > 0) {
    const uniquePaths = new Set(findings.map((f) => f.path));
    const header =
      `\u274c verify_vbrief_conformance: detected ${findings.length} bare ` +
      `key(s) across ${uniquePaths.size} file(s) (#1620).\n` +
      "  Every vBRIEF key MUST be 0.6 spec-core, x-directive/-namespaced, " +
      "or x-vbrief/-namespaced -- never bare.\n" +
      "  Fix: migrate misused/misspelled core fields to their core home " +
      "(see scripts/vbrief_migrate_conformance.py), or namespace a genuine\n" +
      "  extension under x-directive/. Allow-list a documented file " +
      "exception via --allow-list <path> (newline-separated globs).";
    let body = findings.slice(0, 50).map(renderFinding).join("\n");
    if (findings.length > 50) {
      body += `\n  ... and ${findings.length - 50} more`;
    }
    return { exitCode: 1, findings, message: `${header}\n${body}` };
  }

  return {
    exitCode: 0,
    findings,
    message:
      `\u2713 verify_vbrief_conformance: ${candidates.length} vBRIEF file(s) ` +
      "clean -- no bare keys (#1620).",
  };
}
