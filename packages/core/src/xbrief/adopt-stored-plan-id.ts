/**
 * xbrief:adopt-stored-plan-id — copy the stored plan-id binding onto plan.id (#4963).
 *
 * Refuses when that id already occupies another lifecycle artifact.
 * On a both-format pair, sets the markdown frontmatter id to that same id
 * and does not rewrite the rest of that file.
 * Does not mint an id from issue text and does not repair other binding fields.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteText } from "../cache/io.js";
import { withPlanIdIdentityLock } from "../intake/issue-ingest.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { extractPlanId, findParentsByPlanId } from "../scope/parent-lineage.js";
import { resolveXbriefOutPaths, XbriefPathError } from "./paths.js";
import { ADOPT_STORED_PLAN_ID_VERB, readStoredPlanIdBinding } from "./stored-mint-conflict.js";
import { DEFAULT_XBRIEF_SIZE_CAP_BYTES, type XbriefCliResult } from "./types.js";

export const ADOPT_USAGE =
  `Usage: deft ${ADOPT_STORED_PLAN_ID_VERB} -- --out <path> [--project-root <dir>]\n` +
  "  Set plan.id to the stored x-directive/plan-id binding id.\n" +
  "  On a both-format pair, set the markdown frontmatter id to that same id.\n" +
  "  Refuses when that id already occupies another lifecycle artifact.\n" +
  "  Does not mint an id from issue text.\n";

export interface AdoptStoredPlanIdOptions {
  out: string;
  projectRoot: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  sizeCapBytes?: number;
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

/** Parse adopt CLI argv into options (or error string). */
export function parseAdoptArgv(
  argv: readonly string[],
): AdoptStoredPlanIdOptions | { error: string } {
  let out: string | undefined;
  let projectRoot = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      return { error: ADOPT_USAGE };
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const parsed = parseFlagValue(argv, i, "--out");
      if ("error" in parsed) return parsed;
      out = parsed.value;
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
    return { error: `unrecognized argument: ${arg}\n${ADOPT_USAGE}` };
  }

  if (out === undefined || out.length === 0) {
    return { error: `missing required --out\n${ADOPT_USAGE}` };
  }
  return { out, projectRoot };
}

function readJson(
  path: string,
  sizeCap: number,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(path)) {
    return { ok: false, error: `missing file: ${path}\n` };
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: `not a file: ${path}\n` };
    if (st.size > sizeCap) {
      return { ok: false, error: `file exceeds size cap (${sizeCap} bytes): ${path}\n` };
    }
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, error: `${path}: JSON root must be an object\n` };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read ${path}: ${msg}\n` };
  }
}

function readCappedText(
  path: string,
  sizeCap: number,
): { ok: true; text: string } | { ok: false; error: string } {
  if (!existsSync(path)) {
    return { ok: false, error: `missing file: ${path}\n` };
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: `not a file: ${path}\n` };
    if (st.size > sizeCap) {
      return { ok: false, error: `file exceeds size cap (${sizeCap} bytes): ${path}\n` };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read ${path}: ${msg}\n` };
  }
}

function frontmatterClose(lines: readonly string[]): number | null {
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") return i;
  }
  return null;
}

/** Replace frontmatter id lines only. The markdown body stays byte-stable aside from those lines. */
function rewriteFrontmatterPlanId(
  markdown: string,
  storedId: string,
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const close = frontmatterClose(lines);
  if (close === null) {
    return { ok: false, error: "paired markdown frontmatter is missing or unclosed.\n" };
  }
  const nextLine = `id: ${storedId}`;
  let found = false;
  let changed = false;
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("id:")) {
      found = true;
      if (line !== nextLine) {
        lines[i] = nextLine;
        changed = true;
      }
    }
  }
  if (!found) {
    lines.splice(close, 0, nextLine);
    changed = true;
  }
  if (!changed) return { ok: true, text: markdown, changed: false };
  return { ok: true, text: lines.join(newline), changed: true };
}

function applyAdopt(
  options: AdoptStoredPlanIdOptions,
  lifecycleRoot: string,
  jsonAbs: string,
  mdAbs: string,
): XbriefCliResult {
  const sizeCap = options.sizeCapBytes ?? DEFAULT_XBRIEF_SIZE_CAP_BYTES;
  const loaded = readJson(jsonAbs, sizeCap);
  if (!loaded.ok) return fail(loaded.error);
  const plan = loaded.data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return fail(`Refusing to set plan.id: ${jsonAbs} has no plan object.\n`);
  }
  const parsed = readStoredPlanIdBinding(plan as Record<string, unknown>);
  if (parsed.kind === "absent") {
    return fail("Refusing to set plan.id: no stored x-directive/plan-id binding id to copy.\n");
  }
  if (parsed.kind === "malformed") {
    return fail(`Refusing to set plan.id: ${parsed.detail}\n`);
  }
  const storedId = parsed.binding.id;
  const occupants = findParentsByPlanId(lifecycleRoot, storedId).filter(
    (row) => resolve(row.path) !== resolve(jsonAbs),
  );
  if (occupants.length > 0) {
    const occupying = occupants.map((row) => row.path).join(", ");
    return fail(`Refusing to set plan.id to ${storedId}: that id already occupies ${occupying}.\n`);
  }
  let markdownWrite: { text: string; previous: string } | null = null;
  if (existsSync(mdAbs)) {
    const loadedMd = readCappedText(mdAbs, sizeCap);
    if (!loadedMd.ok) return fail(`Refusing to set plan.id: ${loadedMd.error}`);
    const rewritten = rewriteFrontmatterPlanId(loadedMd.text, storedId);
    if (!rewritten.ok) {
      return fail(`Refusing to set plan.id: ${mdAbs}: ${rewritten.error}`);
    }
    if (rewritten.changed) {
      markdownWrite = { text: rewritten.text, previous: loadedMd.text };
    }
  }
  const jsonAlready = extractPlanId(loaded.data) === storedId;
  if (jsonAlready && markdownWrite === null) {
    return { exitCode: 0, stdout: `plan.id already ${storedId}\n`, stderr: "" };
  }
  if (markdownWrite !== null) {
    try {
      atomicWriteText(mdAbs, markdownWrite.text, { projectRoot: options.projectRoot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`failed to write ${mdAbs}: ${msg}\n`);
    }
  }
  if (!jsonAlready) {
    (plan as Record<string, unknown>).id = storedId;
    try {
      atomicWriteText(jsonAbs, `${JSON.stringify(loaded.data, null, 2)}\n`, {
        projectRoot: options.projectRoot,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (markdownWrite !== null) {
        try {
          atomicWriteText(mdAbs, markdownWrite.previous, {
            projectRoot: options.projectRoot,
          });
        } catch (restoreErr) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          return fail(
            `failed to write ${jsonAbs}: ${msg}\nfailed to restore ${mdAbs}: ${restoreMsg}\n`,
          );
        }
      }
      return fail(`failed to write ${jsonAbs}: ${msg}\n`);
    }
  }
  return { exitCode: 0, stdout: `Set plan.id to ${storedId}\n`, stderr: "" };
}

/** Copy the stored binding id onto plan.id, or refuse a collision. */
export function adoptStoredPlanId(options: AdoptStoredPlanIdOptions): XbriefCliResult {
  let jsonAbs: string | null;
  let mdAbs: string | null;
  try {
    const paths = resolveXbriefOutPaths({
      projectRoot: options.projectRoot,
      out: options.out,
      format: "both",
      cwd: options.cwd,
      home: options.home,
      env: options.env,
    });
    jsonAbs = paths.jsonAbs;
    mdAbs = paths.mdAbs;
  } catch (err) {
    if (err instanceof XbriefPathError) return fail(`${err.message}\n`);
    throw err;
  }
  if (jsonAbs === null || mdAbs === null) {
    return fail("missing json artifact path\n");
  }
  const artifactPath = jsonAbs;
  const markdownPath = mdAbs;
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(options.projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Refusing to set plan.id: ${msg}\n`);
  }
  try {
    return withPlanIdIdentityLock(lifecycleRoot, () =>
      applyAdopt(options, lifecycleRoot, artifactPath, markdownPath),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Refusing to set plan.id: ${msg}\n`);
  }
}

/** CLI entry for the dispatch wrapper. */
export function runAdoptStoredPlanIdCli(argv: string[]): XbriefCliResult {
  const parsed = parseAdoptArgv(argv);
  if ("error" in parsed) {
    const isHelp = parsed.error === ADOPT_USAGE;
    return {
      exitCode: isHelp ? 0 : 2,
      stdout: isHelp ? ADOPT_USAGE : "",
      stderr: isHelp ? "" : parsed.error,
    };
  }
  return adoptStoredPlanId(parsed);
}
