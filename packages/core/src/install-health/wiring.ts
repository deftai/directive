/**
 * Cheap structural wiring checks for AC2.1 predicate (5).
 *
 * Wave 2c: probes package-relative managed surfaces. If a file is present, its
 * Directive-owned content must target RUNTIME_PACKAGE_PATH_PREFIX (not
 * `.deft/core/` or bare `deft-hook`). Absent files are not failures — hosts
 * may opt out; presence of mismatched content fails.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskfileIncludes } from "../check/consumer-gate-integrity.js";
import {
  hostHookConfigEntryLines,
  isHostHookOuterCommand,
} from "../init-deposit/host-hook-outer.js";
import {
  KILL_SWITCH_GITHOOK_MARKER,
  KILL_SWITCH_READER_FLAG,
  KILL_SWITCH_READER_VERSION,
} from "../policy/kill-switch-record.js";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_MARKER_ID,
  MANAGED_SECTION_OPEN_PREFIX,
} from "./ownership.js";
import type { FsSeams } from "./readers.js";

export interface WiringCheckResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Paths that were present and inspected. */
  readonly inspected: readonly string[];
  /** Paths that failed the runtime-prefix check. */
  readonly mismatched: readonly string[];
}

/**
 * Relative paths probed when present (Wave 2c inventory).
 * Marker convention remains deft:managed-section for AGENTS.
 */
export const WIRING_PROBE_RELS: readonly string[] = [
  "AGENTS.md",
  ".agents/skills/deft/SKILL.md",
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
  "Taskfile.yml",
  ".githooks/pre-commit",
  ".githooks/pre-push",
  ".githooks/_directive-run.sh",
];

/** Exported so callers/docs can assert the marker id has not drifted. */
export const WIRING_MANAGED_SECTION_MARKER = MANAGED_SECTION_MARKER_ID;

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Extract `<!-- deft:managed-section … -->` … `<!-- /deft:managed-section -->`. */
function extractManagedSection(text: string): string | null {
  const start = text.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) return null;
  const openEnd = text.indexOf("-->", start);
  if (openEnd < 0) return null;
  const end = text.indexOf(MANAGED_SECTION_CLOSE, openEnd);
  if (end < 0) return null;
  return text.slice(start, end + MANAGED_SECTION_CLOSE.length);
}

function targetsRuntime(
  text: string,
  options: { readonly allowDeftHookProse?: boolean } = {},
): boolean {
  const prefix = RUNTIME_PACKAGE_PATH_PREFIX.replace(/\/$/, "");
  if (!text.includes(prefix)) return false;
  if (text.includes(".deft/core/")) return false;
  // Hook JSON / skill pointers must not invoke bare deft-hook. AGENTS managed
  // prose may name it when teaching recovery (agents-entry.md).
  if (!options.allowDeftHookProse && /(^|[\s"`'])deft-hook([\s"`']|$)/.test(text)) {
    return false;
  }
  return true;
}

/** Pre-commit/pre-push only source the helper; runtime path lives in the helper. */
function isGitHookShim(rel: string, text: string): boolean {
  if (rel !== ".githooks/pre-commit" && rel !== ".githooks/pre-push") return false;
  if (text.includes(".deft/core/")) return false;
  if (/(^|[\s"`'])deft-hook([\s"`']|$)/.test(text)) return false;
  return text.includes("_directive-run.sh");
}

/**
 * Indent-scoped `includes.deft` resolve (#5796).
 * Owns only the direct `deft` child and its first-level `taskfile` property;
 * deeper nested keys (e.g. `vars.taskfile`) are ignored. Also covers go-task
 * short scalar and inline flow-map forms the shared parser skips.
 */
function resolveIncludesDeftTaskfileIndentScoped(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inIncludes = false;
  let includesIndent = 0;
  /** Indent of direct children under `includes:` (go-task allows 2- or 4-space). */
  let directChildIndent: number | null = null;
  let inDeftBody = false;
  let deftBodyIndent: number | null = null;
  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (!inIncludes) {
      if (/^includes\s*:/.test(stripped) && indent === 0) {
        inIncludes = true;
        includesIndent = indent;
        directChildIndent = null;
        inDeftBody = false;
        deftBodyIndent = null;
      }
      continue;
    }
    if (indent <= includesIndent) {
      inIncludes = false;
      directChildIndent = null;
      inDeftBody = false;
      deftBodyIndent = null;
      if (/^includes\s*:/.test(stripped) && indent === 0) {
        inIncludes = true;
        includesIndent = indent;
      }
      continue;
    }
    if (directChildIndent === null) {
      directChildIndent = indent;
    }
    if (indent === directChildIndent) {
      inDeftBody = false;
      deftBodyIndent = null;
      // Exact lowercase deft / "deft" / 'deft' only (#5796 Greptile): /i would
      // match DEFT first and mask a later exact includes.deft legacy path.
      const entry = stripped.match(/^(?:["']deft["']|deft)\s*:\s*(.*?)(?:\s+#.*)?$/);
      if (entry === null) continue;
      const value = (entry[1] ?? "").trim();
      if (value.startsWith("{")) {
        const flow = value.match(/taskfile\s*:\s*["']?([^"',}\s]+)/i);
        return flow?.[1]?.trim() ?? null;
      }
      if (value.length === 0) {
        inDeftBody = true;
        continue;
      }
      return value.replace(/^["']|["']$/g, "");
    }
    if (inDeftBody && indent > directChildIndent) {
      if (deftBodyIndent === null) deftBodyIndent = indent;
      if (indent !== deftBodyIndent) continue;
      const taskfile = stripped.match(/^taskfile\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/i);
      if (taskfile?.[1]) return taskfile[1].trim();
    }
  }
  return null;
}

/**
 * Resolve `includes.deft` taskfile path for wiring (#5796).
 * Prefer indent-scoped ownership of `includes.deft` so nested `vars.taskfile`
 * cannot mask a legacy include. Shared parser is last resort only.
 */
function resolveIncludesDeftTaskfile(text: string): string | null {
  const fromIndent = resolveIncludesDeftTaskfileIndentScoped(text);
  if (fromIndent !== null) return fromIndent;
  const fromParser = parseTaskfileIncludes(text).get("deft");
  if (fromParser !== undefined) return fromParser.taskfile;
  return null;
}

/**
 * Taskfile wiring owns only `includes.deft` (#5796). Comment-aware include parse
 * (skips `#` lines); whole-file `.deft/core/` substring must not decide the probe.
 */
function inspectTaskfileIncludesDeft(text: string): boolean {
  const taskfileRaw = resolveIncludesDeftTaskfile(text);
  if (taskfileRaw === null) return false;
  const taskfile = taskfileRaw.replace(/\\/g, "/");
  const prefix = RUNTIME_PACKAGE_PATH_PREFIX.replace(/\/$/, "");
  if (taskfile.includes(".deft/core/")) return false;
  return taskfile.includes(prefix);
}

const HOST_HOOK_REGISTRATION_RELS: ReadonlySet<string> = new Set([
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
]);

/** #5994 / F2: host registration success form is content-hashed `.mjs` outer only. */
function isHostHookOuterRegistration(text: string): boolean {
  if (text.includes(".deft/core/")) return false;
  if (/(^|[\s"`'])deft-hook([\s"`']|$)/.test(text)) return false;
  // Direct pin hook-bin as the registered host command is legacy.
  if (text.includes("node_modules/@deftai/directive-runtime/dist/hook-bin.js")) {
    return false;
  }
  return isHostHookOuterCommand(text);
}

function inspectProbe(rel: string, text: string): boolean {
  if (rel === "AGENTS.md") {
    const section = extractManagedSection(text);
    if (section === null) {
      // File present without a managed section — not Directive wiring yet.
      return true;
    }
    return targetsRuntime(section, { allowDeftHookProse: true });
  }
  if (rel === "Taskfile.yml") {
    return inspectTaskfileIncludesDeft(text);
  }
  if (isGitHookShim(rel, text)) return true;
  if (HOST_HOOK_REGISTRATION_RELS.has(rel)) {
    return isHostHookOuterRegistration(hostHookConfigEntryLines(text));
  }
  return targetsRuntime(text);
}

/**
 * True when at least one probe shows Directive-owned wiring (AC14.20 vs AC14.50).
 * AGENTS.md counts only with a managed section targeting the runtime prefix;
 * other probes count when they target the runtime prefix or are git-hook shims.
 */
export function hasDirectiveWiringEvidence(projectRoot: string, seams: FsSeams = {}): boolean {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  for (const rel of WIRING_PROBE_RELS) {
    const path = join(projectRoot, rel);
    if (!isFile(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    if (rel === "AGENTS.md") {
      const section = extractManagedSection(text);
      if (section !== null && targetsRuntime(section)) return true;
      continue;
    }
    if (rel === "Taskfile.yml") {
      if (inspectTaskfileIncludesDeft(text)) return true;
      continue;
    }
    if (isGitHookShim(rel, text)) return true;
    if (HOST_HOOK_REGISTRATION_RELS.has(rel)) {
      if (isHostHookOuterRegistration(hostHookConfigEntryLines(text))) return true;
      continue;
    }
    if (targetsRuntime(text)) return true;
  }
  return false;
}

/**
 * Structural wiring check against the Wave 2c probe inventory.
 * Missing probes do not fail, except a missing pre-commit or pre-push next to
 * Directive's hook helper. Present mismatched probes fail.
 */
export function checkWiringTargetsRuntime(
  projectRoot: string,
  seams: FsSeams = {},
): WiringCheckResult {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  const inspected: string[] = [];
  const mismatched: string[] = [];

  // With Directive's hook helper present, a missing pre-commit or pre-push
  // means a gate is off, so it counts as a mismatch (#5976).
  const helperPresent = isFile(join(projectRoot, ".githooks/_directive-run.sh"));
  for (const rel of WIRING_PROBE_RELS) {
    const path = join(projectRoot, rel);
    if (!isFile(path)) {
      if (helperPresent && (rel === ".githooks/pre-commit" || rel === ".githooks/pre-push")) {
        mismatched.push(rel);
      }
      continue;
    }
    inspected.push(rel);
    const text = readText(path);
    if (text === null) {
      mismatched.push(rel);
      continue;
    }
    if (!inspectProbe(rel, text)) {
      mismatched.push(rel);
    }
  }

  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: `wiring does not target ${RUNTIME_PACKAGE_PATH_PREFIX}: ${mismatched.join(", ")}`,
      inspected,
      mismatched,
    };
  }

  return {
    ok: true,
    reason: null,
    inspected,
    mismatched: [],
  };
}

/** One doctor finding about an old kill-switch reader (#6740). */
export interface KillSwitchReaderFinding {
  /** Repo-relative file the finding is about. */
  readonly rel: string;
  readonly message: string;
}

export interface KillSwitchReaderSeams extends FsSeams {
  /** `git rev-parse --show-toplevel` for the project, or null. */
  readonly showToplevel?: (projectRoot: string) => string | null;
}

/** Redeposit remedy named by every reader finding (#6740). */
export const KILL_SWITCH_READER_REDEPOSIT =
  "Run `directive upgrade` (or `directive install --repair`) to redeposit it.";

const OUTER_REL_PATTERN =
  /(?:^|[\s"'`])((?:\.claude|\.cursor\/hooks|\.codex|\.grok\/hooks)\/deft-hook-[a-f0-9]{8}\.mjs)(?=[\s"'`]|$)/g;

function defaultShowToplevel(projectRoot: string): string | null {
  try {
    const out = execFileSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.replace(/\n+$/, "");
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Old kill-switch readers still wired into this checkout (#6740). Compatibility
 * information only, never authority:
 *
 * - a host-hook call without the reader flag: a registered outer `.mjs` whose
 *   text does not pass `--kill-switch-reader v1` to the runtime, or a registered
 *   Directive hook entry that calls the runtime with no outer at all;
 * - the checkout-local git-hook helper (`<show-toplevel>/.githooks/_directive-run.sh`,
 *   the file the entry scripts source) without the marker line.
 *
 * Each finding names the redeposit. Missing files are not findings here.
 */
export function checkKillSwitchReaderMarkers(
  projectRoot: string,
  seams: KillSwitchReaderSeams = {},
): KillSwitchReaderFinding[] {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  const findings: KillSwitchReaderFinding[] = [];
  const seenOuters = new Set<string>();
  for (const rel of HOST_HOOK_REGISTRATION_RELS) {
    const path = join(projectRoot, rel);
    if (!isFile(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    for (const line of hostHookConfigEntryLines(text).split("\n")) {
      const outers = [...line.matchAll(OUTER_REL_PATTERN)].map((m) => m[1] as string);
      if (outers.length === 0) {
        const directRuntimeCall =
          line.includes("node_modules/@deftai/directive-runtime/dist/hook-bin.js") ||
          /(^|[\s"`'])deft-hook([\s"`']|$)/.test(line) ||
          line.includes("hook:dispatch");
        if (directRuntimeCall && !line.includes(KILL_SWITCH_READER_FLAG)) {
          findings.push({
            rel,
            message:
              `${rel}: a Directive host-hook call runs without the kill-switch reader flag ` +
              `(\`${KILL_SWITCH_READER_FLAG} ${KILL_SWITCH_READER_VERSION}\`); an older reader may still honor a bare flag file. ` +
              KILL_SWITCH_READER_REDEPOSIT,
          });
        }
        continue;
      }
      for (const outerRel of outers) {
        if (seenOuters.has(outerRel)) continue;
        seenOuters.add(outerRel);
        const outerPath = join(projectRoot, outerRel);
        if (!isFile(outerPath)) continue;
        const outerText = readText(outerPath);
        if (outerText === null || outerText.includes(KILL_SWITCH_READER_FLAG)) continue;
        findings.push({
          rel: outerRel,
          message:
            `${outerRel} (registered in ${rel}) calls the runtime hook without the kill-switch reader flag ` +
            `(\`${KILL_SWITCH_READER_FLAG} ${KILL_SWITCH_READER_VERSION}\`); this older outer may still honor a bare flag file. ` +
            KILL_SWITCH_READER_REDEPOSIT,
        });
      }
    }
  }
  const toplevel = (seams.showToplevel ?? defaultShowToplevel)(projectRoot) ?? projectRoot;
  const helperRel = ".githooks/_directive-run.sh";
  const helperPath = join(toplevel, helperRel);
  if (isFile(helperPath)) {
    const helperText = readText(helperPath);
    if (helperText !== null && !helperText.split("\n").includes(KILL_SWITCH_GITHOOK_MARKER)) {
      findings.push({
        rel: helperRel,
        message:
          `${helperRel}: this checkout's git-hook helper has no kill-switch reader marker ` +
          `(\`${KILL_SWITCH_GITHOOK_MARKER}\`); an older helper may still honor a bare flag file. ` +
          KILL_SWITCH_READER_REDEPOSIT,
      });
    }
  }
  return findings;
}
