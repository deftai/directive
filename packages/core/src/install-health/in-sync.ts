/**
 * Full in-sync check (R2 / AC2.1–AC2.3, AC2.6).
 *
 * A checkout is in sync only when:
 *  (1) exact pin, (2) lockfile, (3) installed runtime agree on V;
 *  (4) GENERATION.json records setup for V;
 *  (5) required wiring targets the runtime package;
 *  (6) local readiness marker wiring-ready.<V>.json is valid (AC8.6).
 *
 * Older xbrief schema is a separate signal (AC2.2), never out-of-sync.
 * Pin≠installed fails closed with AC9.7 recovery guidance; no setup (AC2.6).
 */

import { INSTALLATION_RECOVERY_GUIDANCE } from "./constants.js";
import {
  compareSchemaVersion,
  readGenerationSetup,
  readInstalledRuntimeVersion,
  readLockfileRuntimeVersion,
  readProjectXbriefSchemaVersion,
  readReadiness,
  readRuntimePin,
  type FsSeams,
} from "./readers.js";
import type {
  FullInSyncOptions,
  FullInSyncResult,
  PredicateResult,
  SeparateSyncSignals,
} from "./types.js";
import { checkWiringTargetsRuntime } from "./wiring.js";

function pred(
  ok: boolean,
  version: string | null,
  reason: string | null,
): PredicateResult {
  return { ok, version, reason: ok ? null : reason };
}

function evaluateXbriefSignal(
  projectRoot: string,
  options: FullInSyncOptions | undefined,
  seams: FsSeams,
): SeparateSyncSignals {
  const current = options?.currentXbriefSchema;
  if (typeof current !== "string" || !current.trim()) {
    return { xbriefSchemaBehind: false, xbriefRemedy: null };
  }
  const projectSchema = readProjectXbriefSchemaVersion(projectRoot, seams);
  if (projectSchema === null) {
    return { xbriefSchemaBehind: false, xbriefRemedy: null };
  }
  const cmp = compareSchemaVersion(projectSchema, current.trim());
  if (cmp === -1) {
    return { xbriefSchemaBehind: true, xbriefRemedy: "directive upgrade" };
  }
  return { xbriefSchemaBehind: false, xbriefRemedy: null };
}

/**
 * Full owner-boundary in-sync check over a project root.
 * Pure regarding mutations: reads only; never writes readiness or generation.
 */
export function checkFullInSync(
  projectRoot: string,
  options?: FullInSyncOptions,
  seams: FsSeams = {},
): FullInSyncResult {
  const pinRead = readRuntimePin(projectRoot, seams);
  const pin: PredicateResult = pinRead.nonExact
    ? pred(false, null, `pin for @deftai/directive-runtime is not exact (${pinRead.rawSpec})`)
    : pinRead.pinVersion === null
      ? pred(false, null, "exact @deftai/directive-runtime pin missing")
      : pred(true, pinRead.pinVersion, null);

  const V = pin.version;

  const lockRead = readLockfileRuntimeVersion(projectRoot, seams);
  let lockfile: PredicateResult;
  if (V === null) {
    lockfile = pred(false, lockRead.version, "no pin to compare lockfile against");
  } else if (lockRead.kind === "absent") {
    lockfile = pred(false, null, "lockfile absent");
  } else if (lockRead.version === null) {
    lockfile = pred(false, null, `lockfile (${lockRead.kind}) does not record runtime pin`);
  } else if (lockRead.version !== V) {
    lockfile = pred(
      false,
      lockRead.version,
      `lockfile version ${lockRead.version} ≠ pin ${V}`,
    );
  } else {
    lockfile = pred(true, lockRead.version, null);
  }

  const installedVersion = readInstalledRuntimeVersion(projectRoot, seams);
  let installed: PredicateResult;
  if (V === null) {
    installed = pred(false, installedVersion, "no pin to compare installed runtime against");
  } else if (installedVersion === null) {
    installed = pred(false, null, "installed @deftai/directive-runtime missing");
  } else if (installedVersion !== V) {
    installed = pred(
      false,
      installedVersion,
      `installed ${installedVersion} ≠ pin ${V}`,
    );
  } else {
    installed = pred(true, installedVersion, null);
  }

  // AC2.6: pin≠installed → fail closed, no setup.
  const identityMismatch =
    V !== null && installedVersion !== null && installedVersion !== V;
  const failClosed = identityMismatch;
  const allowSetup = !failClosed;

  const generationRecord = readGenerationSetup(projectRoot, seams);
  let generation: PredicateResult;
  if (V === null) {
    generation = pred(false, null, "no pin to compare GENERATION.json against");
  } else if (generationRecord === null) {
    generation = pred(false, null, "GENERATION.json missing or lacks runtimeVersion");
  } else if (generationRecord.runtimeVersion !== V) {
    generation = pred(
      false,
      generationRecord.runtimeVersion,
      `GENERATION.json runtimeVersion ${generationRecord.runtimeVersion} ≠ pin ${V}`,
    );
  } else {
    generation = pred(true, generationRecord.runtimeVersion, null);
  }

  const wiringCheck = checkWiringTargetsRuntime(projectRoot, seams);
  const wiring: PredicateResult = pred(
    wiringCheck.ok,
    V,
    wiringCheck.reason,
  );

  let readiness: PredicateResult;
  if (V === null) {
    readiness = pred(false, null, "no pin to select wiring-ready.<V>.json");
  } else {
    const ready = readReadiness(projectRoot, V, seams);
    if (!ready.present) {
      readiness = pred(false, null, `wiring-ready.${V}.json missing`);
    } else if (!ready.versionMatch) {
      readiness = pred(
        false,
        ready.bodyVersion,
        `wiring-ready.${V}.json invalid or version mismatch`,
      );
    } else {
      readiness = pred(true, V, null);
    }
  }

  const separateSignals = evaluateXbriefSignal(projectRoot, options, seams);

  const inSync =
    !failClosed &&
    pin.ok &&
    lockfile.ok &&
    installed.ok &&
    generation.ok &&
    wiring.ok &&
    readiness.ok;

  return {
    inSync,
    version: V,
    failClosed,
    allowSetup,
    recoveryGuidance: failClosed ? INSTALLATION_RECOVERY_GUIDANCE : null,
    predicates: { pin, lockfile, installed, generation, wiring, readiness },
    separateSignals,
  };
}
