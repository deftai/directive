/**
 * xbrief:create — write a dense xBRIEF artifact at --out (#3057).
 *
 * Required: --format (json|md|both), --out
 * Optional: --style, --title, --id, --status, --description, --force, --project-root
 *
 * Does NOT move lifecycle folders. Not scope:promote / activate / complete.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import { type JsonObject, validateVbriefSchema } from "../vbrief-validate/schema.js";
import { resolveXbriefOutPaths, XbriefPathError } from "./paths.js";
import { buildStyleDocument, renderMarkdown } from "./styles.js";
import {
  DEFAULT_XBRIEF_SIZE_CAP_BYTES,
  isXbriefFormat,
  isXbriefStyle,
  type XbriefCliResult,
  type XbriefDocument,
  type XbriefFormat,
  type XbriefStyle,
} from "./types.js";

export const CREATE_USAGE =
  "Usage: deft xbrief:create -- --format <json|md|both> --out <path> [--style <scope|playbook|mission|project>] [--title <t>] [--id <id>] [--status <s>] [--description <d>] [--from-json <path>] [--force] [--project-root <dir>]\n" +
  "  Write a dense xBRIEF artifact at --out. Required: --format and --out.\n" +
  "  create ≠ lifecycle: does not promote/activate/complete (use scope:* for lifecycle).\n";

export interface CreateOptions {
  format: XbriefFormat;
  out: string;
  style: XbriefStyle;
  title?: string;
  id?: string;
  status?: string;
  description?: string;
  fromJson?: string;
  force?: boolean;
  projectRoot: string;
  sizeCapBytes?: number;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

function fail(stderr: string, exitCode = 2): XbriefCliResult {
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

/** Parse create CLI argv into options (or error string). */
export function parseCreateArgv(argv: readonly string[]): CreateOptions | { error: string } {
  let format: string | undefined;
  let out: string | undefined;
  let style = "scope";
  let title: string | undefined;
  let id: string | undefined;
  let status: string | undefined;
  let description: string | undefined;
  let fromJson: string | undefined;
  let force = false;
  let projectRoot = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      return { error: CREATE_USAGE };
    }
    if (arg === "--force") {
      force = true;
      continue;
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
    if (arg === "--title" || arg.startsWith("--title=")) {
      const parsed = parseFlagValue(argv, i, "--title");
      if ("error" in parsed) return parsed;
      title = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--id" || arg.startsWith("--id=")) {
      const parsed = parseFlagValue(argv, i, "--id");
      if ("error" in parsed) return parsed;
      id = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--status" || arg.startsWith("--status=")) {
      const parsed = parseFlagValue(argv, i, "--status");
      if ("error" in parsed) return parsed;
      status = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--description" || arg.startsWith("--description=")) {
      const parsed = parseFlagValue(argv, i, "--description");
      if ("error" in parsed) return parsed;
      description = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--from-json" || arg.startsWith("--from-json=")) {
      const parsed = parseFlagValue(argv, i, "--from-json");
      if ("error" in parsed) return parsed;
      fromJson = parsed.value;
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
    return { error: `unrecognized argument: ${arg}\n${CREATE_USAGE}` };
  }

  if (format === undefined) {
    return { error: `missing required --format (json|md|both)\n${CREATE_USAGE}` };
  }
  if (!isXbriefFormat(format)) {
    return { error: `invalid --format ${format} (expected json|md|both)\n${CREATE_USAGE}` };
  }
  if (out === undefined || out.length === 0) {
    return { error: `missing required --out\n${CREATE_USAGE}` };
  }
  if (!isXbriefStyle(style)) {
    return {
      error: `invalid --style ${style} (expected scope|playbook|mission|project)\n${CREATE_USAGE}`,
    };
  }

  return {
    format,
    out,
    style,
    title,
    id,
    status,
    description,
    fromJson,
    force,
    projectRoot,
  };
}

function loadFromJson(
  path: string,
): { ok: true; doc: XbriefDocument } | { ok: false; error: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, error: `--from-json must be a JSON object: ${path}\n` };
    }
    return { ok: true, doc: data as XbriefDocument };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read --from-json ${path}: ${msg}\n` };
  }
}

function defaultTitle(style: XbriefStyle, outStem: string): string {
  const base = basename(outStem);
  if (base.length > 0) return base;
  return `Untitled ${style}`;
}

/** Core create implementation (testable). */
export function createXbrief(options: CreateOptions): XbriefCliResult {
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

  let doc: XbriefDocument;
  if (options.fromJson !== undefined) {
    const loaded = loadFromJson(options.fromJson);
    if (!loaded.ok) return fail(loaded.error, 1);
    doc = loaded.doc;
  } else {
    const title = options.title ?? defaultTitle(options.style, paths.stemAbs);
    doc = buildStyleDocument({
      style: options.style,
      title,
      id: options.id,
      status: options.status,
      description: options.description,
      now: options.now,
    });
  }

  const schemaErrors = validateVbriefSchema(doc as unknown as JsonObject, paths.stemAbs);
  if (schemaErrors.length > 0) {
    return fail(
      `xbrief:create schema invalid:\n${schemaErrors.map((e) => `  - ${e}`).join("\n")}\n`,
      1,
    );
  }

  const sizeCap = options.sizeCapBytes ?? DEFAULT_XBRIEF_SIZE_CAP_BYTES;
  const jsonText = `${JSON.stringify(doc, null, 2)}\n`;
  const mdText = renderMarkdown(doc, options.style);

  if (Buffer.byteLength(jsonText, "utf8") > sizeCap) {
    return fail(`xbrief:create refused: json payload exceeds size cap (${sizeCap} bytes)\n`, 1);
  }
  if (Buffer.byteLength(mdText, "utf8") > sizeCap) {
    return fail(`xbrief:create refused: md payload exceeds size cap (${sizeCap} bytes)\n`, 1);
  }

  const mode = options.force === true ? "replace" : "create";
  const written: string[] = [];

  try {
    if (paths.jsonAbs !== null) {
      containedWrite({
        root: paths.projectRoot,
        target: paths.jsonAbs,
        data: jsonText,
        mode,
      });
      written.push(paths.jsonAbs);
    }
    if (paths.mdAbs !== null) {
      containedWrite({
        root: paths.projectRoot,
        target: paths.mdAbs,
        data: mdText,
        mode,
      });
      written.push(paths.mdAbs);
    }
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      if (err.code === ContainedWriteErrorCode.EXISTS) {
        return fail(
          `xbrief:create refused: target exists (${err.target}); pass --force to replace\n`,
          1,
        );
      }
      if (err.code === ContainedWriteErrorCode.ESCAPE) {
        return fail(`xbrief:create path refused: ${err.message}\n`, 1);
      }
      return fail(`xbrief:create write failed: ${err.message}\n`, 1);
    }
    throw err;
  }

  const lines = [
    `OK xbrief:create format=${options.format} style=${options.style}`,
    ...written.map((p) => `  wrote ${p}`),
    "  note: create is not a lifecycle move (scope:* handles promote/activate/complete)",
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/** CLI entry for dispatch wrapper. */
export function runXbriefCreateCli(argv: string[]): XbriefCliResult {
  const parsed = parseCreateArgv(argv);
  if ("error" in parsed) {
    const isHelp = parsed.error === CREATE_USAGE;
    return {
      exitCode: isHelp ? 0 : 2,
      stdout: isHelp ? CREATE_USAGE : "",
      stderr: isHelp ? "" : parsed.error,
    };
  }
  return createXbrief(parsed);
}
