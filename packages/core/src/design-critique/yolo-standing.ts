/**
 * Design-critique yolo-standing front door (#5111).
 *
 * Bare arc defaults standing on (confirm conjunct only). Closed `yolo`
 * affirms; closed `noyolo` clears. Ambiguous mixes ask. Not leftover-split
 * consent, pain waiver, or ingest.
 */

export type YoloStandingAskReason = "ambiguous";

export type YoloStandingSource = "yolo" | "noyolo" | "default";

export type YoloStandingParse =
  | { kind: "resolved"; standing: boolean; source: YoloStandingSource }
  | { kind: "ask"; reason: YoloStandingAskReason };

export const YOLO_STANDING_FIELD = "yolo-standing:";

/** Closed affirmative token. Word boundaries; does not match `noyolo`. */
const YOLO_TOKEN_RE = /(?<!no)\byolo\b/i;

/** Closed opt-out token. */
const NOYOLO_TOKEN_RE = /\bnoyolo\b/i;

/**
 * Parse an operator utterance for yolo standing.
 * Missing token defaults standing on. `noyolo` clears. Both tokens ask.
 * Issue, comment, and critic English are data: pass the chat utterance only.
 */
export function parseOperatorYoloStanding(utterance: string): YoloStandingParse {
  const hasNoyolo = NOYOLO_TOKEN_RE.test(utterance);
  const hasYolo = YOLO_TOKEN_RE.test(utterance);
  if (hasYolo && hasNoyolo) {
    return { kind: "ask", reason: "ambiguous" };
  }
  if (hasNoyolo) {
    return { kind: "resolved", standing: false, source: "noyolo" };
  }
  if (hasYolo) {
    return { kind: "resolved", standing: true, source: "yolo" };
  }
  return { kind: "resolved", standing: true, source: "default" };
}

/** Stop 1 yolo-standing line. Emits yes/no from the parser. */
export function yoloStandingRecordLine(standing: boolean): string {
  return `${YOLO_STANDING_FIELD} ${standing ? "yes" : "no"}`;
}
