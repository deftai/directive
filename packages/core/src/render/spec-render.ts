import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_INCLUDE_SCOPES_MODE,
  type IncludeScopesMode,
  LEGACY_ARTIFACTS_NARRATIVE_KEY,
  RENDERABLE_SPEC_STATUSES,
  SPEC_RENDER_BANNER,
  SPECIFICATION_NARRATIVE_KEY_ORDER,
} from "./constants.js";
import { buildScopeOutlookSection } from "./scope-outlook.js";
import { validateSpec } from "./spec-validate.js";
import { stripTrailingWhitespace } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

function splitAcceptance(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((s) => s.length > 0);
  }
  if (typeof value !== "string") return [];
  const parts: string[] = [];
  for (const line of value.split("\n")) {
    let cleaned = line.trim();
    if (!cleaned) continue;
    if (cleaned.startsWith("- ") || cleaned.startsWith("* ")) {
      cleaned = cleaned.slice(2).trim();
    }
    if (cleaned) parts.push(cleaned);
  }
  return parts;
}

/**
 * Normalize CLI / API include-scopes values to a mode (#1566).
 * Default is compact (`off`) so completed lifecycle is not dumped into SPECIFICATION.md.
 */
export function normalizeIncludeScopesMode(
  value: boolean | IncludeScopesMode | string | undefined,
  defaultMode: IncludeScopesMode = DEFAULT_INCLUDE_SCOPES_MODE,
): IncludeScopesMode {
  if (value === undefined) return defaultMode;
  if (value === true) return "all";
  if (value === false) return "off";
  const v = String(value).trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "no") return "off";
  if (v === "current" || v === "active") return "current";
  if (v === "all" || v === "on" || v === "true" || v === "1" || v === "yes") return "all";
  return defaultMode;
}

export type RenderSpecResult = readonly [boolean, string];

export interface RenderSpecOptions {
  /**
   * Lifecycle scope aggregation (#1566).
   * - `off` / false (default): no Scope outlook section
   * - `current` / `active`: pending + active only
   * - `all` / true / `on`: pending + active + completed (legacy dump)
   */
  readonly includeScopes?: boolean | IncludeScopesMode;
  /** When true, emit the LegacyArtifacts narrative. Default false (#1566). */
  readonly includeLegacyArtifacts?: boolean;
}

function shouldRenderNarrativeKey(key: string, includeLegacyArtifacts: boolean): boolean {
  if (includeLegacyArtifacts) return true;
  return key !== LEGACY_ARTIFACTS_NARRATIVE_KEY;
}

/** Render specification JSON to markdown (mirrors ``scripts/spec_render.render_spec``). */
export function renderSpec(
  specPath: string,
  outPath: string,
  options: RenderSpecOptions = {},
): RenderSpecResult {
  const includeScopesMode = normalizeIncludeScopesMode(options.includeScopes);
  const includeLegacyArtifacts = options.includeLegacyArtifacts ?? false;
  const [ok, msg] = validateSpec(specPath);
  if (!ok) return [false, msg];

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as JsonObject;
  const plan = spec.plan;
  let status = "";
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    status = String((plan as JsonObject).status ?? "");
  } else {
    status = String(spec.status ?? "");
  }

  if (!RENDERABLE_SPEC_STATUSES.has(status)) {
    const renderable = [...RENDERABLE_SPEC_STATUSES].join(", ");
    return [
      false,
      `⚠ specification.vbrief.json status is '${status}' (expected one of ${renderable})\n` +
        "  Have the user review and set status to one of the renderable statuses before rendering.",
    ];
  }

  const lines: string[] = [SPEC_RENDER_BANNER];
  let title = "Specification";
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    title = String((plan as JsonObject).title ?? "Specification");
  } else if (plan) {
    title = String(plan);
  } else {
    title = String(spec.title ?? "Specification");
  }
  lines.push(`# ${title}\n`);

  let narratives: Record<string, unknown> = {};
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const n = (plan as JsonObject).narratives;
    if (typeof n === "object" && n !== null && !Array.isArray(n))
      narratives = n as Record<string, unknown>;
  } else {
    const legacy = spec.overview ?? spec.description ?? "";
    if (legacy) narratives = { Overview: legacy };
  }

  const renderedKeys = new Set<string>();
  for (const key of SPECIFICATION_NARRATIVE_KEY_ORDER) {
    if (!shouldRenderNarrativeKey(key, includeLegacyArtifacts)) continue;
    const val = narratives[key];
    if (val) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(val)}\n`);
      renderedKeys.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (renderedKeys.has(key) || !narratives[key]) continue;
    if (!shouldRenderNarrativeKey(key, includeLegacyArtifacts)) continue;
    lines.push(`## ${key}\n`);
    lines.push(`${String(narratives[key])}\n`);
  }

  const items =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? ((plan as JsonObject).items ?? [])
      : (spec.tasks ?? []);
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const itemObj = item as JsonObject;
      const itemId = String(itemObj.id ?? "");
      const titleText = String(itemObj.title ?? "");
      const itemStatus = String(itemObj.status ?? "");
      lines.push(`## ${itemId}: ${titleText}  \`[${itemStatus}]\`\n`);

      let deps: unknown;
      const metadata = itemObj.metadata;
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
        deps = (metadata as JsonObject).dependencies;
      }
      if (!deps) deps = itemObj.dependencies;
      if (Array.isArray(deps) && deps.length > 0) {
        lines.push(`**Depends on**: ${deps.map(String).join(", ")}\n`);
      }

      const narrative = itemObj.narrative;
      if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
        for (const [key, val] of Object.entries(narrative as JsonObject)) {
          if (key === "Traces") lines.push(`**Traces**: ${String(val)}\n`);
          else if (key === "Acceptance") {
            for (const line of splitAcceptance(val)) lines.push(`- ${line}`);
            lines.push("");
          } else lines.push(`${String(val)}\n`);
        }
      } else if (Array.isArray(narrative)) {
        for (const entry of narrative) lines.push(`- ${String(entry)}`);
        lines.push("");
      } else if (narrative) {
        lines.push(`${String(narrative)}\n`);
      }
    }
  }

  if (includeScopesMode !== "off") {
    const vbriefDir = resolve(dirname(specPath));
    const scopeLines = buildScopeOutlookSection(vbriefDir, {
      includeProposed: false,
      includeCompleted: includeScopesMode === "all",
    });
    if (scopeLines.length > 0) lines.push(...scopeLines);
  }

  writeFileSync(outPath, stripTrailingWhitespace(lines.join("\n")), "utf8");
  return [true, `✓ Rendered to ${outPath}`];
}

export function parseIncludeScopesFlag(argv: readonly string[]): {
  includeScopes: IncludeScopesMode;
  includeLegacyArtifacts: boolean;
  remaining: string[];
} {
  let includeScopes: IncludeScopesMode = DEFAULT_INCLUDE_SCOPES_MODE;
  let includeLegacyArtifacts = false;
  const remaining: string[] = [];
  for (const arg of argv) {
    if (arg === "--include-scopes") {
      includeScopes = "all";
      continue;
    }
    if (arg.startsWith("--include-scopes=")) {
      const value = arg.split("=", 2)[1] ?? "";
      includeScopes = normalizeIncludeScopesMode(value);
      continue;
    }
    if (arg === "--include-legacy-artifacts") {
      includeLegacyArtifacts = true;
      continue;
    }
    if (arg.startsWith("--include-legacy-artifacts=")) {
      const value = (arg.split("=", 2)[1] ?? "").toLowerCase();
      includeLegacyArtifacts =
        value === "on" || value === "true" || value === "1" || value === "yes";
      continue;
    }
    remaining.push(arg);
  }
  return { includeScopes, includeLegacyArtifacts, remaining };
}

/** CLI entry (mirrors ``scripts/spec_render.main``). */
export function main(argv: readonly string[]): number {
  const { includeScopes, includeLegacyArtifacts, remaining } = parseIncludeScopesFlag(argv);
  if (remaining.length === 0) {
    process.stderr.write(
      "Usage: spec-render <spec_file> [out_file] " +
        "[--include-scopes=off|current|all] [--include-legacy-artifacts=on|off]\n" +
        "  Defaults (#1566): --include-scopes=off --include-legacy-artifacts=off\n",
    );
    return 2;
  }
  const specPath = remaining[0] ?? "";
  const outPath =
    remaining.length >= 2
      ? (remaining[1] ?? "")
      : join(resolve(dirname(specPath)), "..", "SPECIFICATION.md");
  const [ok, message] = renderSpec(specPath, outPath, {
    includeScopes,
    includeLegacyArtifacts,
  });
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
