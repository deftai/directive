import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { DEFAULT_PRODUCT_SIGNAL_SINK_REPO } from "../policy/product-signal.js";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";

export const PRODUCT_SIGNAL_CONSENT_FILENAME = "product-signal-consent.json";

/** Consent record schema version (#2693 D2, #2767 v2 sink binding). */
export const PRODUCT_SIGNAL_CONSENT_VERSION = 2;

/** Legacy consent schema — authorizes default sink only (#2767). */
const PRODUCT_SIGNAL_CONSENT_VERSION_V1 = 1;

/** Phase-1 consent tier permitting qualitative outbound (#2693 D2). */
export const PRODUCT_SIGNAL_CONSENT_TIER = "product-signal";

export interface ProductSignalConsentRecord {
  readonly consentVersion: number;
  readonly grantedAt: string;
  readonly tier: string;
  /** Normalized owner/repo sink authorized by v2 consent (#2767). */
  readonly sinkRepo?: string;
  readonly revokedAt?: string;
}

export interface ResolveConsentPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export interface SinkAuthorizationResult {
  readonly authorized: boolean;
  readonly configuredSink: string;
  readonly consentedSink: string | null;
  readonly sinksMatch: boolean;
  readonly message: string;
}

function resolveHomeDirForConsent(options: ResolveConsentPathOptions): string {
  if (options.homeDir !== undefined) {
    return options.homeDir;
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) {
      return userProfile;
    }
  }
  const home = env.HOME?.trim();
  if (home) {
    return home;
  }
  return homedir();
}

/** Platform-config consent path adjacent to USER.md (#2693 D2). */
export function resolveProductSignalConsentPath(options: ResolveConsentPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = resolveHomeDirForConsent(options);
  return join(platformUserConfigDir(platform, env, homeDir), PRODUCT_SIGNAL_CONSENT_FILENAME);
}

/** Normalize sinkRepo to lowercase owner/repo (#2767). */
export function normalizeProductSignalSinkRepo(raw: string): string {
  const sink = raw.trim().replace(/^https?:\/\/github\.com\//i, "");
  return sink.replace(/\/+$/, "").toLowerCase();
}

function parseConsentRecord(raw: unknown): ProductSignalConsentRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.consentVersion !== "number" ||
    typeof rec.grantedAt !== "string" ||
    typeof rec.tier !== "string"
  ) {
    return null;
  }
  const revokedAt = typeof rec.revokedAt === "string" ? rec.revokedAt : undefined;
  let sinkRepo: string | undefined;
  if (rec.consentVersion >= PRODUCT_SIGNAL_CONSENT_VERSION) {
    if (typeof rec.sinkRepo !== "string" || rec.sinkRepo.trim().length === 0) {
      return null;
    }
    sinkRepo = normalizeProductSignalSinkRepo(rec.sinkRepo);
    if (sinkRepo.length === 0) {
      return null;
    }
  } else if (rec.consentVersion !== PRODUCT_SIGNAL_CONSENT_VERSION_V1) {
    return null;
  }
  return {
    consentVersion: rec.consentVersion,
    grantedAt: rec.grantedAt,
    tier: rec.tier,
    sinkRepo,
    revokedAt,
  };
}

/** Resolve the sink authorized by a consent record (#2767). */
export function resolveConsentedProductSignalSink(
  consent: ProductSignalConsentRecord | null,
): string | null {
  if (consent === null) {
    return null;
  }
  if (consent.consentVersion >= PRODUCT_SIGNAL_CONSENT_VERSION) {
    return consent.sinkRepo ?? null;
  }
  if (consent.consentVersion === PRODUCT_SIGNAL_CONSENT_VERSION_V1) {
    return normalizeProductSignalSinkRepo(DEFAULT_PRODUCT_SIGNAL_SINK_REPO);
  }
  return null;
}

/** Authorize configured sink against install consent (#2767). */
export function authorizeProductSignalSink(
  configuredSink: string,
  consent: ProductSignalConsentRecord | null,
): SinkAuthorizationResult {
  const configured = normalizeProductSignalSinkRepo(configuredSink);
  const consented = resolveConsentedProductSignalSink(consent);
  const sinksMatch = consented !== null && configured === consented;
  let message = "sink authorized";
  if (!sinksMatch) {
    message =
      consented === null
        ? "product-signal requires consent (`task product-signal:consent -- --grant`)."
        : `product-signal skipped (sink-unconsented): configured sink=${configured} does not match consented sink=${consented}. Re-run \`task product-signal:consent -- --grant\` after confirming the destination.`;
  }
  return {
    authorized: sinksMatch,
    configuredSink: configured,
    consentedSink: consented,
    sinksMatch,
    message,
  };
}

/** Read consent file; returns null when absent, invalid, or revoked. */
export function readProductSignalConsent(
  options: ResolveConsentPathOptions = {},
): ProductSignalConsentRecord | null {
  const path = resolveProductSignalConsentPath(options);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = parseConsentRecord(parsed);
    if (record === null) {
      return null;
    }
    if (record.revokedAt !== undefined && record.revokedAt.trim().length > 0) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

/** True when a non-revoked consent grant exists. */
export function isProductSignalConsented(options: ResolveConsentPathOptions = {}): boolean {
  return readProductSignalConsent(options) !== null;
}

export interface WriteConsentOptions extends ResolveConsentPathOptions {
  readonly now?: Date;
  /** Normalized sink to bind into v2 consent (#2767). Defaults to baked-in sink. */
  readonly sinkRepo?: string;
}

/** Write a fresh consent grant (#2693 D17 yes path, #2767 v2 sink binding). */
export function grantProductSignalConsent(
  options: WriteConsentOptions = {},
): ProductSignalConsentRecord {
  const now = options.now ?? new Date();
  const normalizedSink = normalizeProductSignalSinkRepo(
    (options.sinkRepo ?? DEFAULT_PRODUCT_SIGNAL_SINK_REPO).trim(),
  );
  const sinkRepo =
    normalizedSink || normalizeProductSignalSinkRepo(DEFAULT_PRODUCT_SIGNAL_SINK_REPO);
  const record: ProductSignalConsentRecord = {
    consentVersion: PRODUCT_SIGNAL_CONSENT_VERSION,
    grantedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    tier: PRODUCT_SIGNAL_CONSENT_TIER,
    sinkRepo,
  };
  const path = resolveProductSignalConsentPath(options);
  // #2980 wave D: product write sink routes through containedWrite.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  containedWrite({
    root: resolve(dir),
    target: basename(path),
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
  return record;
}

/** Revoke consent by setting revokedAt (#2693 D2). */
export function revokeProductSignalConsent(options: WriteConsentOptions = {}): boolean {
  const path = resolveProductSignalConsentPath(options);
  if (!existsSync(path)) {
    return false;
  }
  const now = options.now ?? new Date();
  let existing: ProductSignalConsentRecord | null = null;
  try {
    existing = parseConsentRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return false;
  }
  if (existing === null) {
    return false;
  }
  const revoked: ProductSignalConsentRecord = {
    ...existing,
    revokedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  // #2980 wave D: product write sink routes through containedWrite.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  containedWrite({
    root: resolve(dir),
    target: basename(path),
    data: `${JSON.stringify(revoked, null, 2)}\n`,
    mode: "replace",
  });
  return true;
}
