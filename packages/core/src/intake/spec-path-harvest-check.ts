/**
 * Spec-path harvest check that does not depend on a slice label (#7001).
 *
 * Ingest harvests a Spec-path lean's Bound remedy and Acceptance Criteria rows
 * (`harvestSpecPathLean`). The completed-arc reader runs the same check before
 * the record, so path-1, the ingest-ready chip and intake refuse a lean ingest
 * cannot harvest, with one reason. Refusals that depend on the selected slice
 * label stay at ingest. This module imports neither caller, so both can use it.
 */
import { scan } from "../cache/scanner.js";
import {
  type CheckboxItem,
  extractLeanConstraintLines,
  type LeanSlices,
  parseLeanSlices,
  parseListItemsByPositionFolded,
  sliceBoundRemedySection,
  sliceLeanAcceptanceCriteriaSection,
  stripFencedCodeBlocks,
} from "./markdown-scanners.js";

/** Refusal for a lean with no Bound remedy list (ingest matches this text). */
export const SPEC_PATH_EMPTY_BOUND_REMEDY_REASON = "cited successor lean has no Bound-remedy list";

/** The rows and sections a Spec-path harvest reads from one lean body. */
export interface SpecPathLeanStructure {
  /** Bound remedy slice text, or "" when the heading is absent. */
  readonly boundSourceText: string;
  /** Acceptance Criteria slice text, or null when the heading is absent. */
  readonly acceptanceSourceText: string | null;
  /** Bound remedy items by list position, continuation lines folded. */
  readonly boundRows: readonly CheckboxItem[];
  /** Acceptance Criteria items by list position, continuation lines folded. */
  readonly acceptanceRows: readonly CheckboxItem[];
  /** Reject / Not proposed list lines of the lean (#6265). */
  readonly constraintLines: readonly string[];
  readonly slices: LeanSlices;
}

/** Read the harvest structure of a lean; never refuses (#7001). */
export function readSpecPathLeanStructure(leanBody: string): SpecPathLeanStructure {
  const boundSourceText = sliceBoundRemedySection(leanBody) ?? "";
  const acceptanceSourceText = sliceLeanAcceptanceCriteriaSection(leanBody);
  return {
    boundSourceText,
    acceptanceSourceText,
    boundRows: parseListItemsByPositionFolded(stripFencedCodeBlocks(boundSourceText)),
    acceptanceRows:
      acceptanceSourceText === null
        ? []
        : parseListItemsByPositionFolded(stripFencedCodeBlocks(acceptanceSourceText)),
    constraintLines: extractLeanConstraintLines(leanBody),
    slices: parseLeanSlices(leanBody),
  };
}

function hasScannerHardFail(text: string): boolean {
  return scan(text).flags.some((flag) => flag.severity === "hard-fail");
}

/**
 * First harvest refusal of a Spec-path lean that does not depend on a slice
 * label (#7001 item 5), or null: an empty Bound remedy list; a Slices section
 * error; a slice reference out of range or assigned twice; or a quarantine
 * hard-fail on a harvested row title, the Bound remedy or Acceptance Criteria
 * text, or the rendered Reject / Not proposed lines ingest scans.
 */
export function specPathLeanHarvestRefusal(leanBody: string): string | null {
  const lean = readSpecPathLeanStructure(leanBody);
  if (lean.boundRows.length === 0) {
    return SPEC_PATH_EMPTY_BOUND_REMEDY_REASON;
  }
  if (lean.slices.present) {
    if (lean.slices.errors.length > 0) {
      return `cited lean Slices section: ${lean.slices.errors.join("; ")}`;
    }
    const labelOf = new Map<string, string>();
    for (const assignment of lean.slices.assignments) {
      for (const ref of assignment.refs) {
        const size = ref.list === "B" ? lean.boundRows.length : lean.acceptanceRows.length;
        const key = `${ref.list}${ref.index}`;
        if (ref.index > size) {
          return `cited lean Slices section: slice '${assignment.label}' names ${key}, which is not a harvested item`;
        }
        const prior = labelOf.get(key);
        if (prior !== undefined) {
          return `cited lean Slices section: ${key} is assigned to both '${prior}' and '${assignment.label}'`;
        }
        labelOf.set(key, assignment.label);
      }
    }
  }
  if ([...lean.boundRows, ...lean.acceptanceRows].some((row) => hasScannerHardFail(row.title))) {
    return "quarantine scanner hard-fail on a harvested lean item";
  }
  if (hasScannerHardFail(lean.boundSourceText)) {
    return "quarantine scanner hard-fail on the cited lean's Bound remedy text";
  }
  if (lean.acceptanceSourceText !== null && hasScannerHardFail(lean.acceptanceSourceText)) {
    return "quarantine scanner hard-fail on the cited lean's Acceptance Criteria text";
  }
  if (
    lean.constraintLines.length > 0 &&
    hasScannerHardFail(lean.constraintLines.map((line) => `- ${line}`).join("\n"))
  ) {
    return "quarantine scanner hard-fail on the cited lean's Reject / Not proposed lines";
  }
  return null;
}
