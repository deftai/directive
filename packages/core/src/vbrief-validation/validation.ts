import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripEdgeChars, stripTrailingChar } from "./normalize.js";
import type { FinalizeMigrationOptions, JsonObject, ValidateAllFn } from "./types.js";

export const RECOVERY_HINT = "Restore with: task migrate:vbrief -- --rollback";
export const ID_MAX_LENGTH = 80;
export const HASH_SUFFIX_LENGTH = 6;

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function defaultValidateAll(vbriefDir: string): readonly [string[], string[]] {
  const deftRoot = resolveDeftRoot();
  const scriptsDir = join(deftRoot, "scripts");
  const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from vbrief_validate import validate_all
errors, warnings, _ = validate_all(Path(${JSON.stringify(vbriefDir)}))
print(json.dumps([errors, warnings], ensure_ascii=False))
`;
  const result = spawnSync("uv", ["run", "python", "-c", code], {
    cwd: deftRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      typeof result.stderr === "string" && result.stderr.trim()
        ? result.stderr.trim()
        : "validate_all bridge failed",
    );
  }
  const parsed = JSON.parse(String(result.stdout ?? "[[],[]]")) as [string[], string[]];
  return [parsed[0] ?? [], parsed[1] ?? []];
}

let validateAllImpl: ValidateAllFn = defaultValidateAll;

/** Test hook: replace the vbrief_validate bridge. */
export function setValidateAllForTests(fn: ValidateAllFn | null): void {
  validateAllImpl = fn ?? defaultValidateAll;
}

/** Return a slug-safe id for filenames and in-JSON id fields (#498). */
export function slugifyId(raw: string | null | undefined, existing?: Set<string>): string {
  const text = (raw ?? "").trim();
  let slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  slug = stripEdgeChars(slug, "-");
  if (!slug) {
    slug = "untitled";
  }
  if (slug.length > ID_MAX_LENGTH) {
    slug = stripTrailingChar(slug.slice(0, ID_MAX_LENGTH), "-") || slug.slice(0, ID_MAX_LENGTH);
  }
  if (existing === undefined) {
    return slug;
  }
  if (!existing.has(slug)) {
    existing.add(slug);
    return slug;
  }
  const digestSeed = text || slug;
  const baseMax = ID_MAX_LENGTH - 1 - HASH_SUFFIX_LENGTH;
  const base = slug.slice(0, baseMax).replace(/-+$/, "") || slug.slice(0, baseMax) || "id";
  let h = createHash("sha1").update(digestSeed, "utf8").digest("hex").slice(0, HASH_SUFFIX_LENGTH);
  let candidate = `${base}-${h}`;
  let attempt = 0;
  while (existing.has(candidate) && attempt < 1000) {
    attempt += 1;
    h = createHash("sha1")
      .update(`${digestSeed}|${attempt}`, "utf8")
      .digest("hex")
      .slice(0, HASH_SUFFIX_LENGTH);
    candidate = `${base}-${h}`;
  }
  existing.add(candidate);
  return candidate;
}

/** Return the logical identifier source for a scope item dict. */
export function slugFallbackId(item: JsonObject): string {
  const number = String(item.number ?? "").trim();
  if (number) {
    return number;
  }
  const taskId = String(item.task_id ?? "").trim();
  if (taskId) {
    return taskId;
  }
  const synthetic = String(item.synthetic_id ?? "").trim();
  if (synthetic) {
    return synthetic;
  }
  return String(item.title ?? "").trim() || "untitled";
}

/** Validate every file emitted by the migrator under ``vbriefDir``. */
export function validateMigrationOutput(
  vbriefDir: string,
  validateAll: ValidateAllFn = validateAllImpl,
): readonly [string[], string[]] {
  try {
    if (!statSync(vbriefDir).isDirectory()) {
      return [[`${vbriefDir}: expected vbrief directory does not exist`], []];
    }
  } catch {
    return [[`${vbriefDir}: expected vbrief directory does not exist`], []];
  }
  const [errors, warnings] = validateAll(vbriefDir);
  return [[...errors], [...warnings]];
}

/** Move the emitted ``vbrief/`` tree to ``vbrief.invalid/`` on failure. */
export function isolateInvalidOutput(projectRoot: string, vbriefDir: string): string | null {
  if (!existsSync(vbriefDir)) {
    return null;
  }
  let target = join(projectRoot, "vbrief.invalid");
  let idx = 1;
  while (existsSync(target)) {
    idx += 1;
    target = join(projectRoot, `vbrief.invalid.${idx}`);
  }
  renameSync(vbriefDir, target);
  return target;
}

/** Run validation + isolation as the migrator's terminal gate (#498). */
export function finalizeMigration(
  projectRoot: string,
  vbriefDir: string,
  actions: string[],
  options: FinalizeMigrationOptions = {},
): readonly [boolean, string[]] {
  const stderrWriter = options.stderrWriter ?? ((chunk: string) => process.stderr.write(chunk));
  const validateAll = options.validateAll ?? validateAllImpl;
  const isolateFn = options.isolateInvalid ?? isolateInvalidOutput;
  const [errors, warnings] = validateMigrationOutput(vbriefDir, validateAll);
  if (errors.length === 0) {
    for (const w of warnings) {
      stderrWriter(`WARNING: ${w}\n`);
    }
    return [true, actions];
  }
  stderrWriter(
    `ERROR: Migration produced invalid output (${errors.length} file-level error(s)):\n`,
  );
  for (const err of errors) {
    stderrWriter(`  ${err}\n`);
  }
  const invalidDir = isolateFn(projectRoot, vbriefDir);
  const failureActions = [...actions];
  failureActions.push(`FAIL  migration produced ${errors.length} schema validation error(s)`);
  for (const err of errors) {
    failureActions.push(`  ${err}`);
  }
  if (invalidDir !== null) {
    let relInvalid: string;
    try {
      relInvalid = relative(projectRoot, invalidDir).split("\\").join("/");
    } catch {
      relInvalid = invalidDir;
    }
    failureActions.push(`MOVE  vbrief/ -> ${relInvalid}/ (isolated from vbrief/)`);
    stderrWriter(`Isolated partial output to: ${relInvalid}\n`);
  }
  failureActions.push(RECOVERY_HINT);
  stderrWriter(`${RECOVERY_HINT}\n`);
  return [false, failureActions];
}
