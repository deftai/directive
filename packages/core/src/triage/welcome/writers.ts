import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AUDIT_LOG_REL_PATH,
  DEFAULT_RELIEF_AGE_DAYS,
  DEFAULT_WIP_CAP,
  PROJECT_DEFINITION_REL_PATH,
  SUBSCRIPTION_PRESETS,
  WELCOME_AUDIT_TAG,
} from "./constants.js";

function projectDefinitionPath(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
}

function utcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function appendAuditEntry(projectRoot: string, entry: string): string {
  const logPath = join(resolve(projectRoot), AUDIT_LOG_REL_PATH);
  mkdirSync(dirname(logPath), { recursive: true });
  const line = `${utcIso()} ${entry}\n`;
  if (!existsSync(logPath)) {
    writeFileSync(
      logPath,
      "# meta/policy-changes.log -- audit trail for PROJECT-DEFINITION plan.policy.* mutations (#746 / #1143)\n",
      "utf8",
    );
  }
  appendFileSync(logPath, line, "utf8");
  return logPath;
}

function atomicWrite(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

export function writeTriageScope(
  projectRoot: string,
  rules: Array<Record<string, unknown>>,
  options: { presetLabel: string; actor?: string } = { presetLabel: "custom" },
): [boolean, string] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) throw new Error(`PROJECT-DEFINITION not found at ${path}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error("PROJECT-DEFINITION 'plan' is not an object");
  }
  const planRec = plan as Record<string, unknown>;
  let policy = planRec.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    policy = {};
    planRec.policy = policy;
  }
  const policyRec = policy as Record<string, unknown>;
  const previous = policyRec.triageScope;
  policyRec.triageScope = rules;
  atomicWrite(path, data);
  const changed = JSON.stringify(previous) !== JSON.stringify(rules);
  const actor = options.actor ?? WELCOME_AUDIT_TAG;
  const auditEntry = [
    `actor=${actor}`,
    "field=plan.policy.triageScope",
    `preset=${options.presetLabel}`,
    `rule_count=${rules.length}`,
    `changed=${changed ? "true" : "false"}`,
  ].join(" ");
  appendAuditEntry(projectRoot, auditEntry);
  return [changed, auditEntry];
}

export function writeWipCap(
  projectRoot: string,
  wipCap: number,
  options: { actor?: string } = {},
): [boolean, string] {
  if (!Number.isInteger(wipCap) || wipCap < 1) {
    throw new Error(`wipCap must be a positive int, got ${JSON.stringify(wipCap)}`);
  }
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) throw new Error(`PROJECT-DEFINITION not found at ${path}`);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error("PROJECT-DEFINITION 'plan' is not an object");
  }
  const planRec = plan as Record<string, unknown>;
  let policy = planRec.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    policy = {};
    planRec.policy = policy;
  }
  const policyRec = policy as Record<string, unknown>;
  const previous = policyRec.wipCap;
  const actor = options.actor ?? WELCOME_AUDIT_TAG;

  if (previous === undefined && wipCap === DEFAULT_WIP_CAP) {
    return [false, ""];
  }
  if (previous !== undefined && wipCap === DEFAULT_WIP_CAP) {
    delete policyRec.wipCap;
    atomicWrite(path, data);
    const auditEntry =
      `actor=${actor} field=plan.policy.wipCap action=cleared-to-default value=${wipCap} ` +
      `previous=${JSON.stringify(previous)} changed=true`;
    appendAuditEntry(projectRoot, auditEntry);
    return [true, auditEntry];
  }
  policyRec.wipCap = wipCap;
  atomicWrite(path, data);
  const changed = previous !== wipCap;
  const auditEntry =
    `actor=${actor} field=plan.policy.wipCap value=${wipCap} previous=${JSON.stringify(previous)} ` +
    `changed=${changed ? "true" : "false"}`;
  appendAuditEntry(projectRoot, auditEntry);
  return [changed, auditEntry];
}

export interface ReliefPreview {
  readonly olderThanDays: number;
  readonly eligibleCount: number;
  readonly eligibleFiles: readonly string[];
  readonly skippedCount: number;
}

function daysInPending(path: string, now: Date): number {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const plan = data.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      const raw = (plan as Record<string, unknown>).updated;
      if (typeof raw === "string") {
        let text = raw.trim();
        if (text.endsWith("Z")) text = `${text.slice(0, -1)}+00:00`;
        const stamp = new Date(text);
        if (!Number.isNaN(stamp.getTime())) {
          return Math.max(0, Math.floor((now.getTime() - stamp.getTime()) / 86400000));
        }
      }
    }
  } catch {
    // fall through
  }
  try {
    const mtime = statSync(path).mtime;
    return Math.max(0, Math.floor((now.getTime() - mtime.getTime()) / 86400000));
  } catch {
    return 0;
  }
}

export function previewWipRelief(
  projectRoot: string,
  olderThanDays = DEFAULT_RELIEF_AGE_DAYS,
): ReliefPreview {
  const pendingDir = join(resolve(projectRoot), "vbrief", "pending");
  if (!existsSync(pendingDir)) {
    return { olderThanDays, eligibleCount: 0, eligibleFiles: [], skippedCount: 0 };
  }
  const now = new Date();
  const eligible: string[] = [];
  let skipped = 0;
  for (const name of [...readdirSync(pendingDir)]
    .filter((n) => n.endsWith(".vbrief.json"))
    .sort()) {
    const path = join(pendingDir, name);
    const days = daysInPending(path, now);
    if (days >= olderThanDays) eligible.push(name);
    else skipped += 1;
  }
  return {
    olderThanDays,
    eligibleCount: eligible.length,
    eligibleFiles: eligible,
    skippedCount: skipped,
  };
}

export function subscriptionPreset(key: string): Array<Record<string, unknown>> {
  const preset = SUBSCRIPTION_PRESETS[key];
  if (!preset) throw new Error(`unknown preset ${key}`);
  return preset.map((r) => ({ ...r }));
}
