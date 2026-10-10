/**
 * Equal-version data-status JSON-over-stdout channel (AC4.10 Contract 1 choice).
 */
import { CONTRACT_NUMBER, DATA_STATUS_VALUES } from "./constants.js";
import type { DataStatusJson, DataStatusValue } from "./types.js";

function isDataStatusValue(value: unknown): value is DataStatusValue {
  return typeof value === "string" && (DATA_STATUS_VALUES as readonly string[]).includes(value);
}

/** Serialize one diagnostic result as a single JSON line for stdout. */
export function serializeDataStatusJson(payload: DataStatusJson): string {
  if (payload.contract !== CONTRACT_NUMBER) {
    throw new Error(
      `data-status contract must be ${CONTRACT_NUMBER}; got ${String(payload.contract)}`,
    );
  }
  if (!isDataStatusValue(payload.dataStatus)) {
    throw new Error(`unknown dataStatus: ${String(payload.dataStatus)}`);
  }
  return JSON.stringify({
    contract: payload.contract,
    dataStatus: payload.dataStatus,
  });
}

/** Parse a JSON-over-stdout diagnostic line; throws on malformed input. */
export function parseDataStatusJson(raw: string): DataStatusJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("data-status JSON parse failed");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("data-status must be a JSON object");
  }
  const obj = parsed as { contract?: unknown; dataStatus?: unknown };
  if (typeof obj.contract !== "number" || !Number.isInteger(obj.contract)) {
    throw new Error("data-status.contract must be an integer");
  }
  if (obj.contract !== CONTRACT_NUMBER) {
    throw new Error(
      `data-status.contract must be ${CONTRACT_NUMBER}; got ${String(obj.contract)}`,
    );
  }
  if (!isDataStatusValue(obj.dataStatus)) {
    throw new Error(`data-status.dataStatus missing or unknown: ${String(obj.dataStatus)}`);
  }
  return { contract: obj.contract, dataStatus: obj.dataStatus };
}
