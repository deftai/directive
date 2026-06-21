/**
 * architecture/sor-preflight.ts -- System-of-record architecture preflight gate.
 *
 * Faithful TypeScript port of scripts/preflight_architecture_sor.py and
 * scripts/_sor_gate_diff.py. Answers one question:
 *   "Is this the correct system of record for this kind of state?"
 *
 * Two modes:
 * - Story/spec mode: validates the story's architecture.systemOfRecord design record.
 * - Diff mode: scans changed runtime code for risky persistence signals and requires
 *   a matching design record.
 *
 * Exit codes: 0 pass / 1 architecture violation / 2 gate misconfigured
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Classification constants
// ---------------------------------------------------------------------------

export const STATE_CLASSIFICATIONS = new Set([
  "durable_product_state",
  "auth_session_state",
  "authorization_state",
  "audit_event_state",
  "external_integration_state",
  "canonical_artifact",
  "cache",
  "projection",
  "import_export_artifact",
  "dev_only_fixture",
  "ephemeral_ui_state",
]);

export const DURABLE_CLASSIFICATIONS = new Set([
  "durable_product_state",
  "auth_session_state",
  "authorization_state",
  "audit_event_state",
  "external_integration_state",
]);

export const SECURITY_CLASSIFICATIONS = new Set(["auth_session_state", "authorization_state"]);

export const LOCAL_STORAGE_CLASSES = new Set([
  "json_file",
  "yaml_file",
  "toml_file",
  "sqlite_file",
  "browser_storage",
  "in_memory",
  "local_config",
  "filesystem",
]);

export const FILE_STORAGE_CLASSES = new Set(["json_file", "yaml_file", "toml_file", "filesystem"]);

export const DB_STORAGE_ALIASES = new Set([
  "application_database",
  "database",
  "db",
  "postgres",
  "postgresql",
  "mysql",
  "mariadb",
  "sqlite",
  "sqlite_file",
  "sql",
  "dynamodb",
  "firestore",
  "cosmosdb",
]);

export const EXTERNAL_STORAGE_ALIASES = new Set([
  "external_service",
  "service",
  "provider",
  "external_provider",
  "third_party_provider",
  "api_provider",
]);

const STORAGE_ALIASES: Record<string, Set<string>> = {
  json_file: new Set(["json", "json_file", "local_json", "mutable_json"]),
  yaml_file: new Set(["yaml", "yml", "yaml_file", "local_yaml", "mutable_yaml"]),
  toml_file: new Set(["toml", "toml_file", "local_toml", "mutable_toml"]),
  sqlite_file: new Set(["sqlite", "sqlite_file", "sqlite_db", "db_file", "local_db"]),
  browser_storage: new Set([
    "browser_storage",
    "local_storage",
    "session_storage",
    "indexeddb",
    "indexed_db",
  ]),
  in_memory: new Set(["in_memory", "memory", "process_memory", "process_local"]),
  filesystem: new Set(["filesystem", "file", "files", "local_file", "local_files"]),
  database: DB_STORAGE_ALIASES,
  external_service: EXTERNAL_STORAGE_ALIASES,
};

export const DURABLE_REQUIRED_FIELDS = [
  "owner",
  "approvedStorage",
  "permissionBoundary",
  "migrationRequired",
  "auditRequired",
  "concurrencyRequired",
  "concurrencySemantics",
  "transactionBoundary",
  "recoverySemantics",
  "conflictDetection",
  "deleteSemantics",
  "migrationPath",
];

export const LOW_RISK_PATH_PREFIXES: readonly string[] = [
  ".github/",
  "docs/",
  "history/",
  "meta/",
  "references/",
  "templates/",
  "tests/",
  "vbrief/",
];

export const LOW_RISK_SUFFIXES = new Set([".md", ".rst", ".txt"]);

export const SCANNER_EXEMPT_PATHS = new Set([
  "scripts/preflight_architecture_sor.py",
  "scripts/_sor_gate_diff.py",
]);

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface GateFinding {
  reason: string;
  requiredFix: string;
  stateSurface?: string;
  classification?: string;
  detectedStorage?: string;
  approvedStorage?: string;
}

export interface GateResult {
  code: number;
  message: string;
  findings: readonly GateFinding[];
}

export interface DetectedSignal {
  kind: string;
  path: string;
  line: number | null;
  detail: string;
  storage?: string;
}

type JsonObj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function norm(value: unknown): string {
  let text = String(value ?? "")
    .trim()
    .toLowerCase();
  text = text.replace(/[\s./:-]+/g, "_");
  text = text.replace(/_+/g, "_");
  return text.replace(/^_+|_+$/g, "");
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string") as string[];
  return [];
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return Object.keys(value).length > 0 || (Array.isArray(value) && value.length > 0);
  }
  if (typeof value === "boolean") return true;
  return value !== null && value !== undefined;
}

function truthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "guarded", "excluded"].includes(value.trim().toLowerCase());
  }
  return false;
}

function _containsAny(text: string, tokens: Set<string>): boolean {
  const normalised = norm(text);
  for (const token of tokens) {
    if (normalised.includes(token)) return true;
  }
  return false;
}

export function storageMatches(storage: string, declared: unknown): boolean {
  const wanted = norm(storage);
  const aliases = new Set<string>([wanted]);
  const baseAliases = STORAGE_ALIASES[wanted];
  if (baseAliases) for (const a of baseAliases) aliases.add(a);
  if (DB_STORAGE_ALIASES.has(wanted)) for (const a of DB_STORAGE_ALIASES) aliases.add(a);
  if (EXTERNAL_STORAGE_ALIASES.has(wanted))
    for (const a of EXTERNAL_STORAGE_ALIASES) aliases.add(a);

  const longAliases = new Set([...aliases].filter((a) => a.length > 6));

  for (const item of asStringList(declared)) {
    const token = norm(item);
    if (aliases.has(token)) return true;
    if (token.length > 6 && [...longAliases].some((alias) => token.includes(alias))) return true;
  }
  return false;
}

function approvedStorageText(surface: JsonObj): string {
  const values = asStringList(surface.approvedStorage);
  return values.length > 0 ? values.join(", ") : "<missing>";
}

function storageIsLocalUnsafe(value: unknown): boolean {
  for (const item of asStringList(value)) {
    const token = norm(item);
    if (LOCAL_STORAGE_CLASSES.has(token)) return true;
    if ([...LOCAL_STORAGE_CLASSES].some((alias) => token.includes(alias))) return true;
  }
  return false;
}

function _approvedDatabase(value: unknown): boolean {
  return asStringList(value).some((item) => storageMatches("database", item));
}

function _approvedExternal(value: unknown): boolean {
  return asStringList(value).some((item) => storageMatches("external_service", item));
}

// ---------------------------------------------------------------------------
// JSON loading
// ---------------------------------------------------------------------------

function loadJsonFile(path: string): [JsonObj | null, GateResult | null] {
  if (!existsSync(path)) {
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: story path not found: ${path}`,
        findings: [],
      },
    ];
  }
  if (!statSync(path).isFile()) {
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: story path is not a file: ${path}`,
        findings: [],
      },
    ];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: could not read ${path}: ${String(err)}`,
        findings: [],
      },
    ];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err: unknown) {
    const e = err as { message?: string; lineNumber?: number };
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: ${path} is not valid JSON: ${e.message ?? String(err)}`,
        findings: [],
      },
    ];
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: ${path} top-level value is not an object`,
        findings: [],
      },
    ];
  }
  return [payload as JsonObj, null];
}

// ---------------------------------------------------------------------------
// Record extraction
// ---------------------------------------------------------------------------

export function systemOfRecord(payload: JsonObj): JsonObj | null {
  const architecture = payload.architecture;
  if (typeof architecture === "object" && architecture !== null && !Array.isArray(architecture)) {
    const sor = (architecture as JsonObj).systemOfRecord;
    if (typeof sor === "object" && sor !== null && !Array.isArray(sor)) return sor as JsonObj;
  }
  const plan = payload.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const planArch = (plan as JsonObj).architecture;
    if (typeof planArch === "object" && planArch !== null && !Array.isArray(planArch)) {
      const sor = (planArch as JsonObj).systemOfRecord;
      if (typeof sor === "object" && sor !== null && !Array.isArray(sor)) return sor as JsonObj;
    }
  }
  return null;
}

function storyMentionsReferenceApp(payload: JsonObj): boolean {
  const text = JSON.stringify(payload).toLowerCase();
  return /reference[- ]app|reference application|modeled after|modelled after|parity/.test(text);
}

function recordSurfaces(record: JsonObj): JsonObj[] {
  const surfaces = record.stateSurfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.filter(
    (s) => typeof s === "object" && s !== null && !Array.isArray(s),
  ) as JsonObj[];
}

function surfaceName(surface: JsonObj): string {
  const name = surface.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : "<unnamed>";
}

function surfaceClassification(surface: JsonObj): string {
  const raw = surface.classification;
  if (typeof raw !== "string") return "";
  return norm(raw);
}

function surfaceAllowsStorage(surface: JsonObj, storage: string): boolean {
  const approvedList = surface.approvedStorage;
  if (storageMatches(storage, approvedList)) return true;
  const forbiddenList = surface.forbiddenStorage;
  if (storageMatches(storage, forbiddenList)) return false;
  return false;
}

// ---------------------------------------------------------------------------
// Surface validation
// ---------------------------------------------------------------------------

function formatFailure(findings: GateFinding[]): string {
  const lines: string[] = ["FAIL system-of-record gate: architecture violations found."];
  for (const finding of findings) {
    lines.push(`  Violation: ${finding.reason}`);
    lines.push(`  Fix: ${finding.requiredFix}`);
    if (finding.stateSurface) lines.push(`  Surface: ${finding.stateSurface}`);
    if (finding.detectedStorage) lines.push(`  Detected storage: ${finding.detectedStorage}`);
    if (finding.approvedStorage) lines.push(`  Approved storage: ${finding.approvedStorage}`);
  }
  return lines.join("\n");
}

function validateSurface(surface: JsonObj, findings: GateFinding[]): void {
  const name = surfaceName(surface);
  const classification = surfaceClassification(surface);

  if (!STATE_CLASSIFICATIONS.has(classification)) {
    findings.push({
      stateSurface: name,
      reason: `Unknown or missing classification '${classification}' for state surface '${name}'.`,
      requiredFix: `Set classification to one of: ${[...STATE_CLASSIFICATIONS].join(", ")}.`,
    });
    return;
  }

  if (DURABLE_CLASSIFICATIONS.has(classification)) {
    const approvedList = surface.approvedStorage;
    if (!approvedList || (Array.isArray(approvedList) && approvedList.length === 0)) {
      findings.push({
        stateSurface: name,
        classification,
        reason: `Durable state surface '${name}' has no approvedStorage.`,
        requiredFix: "Declare the approved storage system (e.g., database, external_service).",
      });
    }

    if (storageIsLocalUnsafe(approvedList)) {
      findings.push({
        stateSurface: name,
        classification,
        detectedStorage: approvedStorageText(surface),
        reason: `Durable state surface '${name}' approves unsafe local storage.`,
        requiredFix:
          "Durable state must use a database or external service, not local file/memory storage.",
      });
    }

    for (const field of DURABLE_REQUIRED_FIELDS) {
      if (!nonEmpty(surface[field])) {
        findings.push({
          stateSurface: name,
          classification,
          reason: `Durable state surface '${name}' is missing required field '${field}'.`,
          requiredFix: `Add '${field}' to the design record surface for '${name}'.`,
        });
      }
    }
  }

  if (classification === "cache") {
    const approvedList = surface.approvedStorage;
    if (approvedList && FILE_STORAGE_CLASSES.has(norm(asStringList(approvedList)[0] ?? ""))) {
      if (!nonEmpty(surface.invalidationRules)) {
        findings.push({
          stateSurface: name,
          classification,
          reason: `Cache surface '${name}' uses file storage but has no invalidation rules.`,
          requiredFix: "Add invalidationRules describing when the cache is invalidated.",
        });
      }
    }
  }

  if (
    classification === "import_export_artifact" &&
    (truthyFlag(surface.liveState) || truthyFlag(surface.authoritative))
  ) {
    findings.push({
      stateSurface: name,
      classification,
      reason: "Import/export artifact is marked as live or authoritative state.",
      requiredFix: "Use it only as a temporary transfer artifact, not live application state.",
    });
  }

  if (
    classification === "canonical_artifact" &&
    (truthyFlag(surface.mutable) || truthyFlag(surface.authoritative))
  ) {
    findings.push({
      stateSurface: name,
      classification,
      reason: "Canonical artifact is marked mutable or authoritative app persistence.",
      requiredFix:
        "Use canonical artifacts as evidence/source-authored input, not mutable app records.",
    });
  }
}

const REFERENCE_EVIDENCE_GROUPS: Record<string, Set<string>> = {
  persistence: new Set(["persistence", "database", "schema", "storage", "repository"]),
  auth: new Set(["auth", "authentication", "session", "identity"]),
  permission: new Set(["permission", "authorization", "ownership", "membership", "role"]),
};

function validateReferenceApps(
  record: JsonObj,
  storyPayload: JsonObj | null | undefined,
  findings: GateFinding[],
): void {
  if (!storyMentionsReferenceApp({ ...(record ?? {}), ...(storyPayload ?? {}) })) return;

  const refs = record.referenceApplicationComparisons;
  if (!Array.isArray(refs) || refs.length === 0) {
    findings.push({
      reason: "Reference-application parity story missing referenceApplicationComparisons.",
      requiredFix:
        "Add referenceApplicationComparisons documenting how this implementation compares to the reference app's persistence, auth, and permission handling.",
    });
    return;
  }
  for (const group of Object.keys(REFERENCE_EVIDENCE_GROUPS)) {
    const groupTerms = REFERENCE_EVIDENCE_GROUPS[group]!;
    const covered = (refs as unknown[]).some((ref) => {
      const text = JSON.stringify(ref).toLowerCase();
      return [...groupTerms].some((term) => text.includes(term));
    });
    if (!covered) {
      findings.push({
        reason: `Reference-application parity story is missing '${group}' comparison in referenceApplicationComparisons.`,
        requiredFix: `Add a comparison entry covering ${group} semantics.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Signal validation
// ---------------------------------------------------------------------------

function signalLocation(signal: DetectedSignal): string {
  return signal.line !== null ? `${signal.path}:${signal.line}` : signal.path;
}

function validateSignals(record: JsonObj, signals: DetectedSignal[]): GateFinding[] {
  const surfaces = recordSurfaces(record);
  const findings: GateFinding[] = [];
  const durableSurfaces = surfaces.filter((s) =>
    DURABLE_CLASSIFICATIONS.has(surfaceClassification(s)),
  );
  const authSurfaces = surfaces.filter((s) =>
    SECURITY_CLASSIFICATIONS.has(surfaceClassification(s)),
  );

  for (const signal of signals) {
    if (signal.storage) {
      const matchingSurfaces = surfaces.filter((s) => surfaceAllowsStorage(s, signal.storage!));
      const forbiddenMatches = surfaces.filter((s) =>
        asStringList(s.forbiddenStorage).some((item) => storageMatches(signal.storage!, item)),
      );
      if (forbiddenMatches.length > 0) {
        const surface = forbiddenMatches[0]!;
        findings.push({
          stateSurface: surfaceName(surface),
          classification: surfaceClassification(surface),
          detectedStorage: signal.storage,
          approvedStorage: approvedStorageText(surface),
          reason: `The diff implements ${signal.storage} at ${signalLocation(signal)}, but the design record forbids that storage.`,
          requiredFix:
            "Move the implementation to the approved system of record or update the design record before implementation.",
        });
      } else if (matchingSurfaces.length === 0) {
        findings.push({
          detectedStorage: signal.storage,
          reason: `The diff implements ${signal.storage} at ${signalLocation(signal)} without a state surface that approves it.`,
          requiredFix:
            "Declare a matching state surface, or move the implementation to the approved system of record.",
        });
      }
    }

    if (signal.kind === "mutation_endpoint" && durableSurfaces.length === 0) {
      findings.push({
        reason: `Stateful create/update/delete API signal at ${signalLocation(signal)} has no durable owner in the design record.`,
        requiredFix:
          "Declare the durable state surface that owns this mutation, including permission and recovery semantics.",
      });
    }

    if (signal.kind === "auth_state" && authSurfaces.length === 0) {
      findings.push({
        reason: `Auth/session/permission signal at ${signalLocation(signal)} has no auth_session_state or authorization_state surface.`,
        requiredFix: "Declare the approved auth/session or authorization system of record.",
      });
    }

    if (signal.kind === "workflow_state" && durableSurfaces.length === 0) {
      findings.push({
        reason: `Workflow/job/runtime state signal at ${signalLocation(signal)} has no durable or service-backed owner.`,
        requiredFix: "Declare the job/workflow state owner and recovery semantics.",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// validate_record
// ---------------------------------------------------------------------------

export function validateRecord(
  record: JsonObj | null,
  opts: { storyPayload?: JsonObj | null; signals?: DetectedSignal[] } = {},
): GateResult {
  if (record === null) {
    const finding: GateFinding = {
      reason: "Triggered story has no architecture.systemOfRecord design record.",
      requiredFix:
        "Add a system-of-record block classifying each state surface before implementation.",
    };
    return { code: 1, message: formatFailure([finding]), findings: [finding] };
  }

  const findings: GateFinding[] = [];
  const surfaces = recordSurfaces(record);
  if (!Array.isArray(record.stateSurfaces) || surfaces.length === 0) {
    findings.push({
      reason: "systemOfRecord.stateSurfaces is missing or empty.",
      requiredFix: "Declare at least one state surface with classification and approvedStorage.",
    });
  }
  for (const surface of surfaces) {
    validateSurface(surface, findings);
  }

  validateReferenceApps(record, opts.storyPayload ?? null, findings);

  if (opts.signals && opts.signals.length > 0) {
    findings.push(...validateSignals(record, opts.signals));
  }

  if (findings.length > 0) {
    return { code: 1, message: formatFailure(findings), findings };
  }
  return { code: 0, message: "OK system-of-record gate passed.", findings: [] };
}

// ---------------------------------------------------------------------------
// Diff scanner (port of _sor_gate_diff.py)
// ---------------------------------------------------------------------------

function isLowRiskPath(path: string): boolean {
  const clean = path.replace(/^\.\//, "");
  if (SCANNER_EXEMPT_PATHS.has(clean)) return true;
  if (LOW_RISK_SUFFIXES.has(extname(clean).toLowerCase())) return true;
  return LOW_RISK_PATH_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

function storageFromLine(path: string, line: string): string {
  const text = `${path} ${line}`.toLowerCase();
  if (/\.ya?ml\b/.test(text)) return "yaml_file";
  if (/\.toml\b/.test(text)) return "toml_file";
  if (/\.(sqlite|sqlite3|db)\b/.test(text)) return "sqlite_file";
  if (/\.json\b/.test(text)) return "json_file";
  return "filesystem";
}

function pathNameSignal(path: string): DetectedSignal | null {
  if (isLowRiskPath(path)) return null;
  const name = basename(path).toLowerCase();
  if (
    /(registry|repository|store|manager|service)/.test(name) &&
    /\.(py|js|jsx|ts|tsx|go|rb|java|kt)$/.test(name)
  ) {
    return { kind: "state_module", path, line: null, detail: "stateful module name" };
  }
  if (/migrations?\//.test(path) || /\bmigration/.test(name)) {
    return {
      kind: "database_model",
      path,
      line: null,
      detail: "database migration path",
      storage: "database",
    };
  }
  return null;
}

function looksLikeWorkflowStateChange(stripped: string): boolean {
  if (/^(#|\/\/|\/\*|\*)/.test(stripped)) return false;
  const term =
    "(workflow|workflows|job|jobs|queue|queues|runtime|orchestration|job_queue|workflow_queue|runtime_state|orchestration_state|worker_state|run_state)";
  const action =
    "(create|schedule|enqueue|dequeue|start|complete|fail|cancel|retry|update|delete|upsert|persist|save|load|restore|claim|lease|dispatch)";
  const patterns = [
    new RegExp(`\\b(def|function|func)\\s+(${action}_${term}|${term}_${action})\\b`, "i"),
    /\b(class|type)\s+\w*(Workflow|Job|Queue|Runtime|Orchestration|WorkerState|RunState)\w*/,
    new RegExp(
      `\\b(${term})\\.(append|add|put|enqueue|dequeue|submit|dispatch|schedule|start|complete|fail|cancel|retry|update|delete|save|persist)\\s*\\(`,
      "i",
    ),
    new RegExp(`\\b(${term})\\s*\\[[^\\]]+\\]\\s*=`, "i"),
    new RegExp(`\\b(${term})\\s*=\\s*(new\\s+Map\\(|\\{\\}|\\[\\])`, "i"),
    new RegExp(`\\b(${action}_${term}|${term}_${action})\\s*\\(`, "i"),
  ];
  return patterns.some((p) => p.test(stripped));
}

function lineSignals(path: string, lineNo: number | null, line: string): DetectedSignal[] {
  if (isLowRiskPath(path)) return [];
  const stripped = line.trim();
  const signals: DetectedSignal[] = [];

  if (
    /write_text|write_bytes|fs\.(writeFile|writeFileSync|appendFile|createWriteStream)|Deno\.write(Text)?File|os\.WriteFile|ioutil\.WriteFile|Files\.write|open\([^)]*,\s*['"][^'"]*[wax]/.test(
      stripped,
    )
  ) {
    signals.push({
      kind: "filesystem_write",
      path,
      line: lineNo,
      detail: stripped,
      storage: storageFromLine(path, stripped),
    });
  }

  if (/\b(localStorage|sessionStorage|indexedDB|caches\.open)\b/.test(stripped)) {
    signals.push({
      kind: "browser_storage",
      path,
      line: lineNo,
      detail: stripped,
      storage: "browser_storage",
    });
  }

  const pathName = basename(path).toLowerCase();
  if (
    /(registry|repository|store|manager)/.test(pathName) &&
    /(new\s+Map\(|=\s*\{\}\s*(#|\/\/|$)|:\s*dict\[)/.test(stripped)
  ) {
    signals.push({
      kind: "in_memory_state",
      path,
      line: lineNo,
      detail: stripped,
      storage: "in_memory",
    });
  }

  if (
    /@\w+\.(post|put|patch|delete)\b|\b(router|app)\.(post|put|patch|delete)\s*\(|\b(def|function|func)\s+(create|select|update|delete|upsert)_?/i.test(
      stripped,
    )
  ) {
    signals.push({ kind: "mutation_endpoint", path, line: lineNo, detail: stripped });
  }

  if (
    /CREATE\s+TABLE|ALTER\s+TABLE|sqlalchemy|db\.Column|models\.Model|prisma|typeorm|sequelize|ActiveRecord/i.test(
      stripped,
    )
  ) {
    signals.push({
      kind: "database_model",
      path,
      line: lineNo,
      detail: stripped,
      storage: "database",
    });
  }

  if (/\b(auth|session|permission|membership|role|grant|tenant|organization)\b/i.test(stripped)) {
    signals.push({ kind: "auth_state", path, line: lineNo, detail: stripped });
  }

  if (looksLikeWorkflowStateChange(stripped)) {
    signals.push({ kind: "workflow_state", path, line: lineNo, detail: stripped });
  }

  return signals;
}

export function scanDiff(diffText: string): [DetectedSignal[], string[]] {
  const signals: DetectedSignal[] = [];
  const changedPaths: string[] = [];
  let currentPath: string | null = null;
  let newLineNo: number | null = null;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      const parts = rawLine.split(/\s+/);
      if (parts.length >= 4) {
        const candidate = parts[3] ?? "";
        currentPath = candidate.startsWith("b/") ? candidate.slice(2) : candidate;
        if (!changedPaths.includes(currentPath)) {
          changedPaths.push(currentPath);
          const ps = pathNameSignal(currentPath);
          if (ps) signals.push(ps);
        }
      }
      newLineNo = null;
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (target === "/dev/null") {
        currentPath = null;
        continue;
      }
      currentPath = target.startsWith("b/") ? target.slice(2) : target;
      if (!changedPaths.includes(currentPath)) {
        changedPaths.push(currentPath);
        const ps = pathNameSignal(currentPath);
        if (ps) signals.push(ps);
      }
      continue;
    }

    if (rawLine.startsWith("@@ ")) {
      const m = rawLine.match(/\+(\d+)/);
      newLineNo = m ? parseInt(m[1]!, 10) : null;
      continue;
    }

    if (currentPath === null) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const line = rawLine.slice(1);
      signals.push(...lineSignals(currentPath, newLineNo, line));
      if (newLineNo !== null) newLineNo += 1;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      // skip removed lines
    } else if (newLineNo !== null) {
      newLineNo += 1;
    }
  }

  return [signals, changedPaths];
}

function changedStoryRecords(
  projectRoot: string,
  changedPaths: string[],
): [Array<[string, JsonObj, JsonObj]>, GateResult | null] {
  const records: Array<[string, JsonObj, JsonObj]> = [];
  for (const rel of changedPaths) {
    if (!rel.endsWith(".vbrief.json")) continue;
    if (
      !rel.startsWith("vbrief/active/") &&
      !rel.startsWith("vbrief/pending/") &&
      !rel.startsWith("vbrief/proposed/")
    )
      continue;
    const path = join(resolve(projectRoot), rel);
    const [payload, error] = loadJsonFile(path);
    if (error !== null) return [[], error];
    if (payload !== null) {
      const record = systemOfRecord(payload);
      if (record !== null) records.push([path, payload, record]);
    }
  }
  return [records, null];
}

export function evaluateDiffText(
  diffText: string,
  opts: { projectRoot: string; storyPath?: string },
): GateResult {
  const [signals, changedPaths] = scanDiff(diffText);
  if (signals.length === 0) {
    return {
      code: 0,
      message: "OK system-of-record gate passed: no stateful diff signals detected.",
      findings: [],
    };
  }

  let payload: JsonObj | null = null;
  let record: JsonObj | null = null;

  if (opts.storyPath) {
    const [p, error] = loadJsonFile(opts.storyPath);
    if (error !== null) return error;
    payload = p;
    if (payload) record = systemOfRecord(payload);
  } else {
    const [records, error] = changedStoryRecords(opts.projectRoot, changedPaths);
    if (error !== null) return error;
    if (records.length === 1) {
      [, payload, record] = records[0]!;
    } else if (records.length > 1) {
      return {
        code: 2,
        message:
          "system-of-record gate misconfigured: multiple changed vBRIEFs contain system-of-record records; pass --story-path.",
        findings: [],
      };
    }
  }

  if (record === null) {
    const finding: GateFinding = {
      reason:
        "Diff contains stateful persistence signals, but no matching architecture.systemOfRecord design record was supplied or changed.",
      requiredFix:
        "Run `task architecture:sor-preflight -- --story-path <path>` after adding the design record, or pass --story-path to this diff gate.",
      detectedStorage: signals[0]?.storage,
    };
    return { code: 1, message: formatFailure([finding]), findings: [finding] };
  }

  const result = validateRecord(record, { storyPayload: payload, signals });
  if (result.code === 0) {
    return {
      code: 0,
      message: `OK system-of-record gate passed: ${signals.length} stateful diff signal(s) matched.`,
      findings: [],
    };
  }
  return result;
}

function gitDiff(projectRoot: string, baseRef: string): [string | null, GateResult | null] {
  const result = spawnSync("git", ["diff", "--unified=0", "--no-ext-diff", baseRef, "--"], {
    cwd: resolve(projectRoot),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) {
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: could not run git diff: ${result.error.message}`,
        findings: [],
      },
    ];
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr ?? "").trim() ||
      (result.stdout ?? "").trim() ||
      `git diff exited ${result.status}`;
    return [
      null,
      {
        code: 2,
        message: `system-of-record gate misconfigured: could not diff against ${baseRef}: ${detail}`,
        findings: [],
      },
    ];
  }
  return [result.stdout ?? "", null];
}

export function evaluateDiff(
  projectRoot: string,
  baseRef: string,
  opts: { storyPath?: string } = {},
): GateResult {
  const [diffText, error] = gitDiff(projectRoot, baseRef);
  if (error !== null) return error;
  return evaluateDiffText(diffText!, { projectRoot, ...opts });
}

export function evaluateStory(storyPath: string): GateResult {
  const [payload, error] = loadJsonFile(storyPath);
  if (error !== null) return error;
  return validateRecord(systemOfRecord(payload!), { storyPayload: payload });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function emitJson(result: GateResult): string {
  return JSON.stringify({
    ok: result.code === 0,
    exit_code: result.code,
    message: result.message,
    findings: result.findings.map((f) => ({
      state_surface: f.stateSurface ?? null,
      classification: f.classification ?? null,
      detected_storage: f.detectedStorage ?? null,
      approved_storage: f.approvedStorage ?? null,
      reason: f.reason,
      required_fix: f.requiredFix,
    })),
  });
}

function parseSorArgs(argv: string[]): {
  storyPath?: string;
  baseRef?: string;
  projectRoot: string;
  emitJson: boolean;
  error?: string;
} {
  let storyPath: string | undefined;
  let baseRef: string | undefined;
  let projectRoot = ".";
  let doEmitJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--story-path") {
      storyPath = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--story-path=")) {
      storyPath = arg.slice("--story-path=".length);
    } else if (arg === "--base-ref") {
      baseRef = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--json") {
      doEmitJson = true;
    } else {
      return { projectRoot, emitJson: doEmitJson, error: `unrecognized argument: ${arg}` };
    }
  }
  return { storyPath, baseRef, projectRoot, emitJson: doEmitJson };
}

/** CLI entry for architecture-preflight-sor (mirrors preflight_architecture_sor.py main()). */
export function architecturePreflightSorMain(argv: string[]): number {
  const parsed = parseSorArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    return 2;
  }

  const { storyPath, baseRef, projectRoot, emitJson: doEmitJson } = parsed;
  let result: GateResult;

  if (baseRef !== undefined) {
    result = evaluateDiff(projectRoot, baseRef, { storyPath });
  } else if (storyPath !== undefined) {
    result = evaluateStory(storyPath);
  } else {
    result = {
      code: 2,
      message: "system-of-record gate misconfigured: pass --story-path, --base-ref, or both.",
      findings: [],
    };
  }

  if (doEmitJson) {
    process.stdout.write(`${emitJson(result)}\n`);
  } else if (result.code === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.code;
}
