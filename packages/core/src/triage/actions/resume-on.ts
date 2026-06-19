import { ResumeGrammarError } from "./errors.js";

const REF_CLOSED_RE = /^ref:closed:#(\d+)$/;
const REF_MERGED_RE = /^ref:merged:#(\d+)$/;
const DATE_GE_RE = /^date:>=(\d{4}-\d{2}-\d{2})$/;
const PENDING_GE_RE = /^pending-count:>=(\d+)$/;
const PENDING_LE_RE = /^pending-count:<=(\d+)$/;
const SLICE_WAVE_READY_RE =
  /^slice-wave-ready:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(\d+)$/;
const COMPOSITION_RE = /\s+(AND|OR)\s+/;

function parseAtomic(raw: string): void {
  const text = raw.trim();
  if (!text) {
    throw new ResumeGrammarError("empty atomic condition");
  }

  if (REF_CLOSED_RE.test(text)) return;
  if (REF_MERGED_RE.test(text)) return;

  const dateMatch = DATE_GE_RE.exec(text);
  if (dateMatch !== null) {
    const iso = dateMatch[1];
    if (iso === undefined || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      throw new ResumeGrammarError(`invalid date in '${text}': invalid isoformat`);
    }
    return;
  }

  if (PENDING_GE_RE.test(text)) return;
  if (PENDING_LE_RE.test(text)) return;

  const sliceMatch = SLICE_WAVE_READY_RE.exec(text);
  if (sliceMatch !== null) {
    const wave = Number.parseInt(sliceMatch[2] ?? "0", 10);
    if (wave < 1) {
      throw new ResumeGrammarError(`slice-wave-ready wave must be a positive int, got ${wave}`);
    }
    return;
  }

  throw new ResumeGrammarError(
    `unrecognised atomic condition '${text}'; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
  );
}

/** Parse a resume-condition expression (mirrors ``resume_conditions.parse``). */
export function parseResumeOn(expr: string): void {
  if (typeof expr !== "string") {
    throw new ResumeGrammarError(`resume_on must be a string, got ${typeof expr}`);
  }
  const text = expr.trim();
  if (!text) {
    throw new ResumeGrammarError("resume_on must be a non-empty string");
  }

  const parts = text.split(COMPOSITION_RE);
  if (parts.length === 1) {
    parseAtomic(parts[0] ?? "");
    return;
  }
  if (parts.length === 3) {
    const op = parts[1];
    if (op !== "AND" && op !== "OR") {
      throw new ResumeGrammarError(`unknown composition operator '${op}'; expected AND or OR`);
    }
    parseAtomic(parts[0] ?? "");
    parseAtomic(parts[2] ?? "");
    return;
  }
  throw new ResumeGrammarError(`resume_on supports a single top-level AND/OR in v1; got '${text}'`);
}
