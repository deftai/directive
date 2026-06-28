import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  RENDERABLE_SPEC_STATUSES,
  SPEC_RENDER_BANNER,
  SPECIFICATION_NARRATIVE_KEY_ORDER,
} from "./constants.js";
import { aggregateScopeSection } from "./scope-outlook.js";
import { validateSpec } from "./spec-validate.js";

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

export type RenderSpecResult = readonly [boolean, string];

export interface RenderSpecOptions {
  readonly includeScopes?: boolean;
}

/** Render specification JSON to markdown (mirrors ``scripts/spec_render.render_spec``). */
export function renderSpec(
  specPath: string,
  outPath: string,
  options: RenderSpecOptions = {},
): RenderSpecResult {
  const includeScopes = options.includeScopes ?? true;
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
    const val = narratives[key];
    if (val) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(val)}\n`);
      renderedKeys.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (renderedKeys.has(key) || !narratives[key]) continue;
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

  if (includeScopes) {
    const vbriefDir = resolve(dirname(specPath));
    const scopeLines = aggregateScopeSection(vbriefDir);
    if (scopeLines.length > 0) lines.push(...scopeLines);
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");
  return [true, `✓ Rendered to ${outPath}`];
}

export function parseIncludeScopesFlag(argv: readonly string[]): {
  includeScopes: boolean;
  remaining: string[];
} {
  let includeScopes = true;
  const remaining: string[] = [];
  for (const arg of argv) {
    if (arg === "--include-scopes") {
      includeScopes = true;
      continue;
    }
    if (arg.startsWith("--include-scopes=")) {
      const value = arg.split("=", 2)[1]?.toLowerCase() ?? "";
      includeScopes = value === "on" || value === "true" || value === "1" || value === "yes";
      continue;
    }
    remaining.push(arg);
  }
  return { includeScopes, remaining };
}

/** CLI entry (mirrors ``scripts/spec_render.main``). */
export function main(argv: readonly string[]): number {
  const { includeScopes, remaining } = parseIncludeScopesFlag(argv);
  if (remaining.length === 0) {
    process.stderr.write(
      "Usage: spec_render.py <spec_file> [out_file] [--include-scopes=on|off]\n",
    );
    return 2;
  }
  const specPath = remaining[0] ?? "";
  const outPath =
    remaining.length >= 2
      ? (remaining[1] ?? "")
      : join(resolve(dirname(specPath)), "..", "SPECIFICATION.md");
  const [ok, message] = renderSpec(specPath, outPath, { includeScopes });
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
