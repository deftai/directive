/**
 * Read runtime version + contract from package.json only (A5.5 / AC3.9).
 * Never loads runtime code.
 */
import { CONTRACT_PACKAGE_JSON_KEY } from "./constants.js";
import type { RuntimePackageContractMeta } from "./types.js";

/**
 * Extract version and contract from a parsed runtime package.json object.
 * Throws if either field is missing or malformed.
 */
export function readRuntimeContractFromPackageJson(
  pkg: unknown,
): RuntimePackageContractMeta {
  if (pkg === null || typeof pkg !== "object") {
    throw new Error("runtime package.json must be an object");
  }
  const record = pkg as Record<string, unknown>;
  const version = record.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("runtime package.json missing string version");
  }
  const directive = record[CONTRACT_PACKAGE_JSON_KEY];
  if (directive === null || typeof directive !== "object") {
    throw new Error(`runtime package.json missing ${CONTRACT_PACKAGE_JSON_KEY}.contract`);
  }
  const contract = (directive as { contract?: unknown }).contract;
  if (typeof contract !== "number" || !Number.isInteger(contract) || contract < 1) {
    throw new Error(`${CONTRACT_PACKAGE_JSON_KEY}.contract must be a positive integer`);
  }
  return { version, contract };
}

/** AC4.6 / AC4.7: launcher supports 1..maxInclusive; higher is too-new. */
export function isContractSupportedByLauncher(
  runtimeContract: number,
  launcherMaxSupported: number,
): boolean {
  return (
    Number.isInteger(runtimeContract) &&
    Number.isInteger(launcherMaxSupported) &&
    runtimeContract >= 1 &&
    runtimeContract <= launcherMaxSupported
  );
}
