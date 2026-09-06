/**
 * Grok Bot / host widget apply-set for design-critique operator verbs (#4202).
 *
 * Prints only the verbs that apply after a successor lean. Numbered widgets
 * always end with Discuss then Back (#1470 / #1563). Does not clone
 * parseOperatorRunPosture.
 */

export const WIDGET_ACCEPT = "Accept";
export const WIDGET_WALK = "Walk";
export const WIDGET_WALK_ALL = "Walk all";
export const WIDGET_RETRY = "Retry differences";
export const WIDGET_POST_TABLE = "Post verified-claims table";
export const WIDGET_ACCEPT_SYNTHESIS = "Accept synthesis";
export const WIDGET_HALT = "Halt";
export const WIDGET_DISCUSS = "Discuss";
export const WIDGET_BACK = "Back";

export interface OperatorVerbApplyInput {
  readonly successorLeanPosted: boolean;
  readonly disagreeCount: number;
  readonly residualHeadingCount: number;
  readonly autoStamp: boolean;
}

export interface NumberedWidgetOption {
  readonly n: number;
  readonly label: string;
}

export interface OperatorVerbApplySet {
  readonly miss: boolean;
  readonly verbs: readonly string[];
  readonly numbered: readonly NumberedWidgetOption[];
}

function numberWithDiscussBack(verbs: readonly string[]): NumberedWidgetOption[] {
  const labels = [...verbs, WIDGET_DISCUSS, WIDGET_BACK];
  return labels.map((label, index) => ({ n: index + 1, label }));
}

/**
 * Widget apply-set after a successor lean.
 *
 * Retry only when residual headings are named. Walk only when a take is
 * disagree. Auto-stamp prints no operator verbs. A menu with no posted lean
 * is a contract miss.
 */
export function operatorVerbApplySet(input: OperatorVerbApplyInput): OperatorVerbApplySet {
  if (!input.successorLeanPosted) {
    return { miss: true, verbs: [], numbered: numberWithDiscussBack([]) };
  }
  if (input.autoStamp) {
    return { miss: false, verbs: [], numbered: numberWithDiscussBack([]) };
  }
  const verbs: string[] = [WIDGET_ACCEPT];
  if (input.disagreeCount > 0) {
    verbs.push(WIDGET_WALK, WIDGET_WALK_ALL);
  }
  if (input.residualHeadingCount > 0) {
    verbs.push(WIDGET_RETRY);
  }
  if (input.disagreeCount > 0) {
    verbs.push(WIDGET_POST_TABLE, WIDGET_ACCEPT_SYNTHESIS);
  }
  verbs.push(WIDGET_HALT);
  return { miss: false, verbs, numbered: numberWithDiscussBack(verbs) };
}
