/**
 * Consumer check-graph integrity (#3070).
 *
 * CONSUMER_CHECK_GATES lists Taskfile tasks that must resolve in a vendored
 * deposit. When optional Taskfile includes silently omit `tasks/verify.yml`
 * (etc.), go-task fails with opaque exit 200/201 ("Task does not exist").
 *
 * This module:
 *  1. Maps each gate to its include namespace / root Taskfile surface
 *  2. Proves shipped files define those tasks (static + runtime)
 *  3. Emits a deposit-repair recovery message instead of opaque go-task errors
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CheckGateSpec, CONSUMER_CHECK_GATES, checkGateId } from "./gate-lists.js";

/** Include namespaces required by the consumer check graph (Taskfile includes). */
export const CHECK_GRAPH_REQUIRED_NAMESPACES = ["verify", "toolchain", "vbrief"] as const;

export type CheckGraphNamespace = (typeof CHECK_GRAPH_REQUIRED_NAMESPACES)[number];

export const CONSUMER_GATE_INTEGRITY_RECOVERY =
  "Incomplete Deft deposit: check-graph Taskfile include(s) missing or incomplete. " +
  "Run `deft update` (or `npm i -g @deftai/directive@latest` then `deft update`) " +
  "to restore `.deft/core/tasks/` (including `tasks/verify.yml` for `verify:orphan-active`). " +
  "See UPGRADING.md.";

export interface ConsumerGateIntegrityFinding {
  readonly gateId: string;
  readonly kind: "missing-include-file" | "missing-task-definition" | "missing-root-taskfile";
  readonly detail: string;
  readonly expectedPath?: string;
}

export interface ConsumerGateIntegrityResult {
  readonly ok: boolean;
  readonly findings: readonly ConsumerGateIntegrityFinding[];
  readonly recovery: string;
}

export interface ConsumerGateIntegritySeams {
  readonly exists?: (path: string) => boolean;
  readonly readText?: (path: string) => string | null;
  /** Override gate list under test (defaults to CONSUMER_CHECK_GATES). */
  readonly gates?: readonly CheckGateSpec[];
}

/** Namespace for a namespaced task (`verify:orphan-active` → `verify`); null for root tasks. */
export function gateNamespace(gateId: string): string | null {
  const colon = gateId.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  return gateId.slice(0, colon);
}

/** Local task name inside an include (`verify:orphan-active` → `orphan-active`). */
export function gateLocalName(gateId: string): string {
  const colon = gateId.indexOf(":");
  if (colon <= 0) {
    return gateId;
  }
  return gateId.slice(colon + 1);
}

/** Relative path of the include Taskfile for a namespace. */
export function includeTaskfileRel(namespace: string): string {
  return `tasks/${namespace}.yml`;
}

/**
 * Namespaces that CONSUMER_CHECK_GATES require via `ns:task` form.
 * Root-only gates (doctor, verify-strategy-output) do not add a namespace.
 */
export function requiredNamespacesForGates(
  gates: readonly CheckGateSpec[] = CONSUMER_CHECK_GATES,
): readonly string[] {
  const seen = new Set<string>();
  for (const spec of gates) {
    const ns = gateNamespace(checkGateId(spec));
    if (ns !== null) {
      seen.add(ns);
    }
  }
  return [...seen].sort();
}

/** True when `localName` is a top-level task key under a Taskfile `tasks:` section. */
export function taskDefinedInTaskfileYaml(text: string, localName: string): boolean {
  // go-task task keys are indented two spaces under `tasks:`.
  // Match `  orphan-active:` / `  check-consumer:` etc., not nested keys.
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^ {2}${escaped}\\s*:`, "m");
  return re.test(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

/**
 * Parse root Taskfile `includes:` entries: map namespace → { taskfile, optional }.
 * Minimal line parser (avoids a YAML dependency); sufficient for go-task include shape.
 */
export function parseTaskfileIncludes(
  text: string,
): ReadonlyMap<string, { readonly taskfile: string; readonly optional: boolean }> {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const result = new Map<string, { taskfile: string; optional: boolean }>();
  let inIncludes = false;
  let includesIndent = 0;
  let currentNs: string | null = null;
  let currentTaskfile: string | null = null;
  let currentOptional = true; // go-task default when omitted is false, but our deposit historically used true

  const flush = () => {
    if (currentNs !== null && currentTaskfile !== null) {
      result.set(currentNs, { taskfile: currentTaskfile, optional: currentOptional });
    }
    currentNs = null;
    currentTaskfile = null;
    currentOptional = false;
  };

  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;

    if (!inIncludes) {
      if (/^includes\s*:/.test(stripped) && indent === 0) {
        inIncludes = true;
        includesIndent = indent;
      }
      continue;
    }

    if (indent <= includesIndent && !stripped.startsWith("#")) {
      flush();
      inIncludes = false;
      // fall through if a new top-level key; re-check next iteration naturally
      if (/^includes\s*:/.test(stripped)) {
        inIncludes = true;
        includesIndent = indent;
      }
      continue;
    }

    // Namespace key at includes+2 (typically 2 spaces): `  verify:`
    if (indent === includesIndent + 2 && /^[A-Za-z_][\w-]*\s*:/.test(stripped)) {
      flush();
      currentNs = stripped.replace(/:\s*(?:#.*)?$/, "").trim();
      currentTaskfile = null;
      currentOptional = false;
      continue;
    }

    if (currentNs === null) {
      continue;
    }

    // Properties at includes+4: taskfile / optional
    if (indent >= includesIndent + 4) {
      const taskfileMatch = stripped.match(/^taskfile\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/i);
      if (taskfileMatch?.[1]) {
        currentTaskfile = taskfileMatch[1].trim();
        continue;
      }
      const optionalMatch = stripped.match(/^optional\s*:\s*(true|false)\s*(?:#.*)?$/i);
      if (optionalMatch?.[1]) {
        currentOptional = optionalMatch[1].toLowerCase() === "true";
      }
    }
  }
  flush();
  return result;
}

/**
 * Assert every consumer check gate resolves against `frameworkRoot` Taskfile + includes.
 * When the root Taskfile is absent, returns ok with no findings (caller/spawn handles that).
 */
export function evaluateConsumerGateIntegrity(
  frameworkRoot: string,
  seams: ConsumerGateIntegritySeams = {},
): ConsumerGateIntegrityResult {
  const root = resolve(frameworkRoot);
  const exists = seams.exists ?? ((p: string) => existsSync(p));
  const readText =
    seams.readText ??
    ((p: string): string | null => {
      try {
        if (!existsSync(p)) {
          return null;
        }
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const gates = seams.gates ?? CONSUMER_CHECK_GATES;
  const findings: ConsumerGateIntegrityFinding[] = [];

  const rootTaskfile = join(root, "Taskfile.yml");
  if (!exists(rootTaskfile)) {
    // Incomplete / non-deposit path: do not invent a Taskfile; let spawn fail as before.
    return { ok: true, findings: [], recovery: CONSUMER_GATE_INTEGRITY_RECOVERY };
  }

  const rootText = readText(rootTaskfile);
  if (rootText === null) {
    findings.push({
      gateId: "*",
      kind: "missing-root-taskfile",
      detail: `Taskfile.yml unreadable at ${rootTaskfile}`,
      expectedPath: rootTaskfile,
    });
    return { ok: false, findings, recovery: CONSUMER_GATE_INTEGRITY_RECOVERY };
  }

  const includes = parseTaskfileIncludes(rootText);
  const yamlCache = new Map<string, string | null>();
  const readCached = (abs: string): string | null => {
    if (yamlCache.has(abs)) {
      return yamlCache.get(abs) ?? null;
    }
    const t = readText(abs);
    yamlCache.set(abs, t);
    return t;
  };
  yamlCache.set(rootTaskfile, rootText);

  for (const spec of gates) {
    const gateId = checkGateId(spec);
    const ns = gateNamespace(gateId);
    const local = gateLocalName(gateId);

    if (ns === null) {
      // Root Taskfile task (doctor, verify-strategy-output, …)
      if (!taskDefinedInTaskfileYaml(rootText, local)) {
        findings.push({
          gateId,
          kind: "missing-task-definition",
          detail: `Root task "${local}" not defined in Taskfile.yml (required by consumer check gate "${gateId}")`,
          expectedPath: rootTaskfile,
        });
      }
      continue;
    }

    const rel = includeTaskfileRel(ns);
    const includeMeta = includes.get(ns);
    const relFromInclude = includeMeta?.taskfile ? includeMeta.taskfile.replace(/^\.\//, "") : rel;
    const includeAbs = join(root, relFromInclude);

    if (!exists(includeAbs)) {
      findings.push({
        gateId,
        kind: "missing-include-file",
        detail:
          `Missing Taskfile include file for namespace "${ns}" (gate "${gateId}"): ` +
          `${relFromInclude}. Optional silent omit of this include causes go-task ` +
          `"Task \\"${gateId}\\" does not exist" (exit 200/201).`,
        expectedPath: includeAbs,
      });
      continue;
    }

    const includeText = readCached(includeAbs);
    if (includeText === null) {
      findings.push({
        gateId,
        kind: "missing-include-file",
        detail: `Unreadable Taskfile include for namespace "${ns}": ${relFromInclude}`,
        expectedPath: includeAbs,
      });
      continue;
    }

    if (!taskDefinedInTaskfileYaml(includeText, local)) {
      findings.push({
        gateId,
        kind: "missing-task-definition",
        detail: `Task "${local}" not defined in ${relFromInclude} (required by consumer check gate "${gateId}")`,
        expectedPath: includeAbs,
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    recovery: CONSUMER_GATE_INTEGRITY_RECOVERY,
  };
}

/** Format integrity failure for stderr (check orchestrator / doctor). */
export function formatConsumerGateIntegrityFailure(result: ConsumerGateIntegrityResult): string {
  const lines = [
    "check: consumer gate integrity failed (#3070)",
    ...result.findings.map((f) => `  - ${f.gateId}: ${f.detail}`),
    `  recovery: ${result.recovery}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Namespaces that must not be `optional: true` on the root Taskfile when the
 * check graph depends on them — silent omit is the #3070 failure mode.
 */
export function checkGraphOptionalIncludeViolations(
  rootTaskfileText: string,
  namespaces: readonly string[] = requiredNamespacesForGates(),
): readonly string[] {
  const includes = parseTaskfileIncludes(rootTaskfileText);
  const bad: string[] = [];
  for (const ns of namespaces) {
    const meta = includes.get(ns);
    if (meta === undefined) {
      bad.push(`${ns} (include entry missing)`);
      continue;
    }
    if (meta.optional) {
      bad.push(`${ns} (optional: true — check-graph includes must fail loud when file is missing)`);
    }
  }
  return bad;
}
