import { readFileSync } from "node:fs";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { productSignalInstallForceOnSource } from "./org-force-on-migration.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import {
  appendAuditLog,
  loadProjectDefinition,
  POLICY_AUDIT_NOOP_STDOUT,
  projectDefinitionPath,
} from "./resolve.js";

/** Canonical registered policy field name (#2693). */
export const FIELD_PRODUCT_SIGNAL = "plan.policy.productSignal";

/** Short alias for `policy:show --field=productSignal`. */
export const FIELD_PRODUCT_SIGNAL_CLI_ALIAS = "productSignal";

export const DEFAULT_PRODUCT_SIGNAL_ENABLED = false;

/** Baked-in default private sink (#2693 D6). */
export const DEFAULT_PRODUCT_SIGNAL_SINK_REPO = "deftai/product-signal";

export interface ProductSignalConfig {
  readonly enabled: boolean;
  readonly sinkRepo: string;
}

export type ProductSignalSource = "typed" | "install-force-on" | "default" | "default-on-error";

export interface ProductSignalResolved extends ProductSignalConfig {
  readonly source: ProductSignalSource;
  readonly error: string | null;
}

export const PRODUCT_SIGNAL_CAPABILITY_COST_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- enabling product signal opts into " +
  "consented qualitative check-ins that may submit minimized local summaries " +
  "to a private GitHub sink when you also grant install-level consent.\n" +
  "  \u2022 Default OFF; no ambient consent nag while disabled.\n" +
  "  \u2022 Outbound requires enable + recorded consent (`product-signal:consent`).\n" +
  "  \u2022 Payloads include install context and windowed value/health/helped summaries " +
  "(not raw ledgers or chat).\n" +
  "  \u2022 Inspect: `" +
  policyColonInvocation("show", " --field=productSignal") +
  "` and `task product-signal:status`.\n" +
  "  \u2022 Reversible: set `enabled: false` or revoke consent.\n" +
  "  \u2022 Changes are recorded to meta/policy-changes.log for auditability.";

function defaultResolved(
  source: ProductSignalSource,
  error: string | null = null,
): ProductSignalResolved {
  return {
    enabled: DEFAULT_PRODUCT_SIGNAL_ENABLED,
    sinkRepo: DEFAULT_PRODUCT_SIGNAL_SINK_REPO,
    source,
    error,
  };
}

/** Validate a `plan.policy.productSignal` payload. */
export function validateProductSignal(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_PRODUCT_SIGNAL} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("enabled" in rec && typeof rec.enabled !== "boolean") {
    errors.push(`${FIELD_PRODUCT_SIGNAL}.enabled must be a boolean`);
  }
  if ("sinkRepo" in rec && typeof rec.sinkRepo !== "string") {
    errors.push(`${FIELD_PRODUCT_SIGNAL}.sinkRepo must be a string`);
  }
  return errors;
}

/** Resolve a typed `productSignal` block without install-force-on overlay. */
export function resolveProductSignalFromTypedBlock(raw: unknown): ProductSignalResolved {
  const errors = validateProductSignal(raw);
  if (errors.length > 0) {
    return defaultResolved("default-on-error", errors[0] ?? "invalid productSignal block");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultResolved("default");
  }
  const block = raw as Record<string, unknown>;
  const enabled =
    typeof block.enabled === "boolean" ? block.enabled : DEFAULT_PRODUCT_SIGNAL_ENABLED;
  const sinkRepo =
    typeof block.sinkRepo === "string" && block.sinkRepo.trim().length > 0
      ? block.sinkRepo.trim()
      : DEFAULT_PRODUCT_SIGNAL_SINK_REPO;
  return {
    enabled,
    sinkRepo,
    source: "typed",
    error: null,
  };
}

/** Resolve `plan.policy.productSignal` from PROJECT-DEFINITION (#2693). */
export function resolveProductSignal(projectRoot: string): ProductSignalResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("productSignal" in (policyBlock as Record<string, unknown>))
  ) {
    return defaultResolved("default");
  }
  const raw = (policyBlock as Record<string, unknown>).productSignal;
  const installSource = productSignalInstallForceOnSource(projectRoot, raw);
  if (installSource !== null) {
    const resolved = resolveProductSignalFromTypedBlock(raw);
    return { ...resolved, source: installSource };
  }
  return resolveProductSignalFromTypedBlock(raw);
}

/** Human-readable status line for CLI surfaces. */
export function formatProductSignalStatusLine(policy: ProductSignalResolved): string {
  return (
    `[deft policy] productSignal enabled=${String(policy.enabled)} ` +
    `sinkRepo=${policy.sinkRepo}.`
  );
}

export interface ProductSignalPolicyField {
  readonly name: typeof FIELD_PRODUCT_SIGNAL;
  readonly current: ProductSignalConfig;
  readonly default: ProductSignalConfig;
  readonly source: string;
}

function fieldFromResolved(resolved: ProductSignalResolved): ProductSignalPolicyField {
  return {
    name: FIELD_PRODUCT_SIGNAL,
    current: {
      enabled: resolved.enabled,
      sinkRepo: resolved.sinkRepo,
    },
    default: {
      enabled: DEFAULT_PRODUCT_SIGNAL_ENABLED,
      sinkRepo: DEFAULT_PRODUCT_SIGNAL_SINK_REPO,
    },
    source: resolved.source,
  };
}

/** Inspector row for `policy:show --field=productSignal`. */
export function inspectProductSignal(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): ProductSignalPolicyField {
  if (data === null) {
    return fieldFromResolved(defaultResolved("default"));
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("productSignal" in (policyBlock as Record<string, unknown>))
  ) {
    if (projectRoot !== undefined) {
      return fieldFromResolved(resolveProductSignal(projectRoot));
    }
    return fieldFromResolved(defaultResolved("default"));
  }
  const raw = (policyBlock as Record<string, unknown>).productSignal;
  const installSource =
    projectRoot !== undefined ? productSignalInstallForceOnSource(projectRoot, raw) : null;
  const resolved = resolveProductSignalFromTypedBlock(raw);
  return fieldFromResolved(
    installSource !== null ? { ...resolved, source: installSource } : resolved,
  );
}

export interface EnableProductSignalOptions {
  readonly confirm: boolean;
  readonly actor?: string;
  readonly note?: string;
  readonly sinkRepo?: string;
}

export interface EnableProductSignalResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/** Persist `productSignal.enabled=true` after capability-cost disclosure (#2693). */
export function enableProductSignal(
  projectRoot: string,
  options: EnableProductSignalOptions,
): EnableProductSignalResult {
  if (!options.confirm) {
    return {
      exitCode: 1,
      stdout:
        `${PRODUCT_SIGNAL_CAPABILITY_COST_DISCLOSURE}\n\n` +
        `Re-run with --confirm to apply: task product-signal:enable -- --confirm\n`,
      changed: false,
    };
  }

  const path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = projectDefinitionMutationLock(projectRoot, () => {
      const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
      }
      const data = parsed as Record<string, unknown>;
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          throw new Error("PROJECT-DEFINITION 'plan' is not an object");
        }
      }
      const plan = data.plan as Record<string, unknown>;
      migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (
        typeof existingPolicy !== "object" ||
        existingPolicy === null ||
        Array.isArray(existingPolicy)
      ) {
        if (existingPolicy === undefined) {
          plan[PLAN_POLICY_KEY] = {};
        } else {
          throw new Error("plan.policy is not an object");
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previous = policyBlock.productSignal;
      const prevObj =
        typeof previous === "object" && previous !== null && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : {};
      const sinkRepo =
        options.sinkRepo?.trim() ||
        (typeof prevObj.sinkRepo === "string" && prevObj.sinkRepo.trim().length > 0
          ? prevObj.sinkRepo.trim()
          : DEFAULT_PRODUCT_SIGNAL_SINK_REPO);
      const nextBlock = { enabled: true, sinkRepo };
      const previousNormalized = resolveProductSignalFromTypedBlock(previous);
      const changedFlag =
        previousNormalized.enabled !== nextBlock.enabled ||
        previousNormalized.sinkRepo !== nextBlock.sinkRepo;
      policyBlock.productSignal = nextBlock;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }

      const actor = options.actor ?? "task product-signal:enable";
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        "productSignal.enabled=true",
        `sinkRepo=${sinkRepo}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag };
    });

    const resolved = resolveProductSignal(projectRoot);
    const lines = [
      `\u2713 ${FIELD_PRODUCT_SIGNAL}.enabled=true (product-signal ON).`,
      changed ? "  audit: meta/policy-changes.log updated." : POLICY_AUDIT_NOOP_STDOUT,
      formatProductSignalStatusLine(resolved),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: `\u274c ${message}\n`, changed: false };
    }
    return { exitCode: 2, stdout: `\u274c Config error: ${message}\n`, changed: false };
  }
}
