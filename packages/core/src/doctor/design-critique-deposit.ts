/**
 * Doctor/setup advisory for deposited design-critique without judgmentGates (#5326).
 *
 * Fires only when the deposit predicate is true. Does not probe GitHub labels
 * on the offline doctor path; remediation names ensure catalog chips + typed gate.
 */

import {
  DESIGN_CRITIQUE_JUDGMENT_GATE_ENTRY,
  formatDesignCritiqueJudgmentGatesRemediation,
  hasDesignCritiqueJudgmentGate,
  isDesignCritiqueDeposited,
} from "../design-critique/catalog-chip-ensure.js";
import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "../design-critique/exclusive-chip.js";
import type { CheckResult } from "./types.js";

export const DESIGN_CRITIQUE_DEPOSIT_CHECK = "design-critique-deposit" as const;

/** Advisory doctor check: deposit present → judgmentGates design-critique must light or warn. */
export function checkDesignCritiqueDeposit(projectRoot: string): CheckResult {
  if (!isDesignCritiqueDeposited(projectRoot)) {
    return {
      name: DESIGN_CRITIQUE_DEPOSIT_CHECK,
      status: "skip",
      detail: "design-critique content not deposited; advisory not applicable",
      data: { advisory: true, deposited: false },
    };
  }

  const gatePresent = hasDesignCritiqueJudgmentGate(projectRoot);
  const chipNames = DESIGN_CRITIQUE_CATALOG_CHIPS.join(", ");
  if (gatePresent) {
    return {
      name: DESIGN_CRITIQUE_DEPOSIT_CHECK,
      status: "pass",
      detail:
        `design-critique deposited; judgmentGates id=${DESIGN_CRITIQUE_JUDGMENT_GATE_ENTRY.id} present. ` +
        `Ensure catalog labels on first chip write: ${chipNames}`,
      data: { advisory: true, deposited: true, judgmentGatePresent: true },
    };
  }

  const remediation = formatDesignCritiqueJudgmentGatesRemediation();
  return {
    name: DESIGN_CRITIQUE_DEPOSIT_CHECK,
    status: "fail",
    detail:
      `${remediation} Also ensure closed catalog chip labels via scm:issue:design-critique-chip ` +
      `(ensure-on-write): ${chipNames}`,
    data: {
      advisory: true,
      deposited: true,
      judgmentGatePresent: false,
      remediation,
      catalogChips: [...DESIGN_CRITIQUE_CATALOG_CHIPS],
    },
  };
}
