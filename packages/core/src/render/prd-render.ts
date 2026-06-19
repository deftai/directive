import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PRD_BANNER, PRD_GENERATED_SENTINEL, PRD_NARRATIVE_KEY_ORDER } from "./constants.js";

type JsonObject = Record<string, unknown>;

export interface RenderPrdOptions {
  readonly force?: boolean;
}

function isDeftGenerated(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const fh = readFileSync(path, "utf8");
    const head = fh.length > 4096 ? fh.slice(0, 4096) : fh;
    return head.includes(PRD_GENERATED_SENTINEL);
  } catch {
    return false;
  }
}

/** Read specification.vbrief.json and write PRD.md (mirrors ``scripts/prd_render.render_prd``). */
export function renderPrd(
  specPath: string,
  outputPath: string,
  options: RenderPrdOptions = {},
): void {
  const force = options.force ?? false;
  if (!existsSync(specPath)) {
    process.stderr.write(`Error: specification file not found: ${specPath}\n`);
    process.exit(1);
  }

  if (!force && !isDeftGenerated(outputPath)) {
    process.stderr.write(
      `Error: refusing to overwrite non-generated PRD at ${outputPath}. ` +
        `This file lacks the "${PRD_GENERATED_SENTINEL}" banner -- it was likely hand-authored. ` +
        "Re-run with --force to overwrite, or point --output at a different file (#539).\n",
    );
    process.exit(2);
  }

  const data = JSON.parse(readFileSync(specPath, "utf8")) as JsonObject;
  const plan = (data.plan ?? {}) as JsonObject;
  const title = String(plan.title ?? "Project");
  const narratives =
    typeof plan.narratives === "object" &&
    plan.narratives !== null &&
    !Array.isArray(plan.narratives)
      ? (plan.narratives as Record<string, unknown>)
      : {};

  if (Object.keys(narratives).length === 0) {
    process.stderr.write(`Warning: no narratives found in ${specPath}\n`);
  }

  const lines: string[] = [PRD_BANNER, `# ${title} -- Product Requirements Document\n`];
  const renderedKeys = new Set<string>();
  for (const key of PRD_NARRATIVE_KEY_ORDER) {
    if (key in narratives) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(narratives[key])}\n`);
      renderedKeys.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (!renderedKeys.has(key)) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(narratives[key])}\n`);
    }
  }
  lines.push(
    "---\n" +
      "*This document is auto-generated from `vbrief/specification.vbrief.json` " +
      "via `task prd:render`. Do not edit directly.*\n",
  );

  writeFileSync(outputPath, lines.join("\n"), "utf8");
  process.stdout.write(`PRD.md written to ${outputPath}\n`);
}

export interface PrdCliArgs {
  readonly spec?: string;
  readonly output?: string;
  readonly force?: boolean;
}

/** CLI entry (mirrors ``scripts/prd_render.main``). */
export function main(args: PrdCliArgs = {}): void {
  renderPrd(args.spec ?? "vbrief/specification.vbrief.json", args.output ?? "PRD.md", {
    force: args.force ?? false,
  });
}

export function parsePrdArgv(argv: readonly string[]): PrdCliArgs {
  const out: { spec?: string; output?: string; force?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--force") out.force = true;
    else if (arg === "--spec") out.spec = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
  }
  return out;
}
