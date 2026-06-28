import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  greenfieldOverviewNonEmpty,
  renderNarrativeSections,
  resolveExportNarratives,
} from "../spec-authority/narratives.js";
import { resolveSpecAuthority } from "../spec-authority/resolver.js";
import { buildScopeOutlookSection } from "./scope-outlook.js";
import { validateSpec } from "./spec-validate.js";

type JsonObject = Record<string, unknown>;

export type ExportAudience = "stakeholder" | "internal";

export interface ExportSpecOptions {
  readonly projectRoot?: string;
  readonly outPath?: string;
  readonly audience?: ExportAudience;
  readonly includeScopes?: boolean;
  readonly proposedLimit?: number;
}

export type ExportSpecResult = readonly [boolean, string];

function loadPlanTitle(path: string, fallback: string): string {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const plan = doc.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      return String((plan as JsonObject).title ?? fallback);
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Unified spec export (#2013 / #1502). */
export function exportSpec(options: ExportSpecOptions = {}): ExportSpecResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outPath = options.outPath ?? join(projectRoot, "SPECIFICATION.md");
  const audience = options.audience ?? "stakeholder";
  const includeScopes = options.includeScopes ?? true;
  const includeProposed = audience === "internal";

  const authority = resolveSpecAuthority(projectRoot);
  if (!authority) {
    return [false, "✗ Missing vbrief/PROJECT-DEFINITION.vbrief.json — cannot export spec."];
  }

  if (authority.kind === "full-spec" && authority.specPath) {
    const [ok, msg] = validateSpec(authority.specPath);
    if (!ok) return [false, msg];
  } else if (!greenfieldOverviewNonEmpty(authority)) {
    return [
      false,
      "⚠ PROJECT-DEFINITION.vbrief.json Overview narrative is empty (D3). Populate Overview before export.",
    ];
  }

  const narratives = resolveExportNarratives(authority);
  const title =
    authority.kind === "full-spec" && authority.specPath
      ? loadPlanTitle(authority.specPath, "Specification")
      : loadPlanTitle(authority.projectDefPath, "Specification");

  const lines: string[] = [
    authority.banner,
    `# ${title}\n`,
    ...renderNarrativeSections(narratives),
  ];

  if (includeScopes) {
    const scopeLines = buildScopeOutlookSection(authority.vbriefDir, {
      includeProposed,
      proposedLimit: options.proposedLimit,
    });
    if (scopeLines.length > 0) lines.push(...scopeLines);
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");
  return [true, `✓ Exported spec to ${outPath}`];
}

export function parseExportSpecArgv(argv: readonly string[]): {
  options: ExportSpecOptions;
  errors: string[];
} {
  const options: {
    projectRoot?: string;
    outPath?: string;
    audience?: ExportAudience;
    includeScopes?: boolean;
    proposedLimit?: number;
  } = {};
  const errors: string[] = [];
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--audience=stakeholder" || arg === "--audience=internal") {
      options.audience = arg.split("=")[1] as ExportAudience;
      continue;
    }
    if (arg.startsWith("--proposed-limit=")) {
      const n = Number(arg.split("=", 2)[1]);
      if (Number.isFinite(n) && n > 0) options.proposedLimit = n;
      continue;
    }
    if (arg === "--no-scopes") {
      options.includeScopes = false;
      continue;
    }
    if (arg.startsWith("--")) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) options.projectRoot = positional[0];
  if (positional[1]) options.outPath = positional[1];

  return { options: options as ExportSpecOptions, errors };
}

export function exportSpecMain(argv: readonly string[]): number {
  const { options, errors } = parseExportSpecArgv(argv);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    return 2;
  }
  const [ok, msg] = exportSpec(options);
  console.log(msg);
  return ok ? 0 : 1;
}
