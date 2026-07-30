import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  enableProductSignal,
  formatProductSignalStatusLine,
  resolveProductSignal,
} from "../policy/product-signal.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveActorName } from "./actor-name.js";
import {
  authorizeProductSignalSink,
  grantProductSignalConsent,
  readProductSignalConsent,
  revokeProductSignalConsent,
} from "./consent.js";
import { maybeFormatProductSignalConsentPrompt } from "./consent-prompt.js";
import { evaluateProductSignalGates, type ProductSignalOutcome } from "./gates.js";
import { GitHubPrivateSinkAdapter } from "./github-private-sink-adapter.js";
import { collectInstallContext } from "./install-context.js";
import { assembleLocalSignalSummary } from "./local-signal-summary.js";
import {
  PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION,
  type ProductSignalHuman,
  type ProductSignalPayload,
  type ProductSignalSurface,
  readSkillsSummarySidecar,
  validateProductSignalPayload,
} from "./payload.js";
import { bootstrapProductSignalSink } from "./sink-bootstrap.js";

export const PRODUCT_SIGNAL_LAST_SUBMIT_REL = join(
  ".deft-cache",
  "product-signal-last-submit.json",
);

export interface ProductSignalSubmitInput {
  readonly surface: ProductSignalSurface;
  readonly human?: Partial<ProductSignalHuman>;
  readonly agentNotes?: string | null;
  readonly gapText?: string | null;
}

export interface ProductSignalSubmitOptions extends ProductSignalSubmitInput {
  readonly projectRoot?: string | null;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly skipGates?: boolean;
}

export interface ProductSignalSubmitResult {
  readonly outcome: ProductSignalOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
  readonly issueUrl?: string | null;
  readonly payload?: ProductSignalPayload;
}

function recordLastSubmit(
  projectRoot: string,
  outcome: ProductSignalOutcome,
  url: string | null,
): void {
  const path = resolve(projectRoot, PRODUCT_SIGNAL_LAST_SUBMIT_REL);
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    const root = resolve(projectRoot);
    containedWrite({
      root,
      target: path,
      data: `${JSON.stringify({
        outcome,
        issueUrl: url,
        at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      })}\n`,
      mode: "append",
    });
  } catch {
    // observability only
  }
}

function readLastSubmitSummary(projectRoot: string): string | null {
  const path = resolve(projectRoot, PRODUCT_SIGNAL_LAST_SUBMIT_REL);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) {
      return null;
    }
    const rec: unknown = JSON.parse(last);
    if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) {
      const at = (rec as Record<string, unknown>).at;
      const outcome = (rec as Record<string, unknown>).outcome;
      const url = (rec as Record<string, unknown>).issueUrl;
      return `last=${String(outcome)} at=${String(at)} url=${String(url ?? "none")}`;
    }
  } catch {
    return null;
  }
  return null;
}

/** Assemble a versioned product-signal payload (#2693 D7). */
export function assembleProductSignalPayload(
  projectRoot: string,
  input: ProductSignalSubmitInput,
): ProductSignalPayload {
  const ctx = collectInstallContext(projectRoot);
  const actor = resolveActorName({ projectRoot });
  const consent = readProductSignalConsent();
  const human: ProductSignalHuman = {
    nps: input.human?.nps ?? null,
    answers: input.human?.answers ?? [],
    freeText: input.human?.freeText ?? null,
  };
  return {
    schemaVersion: PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION,
    surface: input.surface,
    installId: ctx.installId,
    actorName: actor.displayName,
    actorNameSource: actor.actorNameSource,
    directiveVersion: ctx.directiveVersion,
    os: ctx.os,
    osVersion: ctx.osVersion,
    shell: ctx.shell,
    harness: ctx.harness,
    harnessVersion: ctx.harnessVersion,
    consentTier: consent?.tier ?? "none",
    consentSource: "user",
    consentVersion: consent ? String(consent.consentVersion) : "0",
    human,
    agentNotes: input.agentNotes ?? null,
    localSignalSummary: assembleLocalSignalSummary(projectRoot),
    skillsSummary: readSkillsSummarySidecar(projectRoot),
    collectedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** Submit product-signal through gates + adapter (#2693). */
export async function submitProductSignal(
  options: ProductSignalSubmitOptions,
): Promise<ProductSignalSubmitResult> {
  const root = resolveProjectRoot(options.projectRoot ?? undefined);
  if (root === null) {
    return { outcome: "error-config", exitCode: 2, message: "project root not found\n" };
  }

  if (!options.skipGates) {
    const gates = evaluateProductSignalGates({ projectRoot: root });
    if (!gates.allowed) {
      return { outcome: gates.outcome, exitCode: 0, message: `${gates.message}\n` };
    }
  }

  const payload = assembleProductSignalPayload(root, options);
  const validationErrors = validateProductSignalPayload(payload);
  if (validationErrors.length > 0) {
    return {
      outcome: "validation",
      exitCode: 1,
      message: `validation failed: ${validationErrors.join("; ")}\n`,
      payload,
    };
  }

  const policy = resolveProductSignal(root);
  const consent = readProductSignalConsent();
  const sinkAuth = authorizeProductSignalSink(policy.sinkRepo, consent);
  if (!sinkAuth.authorized) {
    return {
      outcome: "sink-unconsented",
      exitCode: 0,
      message: `${sinkAuth.message}\n`,
      payload,
    };
  }

  if (options.dryRun) {
    return {
      outcome: "dry-run",
      exitCode: 0,
      message: `[dry-run] payload valid for ${payload.surface} (sink=${sinkAuth.configuredSink})\n`,
      payload,
    };
  }

  const adapter = new GitHubPrivateSinkAdapter({ sinkRepo: policy.sinkRepo });
  const result = await adapter.submit(payload, { gapText: options.gapText });
  if (result.outcome === "submitted") {
    try {
      recordLastSubmit(root, result.outcome, result.issueUrl ?? null);
    } catch (err) {
      if (err instanceof ProjectionContainmentError || err instanceof ContainedWriteError) {
        return {
          outcome: "error-config",
          exitCode: 2,
          message: `${err.message}\n`,
          issueUrl: result.issueUrl,
          payload,
        };
      }
      throw err;
    }
  }
  const urlLine = result.issueUrl ? ` url=${result.issueUrl}` : "";
  return {
    outcome: result.outcome,
    exitCode: 0,
    message: `${result.message}${urlLine}\n`,
    issueUrl: result.issueUrl,
    payload,
  };
}

export function runProductSignalStatus(projectRoot: string | null): { exitCode: 0; text: string } {
  const root = resolveProjectRoot(projectRoot ?? undefined) ?? process.cwd();
  const policy = resolveProductSignal(root);
  const consent = readProductSignalConsent();
  const configuredSink = policy.sinkRepo;
  const sinkAuth = authorizeProductSignalSink(configuredSink, consent);
  const last = readLastSubmitSummary(root);
  const lines = [
    formatProductSignalStatusLine(policy),
    `[deft product-signal] consented=${String(consent !== null)} configuredSink=${configuredSink} consentedSink=${sinkAuth.consentedSink ?? "none"} sinksMatch=${String(sinkAuth.sinksMatch)}`,
    last ? `[deft product-signal] ${last}` : "[deft product-signal] last submit: none",
  ];
  const consentPrompt = maybeFormatProductSignalConsentPrompt({ projectRoot: root });
  if (consentPrompt.length > 0) {
    lines.push(consentPrompt.trimEnd());
  }
  return { exitCode: 0, text: `${lines.join("\n")}\n` };
}

export function runProductSignalEnable(
  projectRoot: string | null,
  confirm: boolean,
): { exitCode: 0 | 1 | 2; text: string } {
  const root = resolveProjectRoot(projectRoot ?? undefined);
  if (root === null) {
    return { exitCode: 2, text: "project root not found\n" };
  }
  const result = enableProductSignal(root, { confirm });
  return { exitCode: result.exitCode, text: result.stdout };
}

export interface ProductSignalConsentRunOptions {
  readonly action: "grant" | "revoke";
  readonly projectRoot?: string | null;
}

export function runProductSignalConsent(options: ProductSignalConsentRunOptions): {
  exitCode: 0 | 1;
  text: string;
} {
  if (options.action === "grant") {
    const root = resolveProjectRoot(options.projectRoot ?? undefined);
    const sinkRepo = root !== null ? resolveProductSignal(root).sinkRepo : undefined;
    const record = grantProductSignalConsent({ sinkRepo });
    return {
      exitCode: 0,
      text:
        `product-signal consent granted (tier=${record.tier}, version=${record.consentVersion}, ` +
        `sinkRepo=${record.sinkRepo ?? "unknown"}).\n`,
    };
  }
  const ok = revokeProductSignalConsent();
  if (!ok) {
    return { exitCode: 1, text: "no consent file to revoke\n" };
  }
  return { exitCode: 0, text: "product-signal consent revoked\n" };
}

export function runProductSignalBootstrapSink(dryRun: boolean): {
  exitCode: 0 | 1 | 2;
  text: string;
} {
  const result = bootstrapProductSignalSink({ dryRun });
  return { exitCode: result.exitCode, text: result.stdout };
}

export function parseProductSignalSubmitArgs(argv: string[]): {
  surface: ProductSignalSurface;
  dryRun: boolean;
  json: boolean;
  projectRoot: string;
  nps: number | null;
  error?: string;
} {
  let surface: ProductSignalSurface = "pulse";
  let dryRun = false;
  let json = false;
  let projectRoot = ".";
  let nps: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--surface") {
      const v = argv[i + 1];
      if (v !== "pulse" && v !== "portrait") {
        return { surface, dryRun, json, projectRoot, nps, error: "invalid --surface" };
      }
      surface = v;
      i += 1;
    } else if (arg?.startsWith("--surface=")) {
      const v = arg.slice("--surface=".length);
      if (v !== "pulse" && v !== "portrait") {
        return { surface, dryRun, json, projectRoot, nps, error: "invalid --surface" };
      }
      surface = v;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--nps") {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 0 || v > 10) {
        return { surface, dryRun, json, projectRoot, nps, error: "invalid --nps" };
      }
      nps = v;
      i += 1;
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      return { surface, dryRun, json, projectRoot, nps, error: `unrecognized argument: ${arg}` };
    }
  }
  return { surface, dryRun, json, projectRoot, nps };
}

function parseOptionalProjectRootArg(argv: string[], fallback: string | null): string | null {
  const rootIdx = argv.indexOf("--project-root");
  if (rootIdx >= 0) {
    return argv[rootIdx + 1] ?? fallback;
  }
  const eqArg = argv.find((a) => a.startsWith("--project-root="));
  if (eqArg !== undefined) {
    return eqArg.slice("--project-root=".length) || fallback;
  }
  return fallback;
}

/** CLI module entrypoint for dispatch (#2693). */
export async function productSignalMain(argv: string[] = process.argv.slice(2)): Promise<number> {
  const sub = argv[0];
  if (sub === "status") {
    const root = parseOptionalProjectRootArg(argv, ".") ?? ".";
    const result = runProductSignalStatus(root);
    process.stdout.write(result.text);
    return result.exitCode;
  }
  if (sub === "enable") {
    const confirm = argv.includes("--confirm");
    const root = parseOptionalProjectRootArg(argv, ".") ?? ".";
    const result = runProductSignalEnable(root, confirm);
    process.stdout.write(result.text);
    return result.exitCode;
  }
  if (sub === "consent") {
    const grant = argv.includes("--grant");
    const revoke = argv.includes("--revoke");
    if (grant === revoke) {
      process.stderr.write("usage: product-signal consent -- --grant|--revoke\n");
      return 1;
    }
    const root = parseOptionalProjectRootArg(argv, null);
    const result = runProductSignalConsent({
      action: grant ? "grant" : "revoke",
      projectRoot: root,
    });
    process.stdout.write(result.text);
    return result.exitCode;
  }
  if (sub === "bootstrap-sink") {
    const result = runProductSignalBootstrapSink(argv.includes("--dry-run"));
    process.stdout.write(result.text);
    return result.exitCode;
  }
  if (sub === "submit") {
    const parsed = parseProductSignalSubmitArgs(argv.slice(1));
    if (parsed.error) {
      process.stderr.write(`${parsed.error}\n`);
      return 1;
    }
    const result = await submitProductSignal({
      projectRoot: parsed.projectRoot,
      surface: parsed.surface,
      dryRun: parsed.dryRun,
      json: parsed.json,
      human: parsed.nps !== null ? { nps: parsed.nps, answers: [], freeText: null } : undefined,
    });
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            outcome: result.outcome,
            exit_code: result.exitCode,
            message: result.message.trim(),
            issue_url: result.issueUrl ?? null,
            payload: result.payload ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(result.message);
    }
    return result.exitCode;
  }
  process.stderr.write("usage: product-signal [status|enable|consent|submit|bootstrap-sink] ...\n");
  return 1;
}

export async function mainEntry(argv: string[] = process.argv.slice(2)): Promise<number> {
  return productSignalMain(argv);
}
