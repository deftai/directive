import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";

function projectDefinitionPath(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
}

function loadForMutation(projectRoot: string): [Record<string, unknown>, string] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(
      `PROJECT-DEFINITION not found at ${path}; run task triage:welcome / task triage:bootstrap to scaffold one first.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read PROJECT-DEFINITION at ${path}: ${String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PROJECT-DEFINITION at ${path} is not valid JSON: ${String(err)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
  }
  return [data as Record<string, unknown>, path];
}

function atomicWrite(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = join(dir, `.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

export interface AddIgnoreResult {
  readonly changed: boolean;
  readonly message: string;
}

/** Append a label/milestone ignore entry — mirrors Python `add_ignore`. */
export function addIgnore(
  projectRoot: string,
  options: { readonly label?: string; readonly milestone?: string },
): AddIgnoreResult {
  const hasLabel = options.label !== undefined;
  const hasMilestone = options.milestone !== undefined;
  if (hasLabel === hasMilestone) {
    throw new Error("add_ignore() requires exactly one of label= / milestone=");
  }
  const key = hasLabel ? "label" : "milestone";
  const value = (hasLabel ? options.label : options.milestone) ?? "";
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string; got ${JSON.stringify(value)}`);
  }

  const [data, path] = loadForMutation(projectRoot);
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-object 'plan' key`);
  }
  const planRec = plan as Record<string, unknown>;
  let policy = planRec.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    policy = {};
    planRec.policy = policy;
  }
  const policyRec = policy as Record<string, unknown>;
  const raw: unknown[] = Array.isArray(policyRec.triageScopeIgnores)
    ? (policyRec.triageScopeIgnores as unknown[])
    : [];
  policyRec.triageScopeIgnores = raw;
  for (const entry of raw) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      if ((entry as Record<string, unknown>)[key] === value) {
        return { changed: false, message: `already-ignored (${key}=${value})` };
      }
    }
  }
  raw.push({ [key]: value });
  atomicWrite(path, data);
  return { changed: true, message: `added ignore (${key}=${value})` };
}
