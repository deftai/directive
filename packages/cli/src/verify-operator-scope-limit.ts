#!/usr/bin/env node
/**
 * Warn-first operator scope-limit check (#4545).
 *
 * Seeds a hard ceiling from an operator prompt (closed lexicon) and lists
 * shipped surfaces not traceable to a recorded requirement line. Warn-first:
 * untraceable surfaces print WARN and exit 0; config errors exit 2.
 *
 * Default path always persists a durable ceiling artifact (or merges into
 * --brief-out). Without --surfaces-file, runs a default app/actions inventory;
 * empty inventory warns that surfaces were not checked (does not silent-skip).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCeilingToBrief,
  evaluateUntraceableSurfaces,
  inventoryDefaultSurfaces,
  OPERATOR_SCOPE_CEILING_ARTIFACT_REL,
  type OperatorScopeCeiling,
  type ShippedSurface,
  SURFACES_NOT_CHECKED_REMEDIATION,
  seedOperatorScopeCeiling,
  UNTRACEABLE_SURFACE_REMEDIATION,
} from "@deftai/directive-core/operator-scope-limit";

interface ParsedArgs {
  promptFile?: string;
  prompt?: string;
  surfacesFile?: string;
  briefOut?: string;
  artifactOut?: string;
  projectRoot: string;
  quiet: boolean;
  error?: string;
}

/** Parse verify-operator-scope-limit CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { quiet: false, projectRoot: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--prompt-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --prompt-file: expected one argument" };
      }
      parsed.promptFile = value;
      i += 1;
    } else if (arg?.startsWith("--prompt-file=")) {
      parsed.promptFile = arg.slice("--prompt-file=".length);
    } else if (arg === "--prompt") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --prompt: expected one argument" };
      }
      parsed.prompt = value;
      i += 1;
    } else if (arg?.startsWith("--prompt=")) {
      parsed.prompt = arg.slice("--prompt=".length);
    } else if (arg === "--surfaces-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --surfaces-file: expected one argument" };
      }
      parsed.surfacesFile = value;
      i += 1;
    } else if (arg?.startsWith("--surfaces-file=")) {
      parsed.surfacesFile = arg.slice("--surfaces-file=".length);
    } else if (arg === "--brief-out") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --brief-out: expected one argument" };
      }
      parsed.briefOut = value;
      i += 1;
    } else if (arg?.startsWith("--brief-out=")) {
      parsed.briefOut = arg.slice("--brief-out=".length);
    } else if (arg === "--artifact-out") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --artifact-out: expected one argument" };
      }
      parsed.artifactOut = value;
      i += 1;
    } else if (arg?.startsWith("--artifact-out=")) {
      parsed.artifactOut = arg.slice("--artifact-out=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

function loadPrompt(
  args: ParsedArgs,
): { ok: true; prompt: string } | { ok: false; detail: string } {
  if (typeof args.prompt === "string") {
    return { ok: true, prompt: args.prompt };
  }
  if (typeof args.promptFile === "string" && args.promptFile.length > 0) {
    try {
      return { ok: true, prompt: readFileSync(resolve(args.promptFile), "utf8") };
    } catch (err) {
      return {
        ok: false,
        detail: `failed to read --prompt-file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: false,
    detail: "required: --prompt <text> or --prompt-file <path>",
  };
}

function loadSurfacesFile(
  surfacesFile: string,
): { ok: true; surfaces: ShippedSurface[] } | { ok: false; detail: string } {
  try {
    const raw = readFileSync(resolve(surfacesFile), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { ok: false, detail: "--surfaces-file must be a JSON array" };
    }
    const surfaces: ShippedSurface[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, detail: "--surfaces-file entries must be objects" };
      }
      const obj = entry as Record<string, unknown>;
      if (
        (obj.kind !== "server-action" && obj.kind !== "route" && obj.kind !== "page") ||
        typeof obj.id !== "string" ||
        obj.id.trim().length === 0
      ) {
        return {
          ok: false,
          detail: "--surfaces-file entries need kind (server-action|route|page) and id",
        };
      }
      surfaces.push({
        kind: obj.kind,
        id: obj.id,
        path: typeof obj.path === "string" ? obj.path : undefined,
      });
    }
    return { ok: true, surfaces };
  } catch (err) {
    return {
      ok: false,
      detail: `failed to read --surfaces-file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function writeJsonFile(path: string, value: unknown): { ok: true } | { ok: false; detail: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function loadExistingBrief(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Persist ceiling: explicit outs, else default durable artifact under project root. */
function persistCeiling(input: {
  readonly projectRoot: string;
  readonly ceiling: OperatorScopeCeiling;
  readonly artifactOut?: string;
  readonly briefOut?: string;
}): { ok: true; durablePath: string } | { ok: false; detail: string } {
  const { projectRoot, ceiling, artifactOut, briefOut } = input;
  let durablePath: string | null = null;

  if (typeof artifactOut === "string" && artifactOut.length > 0) {
    const path = resolve(artifactOut);
    const wrote = writeJsonFile(path, ceiling);
    if (!wrote.ok) return wrote;
    durablePath = path;
  }

  if (typeof briefOut === "string" && briefOut.length > 0) {
    const path = resolve(briefOut);
    const existing = loadExistingBrief(path);
    const base: Record<string, unknown> =
      existing ??
      ({
        xBRIEFInfo: { version: "0.8" },
        plan: { status: "draft", metadata: {} },
      } as Record<string, unknown>);
    // Merge/add ceiling onto existing proposed/active brief — never replace scope.
    const merged = applyCeilingToBrief(base, ceiling);
    const wrote = writeJsonFile(path, merged);
    if (!wrote.ok) return wrote;
    durablePath = path;
  }

  if (durablePath === null) {
    const path = resolve(projectRoot, OPERATOR_SCOPE_CEILING_ARTIFACT_REL);
    const wrote = writeJsonFile(path, ceiling);
    if (!wrote.ok) return wrote;
    durablePath = path;
  }

  return { ok: true, durablePath };
}

/** Run the gate and return the process exit code (0 clean/warn, 2 config). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_operator_scope_limit: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);

  const promptLoad = loadPrompt(args);
  if (!promptLoad.ok) {
    process.stderr.write(`verify_operator_scope_limit: ${promptLoad.detail}\n`);
    return 2;
  }

  const seeded = seedOperatorScopeCeiling(promptLoad.prompt, null);
  if (!seeded.ok) {
    process.stderr.write(`verify_operator_scope_limit: ${seeded.detail}\n`);
    // No phrase is a returned miss — still exit 2 so callers know ceiling was not recorded.
    return 2;
  }

  const persisted = persistCeiling({
    projectRoot,
    ceiling: seeded.ceiling,
    artifactOut: args.artifactOut,
    briefOut: args.briefOut,
  });
  if (!persisted.ok) {
    process.stderr.write(`verify_operator_scope_limit: ${persisted.detail}\n`);
    return 2;
  }

  let surfaces: ShippedSurface[] = [];
  let surfacesSource: "surfaces-file" | "default-inventory" = "default-inventory";
  if (typeof args.surfacesFile === "string" && args.surfacesFile.length > 0) {
    const surfacesLoad = loadSurfacesFile(args.surfacesFile);
    if (!surfacesLoad.ok) {
      process.stderr.write(`verify_operator_scope_limit: ${surfacesLoad.detail}\n`);
      return 2;
    }
    surfaces = surfacesLoad.surfaces;
    surfacesSource = "surfaces-file";
  } else {
    surfaces = inventoryDefaultSurfaces(projectRoot);
    surfacesSource = "default-inventory";
  }

  if (surfaces.length === 0) {
    if (!args.quiet) {
      process.stdout.write(
        `operator-scope-limit WARN: surfaces were not checked ` +
          `(source=${surfacesSource}; durable=${persisted.durablePath}; ` +
          `phrase=${JSON.stringify(seeded.ceiling.matchedPhrase)}; ` +
          `requirements=${seeded.ceiling.requirementLines.length}). ` +
          `Remediation: ${SURFACES_NOT_CHECKED_REMEDIATION}\n`,
      );
    }
    // Warn-first: missing inventory does not fail the process.
    return 0;
  }

  const result = evaluateUntraceableSurfaces({
    requirementLines: seeded.ceiling.requirementLines,
    surfaces,
  });

  if (!args.quiet) {
    process.stdout.write(
      `${result.message} (durable=${persisted.durablePath}; source=${surfacesSource})\n`,
    );
    if (result.severity === "warn") {
      process.stdout.write(`Remediation: ${UNTRACEABLE_SURFACE_REMEDIATION}\n`);
    }
  }
  // Warn-first: untraceable surfaces do not fail the process.
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
