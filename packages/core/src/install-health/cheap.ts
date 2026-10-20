/**
 * Cheap in-sync check for hooks (AC2.4).
 *
 * Checks pin/installed-runtime identity + readiness validity only.
 * Designed to be fast on a warm filesystem; unit-testable without sleeping.
 * Full setup is not repeated on this path when readiness is valid.
 *
 * Pin≠installed fails closed with AC9.7 recovery guidance; no setup (AC2.6).
 */

import { INSTALLATION_RECOVERY_GUIDANCE } from "./constants.js";
import {
  type FsSeams,
  readInstalledRuntimeVersion,
  readReadiness,
  readRuntimePin,
} from "./readers.js";
import type { CheapInSyncResult } from "./types.js";

/**
 * Fast hook path: identity + readiness. Does not inspect lockfile, generation,
 * or wiring inventory (those belong to the full check / doctor).
 */
export function checkCheapInSync(projectRoot: string, seams: FsSeams = {}): CheapInSyncResult {
  const pinRead = readRuntimePin(projectRoot, seams);
  const pinVersion = pinRead.pinVersion;
  const installedVersion = readInstalledRuntimeVersion(projectRoot, seams);

  const identityMatch =
    pinVersion !== null && installedVersion !== null && pinVersion === installedVersion;

  const identityMismatch =
    pinVersion !== null && installedVersion !== null && pinVersion !== installedVersion;

  const failClosed = identityMismatch;
  const allowSetup = !failClosed;

  let readinessValid = false;
  if (pinVersion !== null) {
    const ready = readReadiness(projectRoot, pinVersion, seams);
    readinessValid = ready.present && ready.versionMatch;
  }

  const ok = identityMatch && readinessValid && !failClosed;

  return {
    ok,
    pinVersion,
    installedVersion,
    identityMatch,
    readinessValid,
    failClosed,
    allowSetup,
    recoveryGuidance: failClosed ? INSTALLATION_RECOVERY_GUIDANCE : null,
  };
}
