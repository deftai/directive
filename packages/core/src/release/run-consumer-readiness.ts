/**
 * Release pre-flight consumer-readiness: check 4 fail-closed, checks 5-6 disclosure (#3900).
 */
import {
  evaluateConsumerHardStopCensus,
  type HardStopIssue,
  issueFromInventoryRow,
  parseClosesSet,
} from "./consumer-hard-stops.js";
import { formatConsumerReadinessDisclosure } from "./consumer-readiness-disclosure.js";

export interface ConsumerReadinessInput {
  readonly changelogText: string;
  readonly issues: readonly HardStopIssue[];
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
    disclosure: formatConsumerReadinessDisclosure(input.changelogText),
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
