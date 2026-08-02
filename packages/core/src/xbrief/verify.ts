/**
 * xbrief:verify — fail-closed check of an xBRIEF artifact at --out (#3057).
 *
 * Required: --format (json|md|both), --out
 * Checks: schema/parse, required fields, size cap, md sections per style,
 * and stem/title/id consistency when format=both.
 *
 * Does NOT move lifecycle folders.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { type JsonObject, validateVbriefSchema } from "../vbrief-validate/schema.js";
import { resolveXbriefOutPaths, XbriefPathError } from "./paths.js";
import { MD_REQUIRED_SECTIONS, parseMarkdownMeta } from "./styles.js";
import {
  DEFAULT_XBRIEF_SIZE_CAP_BYTES,
  isXbriefFormat,
  isXbriefStyle,
  type XbriefCliResult,
  type XbriefDocument,
  type XbriefFormat,
  type XbriefStyle,
} from "./types.js";

export const VERIFY_USAGE =
  "Usage: deft xbrief:verify -- --format <json|md|both> --out <path> [--style <scope|playbook|mission|project>] [--project-root <dir>]\n" +
  "  Verify a dense xBRIEF artifact at --out. Required: --format and --out.\n" +
  "  verify ≠ lifecycle: does not promote/activate/complete (use scope:* for lifecycle).\n";

export interface VerifyOptions {
  format: XbriefFormat;
  out: string;
  style?: XbriefStyle;
  projectRoot: string;
  sizeCapBytes?: number;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function fail(stderr: string, exitCode = 1): XbriefCliResult {
  return { exitCode, stdout: "", stderr };
}

function parseFlagValue(
  argv: readonly string[],
  i: number,
  name: string,
): { value: string; next: number } | { error: string } {
  const eq = argv[i]?.startsWith(`${name}=`) ? argv[i].slice(name.length + 1) : undefined;
  if (eq !== undefined) {
    if (eq.length === 0) return { error: `argument ${name}: expected one argument\n` };
    return { value: eq, next: i };
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("-")) {
    return { error: `argument ${name}: expected one argument\n` };
  }
  return { value: next, next: i + 1 };
}

/** Parse verify CLI argv into options (or error string). */
export function parseVerifyArgv(argv: readonly string[]): VerifyOptions | { error: string } {
  let format: string | undefined;
  let out: string | undefined;
  let style: string | undefined;
  let projectRoot = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      return { error: VERIFY_USAGE };
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const parsed = parseFlagValue(argv, i, "--format");
      if ("error" in parsed) return parsed;
      format = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const parsed = parseFlagValue(argv, i, "--out");
      if ("error" in parsed) return parsed;
      out = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--style" || arg.startsWith("--style=")) {
      const parsed = parseFlagValue(argv, i, "--style");
      if ("error" in parsed) return parsed;
      style = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const parsed = parseFlagValue(argv, i, "--project-root");
      if ("error" in parsed) return parsed;
      projectRoot = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--") continue;
    return { error: `unrecognized argument: ${arg}\n${VERIFY_USAGE}` };
  }

  if (format === undefined) {
    return { error: `missing required --format (json|md|both)\n${VERIFY_USAGE}` };
  }
  if (!isXbriefFormat(format)) {
    return { error: `invalid --format ${format} (expected json|md|both)\n${VERIFY_USAGE}` };
  }
  if (out === undefined || out.length === 0) {
    return { error: `missing required --out\n${VERIFY_USAGE}` };
  }
  if (style !== undefined && !isXbriefStyle(style)) {
    return {
      error: `invalid --style ${style} (expected scope|playbook|mission|project)\n${VERIFY_USAGE}`,
    };
  }

  return {
    format,
    out,
    style: style as XbriefStyle | undefined,
    projectRoot,
  };
}

function readText(path: string, sizeCap: number): string | { error: string } {
  if (!existsSync(path)) {
    return { error: `missing file: ${path}\n` };
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      return { error: `not a file: ${path}\n` };
    }
    if (st.size > sizeCap) {
      return { error: `file exceeds size cap (${sizeCap} bytes): ${path}\n` };
    }
    return readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `failed to read ${path}: ${msg}\n` };
  }
}

function parseJsonDoc(
  text: string,
  label: string,
): { ok: true; doc: XbriefDocument } | { ok: false; error: string } {
  try {
    const data = JSON.parse(text) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, error: `${label}: JSON root must be an object\n` };
    }
    return { ok: true, doc: data as XbriefDocument };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${label}: invalid JSON (${msg})\n` };
  }
}

function resolveStyle(
  explicit: XbriefStyle | undefined,
  doc: XbriefDocument | null,
  mdStyle: string | null,
): XbriefStyle {
  if (explicit !== undefined) return explicit;
  if (doc !== null) {
    const meta = doc.plan.metadata;
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      const kind = (meta as Record<string, unknown>).kind;
      if (typeof kind === "string" && isXbriefStyle(kind)) return kind;
    }
  }
  if (mdStyle !== null && isXbriefStyle(mdStyle)) return mdStyle;
  return "scope";
}

/** Core verify implementation (testable). */
export function verifyXbrief(options: VerifyOptions): XbriefCliResult {
  let paths: ReturnType<typeof resolveXbriefOutPaths>;
  try {
    paths = resolveXbriefOutPaths({
      projectRoot: options.projectRoot,
      out: options.out,
      format: options.format,
      cwd: options.cwd,
      home: options.home,
      env: options.env,
    });
  } catch (err) {
    if (err instanceof XbriefPathError) {
      return fail(`${err.message}\n`, 1);
    }
    throw err;
  }

  const sizeCap = options.sizeCapBytes ?? DEFAULT_XBRIEF_SIZE_CAP_BYTES;
  const errors: string[] = [];

  let doc: XbriefDocument | null = null;
  let mdMeta: ReturnType<typeof parseMarkdownMeta> | null = null;

  if (paths.jsonAbs !== null) {
    const text = readText(paths.jsonAbs, sizeCap);
    if (typeof text !== "string") {
      errors.push(text.error.trimEnd());
    } else {
      const parsed = parseJsonDoc(text, paths.jsonAbs);
      if (!parsed.ok) {
        errors.push(parsed.error.trimEnd());
      } else {
        doc = parsed.doc;
        const schemaErrors = validateVbriefSchema(doc as unknown as JsonObject, paths.jsonAbs);
        for (const e of schemaErrors) errors.push(e);
      }
    }
  }

  if (paths.mdAbs !== null) {
    const text = readText(paths.mdAbs, sizeCap);
    if (typeof text !== "string") {
      errors.push(text.error.trimEnd());
    } else {
      mdMeta = parseMarkdownMeta(text);
      const style = resolveStyle(options.style, doc, mdMeta.style);
      const required = MD_REQUIRED_SECTIONS[style];
      for (const section of required) {
        if (!mdMeta.sections.has(section)) {
          errors.push(
            `${paths.mdAbs}: missing required markdown section '## ${section}' (style=${style})`,
          );
        }
      }
      if (mdMeta.title === null || mdMeta.title.length === 0) {
        errors.push(`${paths.mdAbs}: missing title`);
      }
      if (mdMeta.status === null || mdMeta.status.length === 0) {
        errors.push(`${paths.mdAbs}: missing status`);
      }
    }
  }

  // both: stem/title/id consistency between json + md
  if (options.format === "both" && doc !== null && mdMeta !== null) {
    if (mdMeta.title !== null && mdMeta.title !== doc.plan.title) {
      errors.push(
        `title mismatch: json=${JSON.stringify(doc.plan.title)} md=${JSON.stringify(mdMeta.title)}`,
      );
    }
    if (mdMeta.status !== null && mdMeta.status !== String(doc.plan.status)) {
      errors.push(
        `status mismatch: json=${JSON.stringify(doc.plan.status)} md=${JSON.stringify(mdMeta.status)}`,
      );
    }
    const jsonId = typeof doc.plan.id === "string" ? doc.plan.id : null;
    if (jsonId !== null && mdMeta.id !== null && jsonId !== mdMeta.id) {
      errors.push(`id mismatch: json=${JSON.stringify(jsonId)} md=${JSON.stringify(mdMeta.id)}`);
    }
  }

  if (errors.length > 0) {
    return fail(`xbrief:verify failed:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`, 1);
  }

  const checked = [paths.jsonAbs, paths.mdAbs].filter((p): p is string => p !== null);
  const lines = [
    `OK xbrief:verify format=${options.format}`,
    ...checked.map((p) => `  checked ${p}`),
    "  note: verify is not a lifecycle move (scope:* handles promote/activate/complete)",
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/** CLI entry for dispatch wrapper. */
export function runXbriefVerifyCli(argv: string[]): XbriefCliResult {
  const parsed = parseVerifyArgv(argv);
  if ("error" in parsed) {
    const isHelp = parsed.error === VERIFY_USAGE;
    return {
      exitCode: isHelp ? 0 : 2,
      stdout: isHelp ? VERIFY_USAGE : "",
      stderr: isHelp ? "" : parsed.error,
    };
  }
  return verifyXbrief(parsed);
}
