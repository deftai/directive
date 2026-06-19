import {
  ALLOWED_FIELDS,
  CHILD_ALLOWED_FIELDS,
  CHILD_REQUIRED_FIELDS,
  ISO8601_RE,
  REQUIRED_FIELDS,
  UUID_RE,
  VALID_EXPECTED_CLOSE_SIGNALS,
} from "./constants.js";
import { SliceRecordError } from "./errors.js";

function validateChild(child: unknown, index: number): void {
  if (child === null || typeof child !== "object" || Array.isArray(child)) {
    throw new SliceRecordError(
      `children[${index}] must be a dict, got ${child === null ? "null" : typeof child}`,
    );
  }
  const record = child as Record<string, unknown>;
  const missing = CHILD_REQUIRED_FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) {
    throw new SliceRecordError(`children[${index}] missing required field(s): ${missing}`);
  }
  const extras = Object.keys(record)
    .filter((key) => !CHILD_ALLOWED_FIELDS.has(key as (typeof CHILD_REQUIRED_FIELDS)[number]))
    .sort();
  if (extras.length > 0) {
    throw new SliceRecordError(`children[${index}] has unknown field(s): ${extras}`);
  }
  const n = record.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new SliceRecordError(`children[${index}].n must be a positive int, got ${String(n)}`);
  }
  const url = record.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new SliceRecordError(
      `children[${index}].url must be a non-empty string, got ${String(url)}`,
    );
  }
  const wave = record.wave;
  if (typeof wave !== "number" || !Number.isInteger(wave) || wave < 1) {
    throw new SliceRecordError(
      `children[${index}].wave must be a positive int, got ${String(wave)}`,
    );
  }
  const role = record.role;
  if (typeof role !== "string" || role.length === 0) {
    throw new SliceRecordError(
      `children[${index}].role must be a non-empty string, got ${String(role)}`,
    );
  }
}

/** Hand-rolled mirror of vbrief/schemas/slices.schema.json. */
export function validateRecord(record: unknown): void {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new SliceRecordError(
      `record must be a dict, got ${record === null ? "null" : typeof record}`,
    );
  }
  const obj = record as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((field) => !(field in obj));
  if (missing.length > 0) {
    throw new SliceRecordError(`record missing required field(s): ${missing}`);
  }
  const extras = Object.keys(obj)
    .filter((key) => !ALLOWED_FIELDS.has(key as (typeof REQUIRED_FIELDS)[number] | "notes"))
    .sort();
  if (extras.length > 0) {
    throw new SliceRecordError(`record has unknown field(s): ${extras}`);
  }
  const sliceId = obj.slice_id;
  if (typeof sliceId !== "string" || !UUID_RE.test(sliceId)) {
    throw new SliceRecordError(`slice_id must be a UUID string, got ${String(sliceId)}`);
  }
  const umbrella = obj.umbrella;
  if (typeof umbrella !== "number" || !Number.isInteger(umbrella) || umbrella < 1) {
    throw new SliceRecordError(`umbrella must be a positive int, got ${String(umbrella)}`);
  }
  const umbrellaUrl = obj.umbrella_url;
  if (typeof umbrellaUrl !== "string" || umbrellaUrl.length === 0) {
    throw new SliceRecordError(
      `umbrella_url must be a non-empty string, got ${String(umbrellaUrl)}`,
    );
  }
  const slicedAt = obj.sliced_at;
  if (typeof slicedAt !== "string" || !ISO8601_RE.test(slicedAt)) {
    throw new SliceRecordError(
      `sliced_at must be ISO-8601 UTC with Z suffix (e.g. 2026-05-13T18:00:00Z), got ${String(slicedAt)}`,
    );
  }
  const actor = obj.actor;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new SliceRecordError(`actor must be a non-empty string, got ${String(actor)}`);
  }
  const children = obj.children;
  if (!Array.isArray(children) || children.length === 0) {
    throw new SliceRecordError("children must be a non-empty list of child records");
  }
  for (let i = 0; i < children.length; i += 1) {
    validateChild(children[i], i);
  }
  const expected = obj.expected_close_signal;
  if (typeof expected !== "string" || !VALID_EXPECTED_CLOSE_SIGNALS.has(expected)) {
    throw new SliceRecordError(
      `expected_close_signal must be one of ${[...VALID_EXPECTED_CLOSE_SIGNALS].sort()}, got ${String(expected)}`,
    );
  }
  if ("notes" in obj && typeof obj.notes !== "string") {
    throw new SliceRecordError(`notes must be a string, got ${typeof obj.notes}`);
  }
}
