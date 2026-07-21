import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";

export const PRODUCT_SIGNAL_CONSENT_FILENAME = "product-signal-consent.json";

/** Consent record schema version (#2693 D2). */
export const PRODUCT_SIGNAL_CONSENT_VERSION = 1;

/** Phase-1 consent tier permitting qualitative outbound (#2693 D2). */
export const PRODUCT_SIGNAL_CONSENT_TIER = "product-signal";

export interface ProductSignalConsentRecord {
  readonly consentVersion: number;
  readonly grantedAt: string;
  readonly tier: string;
  readonly revokedAt?: string;
}

export interface ResolveConsentPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
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

function parseConsentRecord(raw: unknown): ProductSignalConsentRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.consentVersion !== "number" || typeof rec.grantedAt !== "string") {
    return null;
  }
  if (typeof rec.tier !== "string") {
    return null;
  }
  const revokedAt = typeof rec.revokedAt === "string" ? rec.revokedAt : undefined;
  return {
    consentVersion: rec.consentVersion,
    grantedAt: rec.grantedAt,
    tier: rec.tier,
    revokedAt,
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
}

/** Write a fresh consent grant (#2693 D17 yes path). */
export function grantProductSignalConsent(
  options: WriteConsentOptions = {},
): ProductSignalConsentRecord {
  const now = options.now ?? new Date();
  const record: ProductSignalConsentRecord = {
    consentVersion: PRODUCT_SIGNAL_CONSENT_VERSION,
    grantedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    tier: PRODUCT_SIGNAL_CONSENT_TIER,
  };
  const path = resolveProductSignalConsentPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
  writeFileSync(path, `${JSON.stringify(revoked, null, 2)}\n`, "utf8");
  return true;
}
