/**
 * Release pre-flight consumer-readiness: check 4 fail-closed, checks 5-6 disclosure (#3900).
 */
import {
  evaluateConsumerHardStopCensus,
  type HardStopIssue,
  issueFromInventoryRow,
  parseClosesSet,
} from "./consumer-hard-stops.js";
import {
  type ConsumerReadinessDisclosureOptions,
  formatConsumerReadinessDisclosure,
} from "./consumer-readiness-disclosure.js";

export interface ConsumerReadinessInput {
  /** Effective changelog text (`effectiveChangelogText`, #6314). */
  readonly changelogText: string;
  readonly issues: readonly HardStopIssue[];
  /** Check 5 census inputs (#6281); default is the working directory's previous release tag. */
  readonly disclosureOptions?: ConsumerReadinessDisclosureOptions;
}

export function evaluateReleaseConsumerReadiness(input: ConsumerReadinessInput): {
  readonly hardStops: ReturnType<typeof evaluateConsumerHardStopCensus>;
  readonly disclosure: ReturnType<typeof formatConsumerReadinessDisclosure>;
} {
  return {
    hardStops: evaluateConsumerHardStopCensus({
      issues: input.issues,
      closesSet: parseClosesSet(input.changelogText),
    }),
    disclosure: formatConsumerReadinessDisclosure(input.changelogText, input.disclosureOptions),
  };
}

export function issuesFromInventory(rows: readonly Record<string, unknown>[]): HardStopIssue[] {
  const issues: HardStopIssue[] = [];
  for (const row of rows) {
    const issue = issueFromInventoryRow(row);
    if (issue !== null) issues.push(issue);
  }
  return issues;
}
