/**
 * Check 4 -- consumer hard-stop census (#3900 / #3713).
 *
 * Enumerates open issues by title classification and label only.
 * BLOCKER is the sole permitted consumer title classification.
 * The adoption-blocker label is never derived from a title.
 * Issue bodies are not read into the verdict.
 */

export const CONSUMER_HARD_STOP_TITLE_RE = /^BLOCKER\b/i;
export const ADOPTION_BLOCKER_LABEL = "adoption-blocker";

const REMEDIATION =
  "Recovery: close those issues in this cut (or list them in the Unreleased Closes set). Title classification is BLOCKER only; do not derive adoption-blocker from a title (#3713 / #3900).";

export interface HardStopIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
}

export interface HardStopCensusEntry {
  readonly number: number;
  readonly title: string;
  readonly viaTitle: boolean;
  readonly viaLabel: boolean;
}

export interface HardStopCensusResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly matches: readonly HardStopCensusEntry[];
  readonly shipsPast: readonly HardStopCensusEntry[];
}

function labelsOf(issue: HardStopIssue): string[] {
  return issue.labels.map((label) => label.trim()).filter((label) => label.length > 0);
}

/** Title and labels only. Never inspect a body field. */
export function classifyHardStop(issue: HardStopIssue): HardStopCensusEntry | null {
  const viaTitle = CONSUMER_HARD_STOP_TITLE_RE.test(issue.title.trim());
  const viaLabel = labelsOf(issue).some((label) => label === ADOPTION_BLOCKER_LABEL);
  if (!viaTitle && !viaLabel) {
    return null;
  }
  return { number: issue.number, title: issue.title, viaTitle, viaLabel };
}

export function enumerateConsumerHardStops(
  issues: readonly HardStopIssue[],
): HardStopCensusEntry[] {
  const out: HardStopCensusEntry[] = [];
  for (const issue of issues) {
    const match = classifyHardStop(issue);
    if (match !== null) {
      out.push(match);
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Extract Closes/Fixes/Resolves #N from changelog Unreleased text. Never from issue bodies. */
export function parseClosesSet(changelogText: string): Set<number> {
  const after = changelogText.split(/^## \[Unreleased\]\s*$/m)[1] ?? "";
  const unreleased = after.split(/^## \[/m)[0] ?? after;
  const found = new Set<number>();
  const re = /\b(?:Closes|Fixes|Resolves)\s+#(\d+)/gi;
  let match: RegExpExecArray | null = re.exec(unreleased);
  while (match !== null) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) {
      found.add(n);
    }
    match = re.exec(unreleased);
  }
  return found;
}

export function evaluateConsumerHardStopCensus(options: {
  readonly issues: readonly HardStopIssue[];
  readonly closesSet: ReadonlySet<number>;
}): HardStopCensusResult {
  const matches = enumerateConsumerHardStops(options.issues);
  const shipsPast = matches.filter((entry) => !options.closesSet.has(entry.number));
  if (matches.length === 0) {
    return {
      code: 0,
      message: "Consumer hard-stops: ok -- no open BLOCKER titles or adoption-blocker labels.",
      stream: "stdout",
      matches,
      shipsPast,
    };
  }
  if (shipsPast.length === 0) {
    return {
      code: 0,
      message:
        "Consumer hard-stops: ok -- " +
        String(matches.length) +
        " open hard-stop(s) are in this cut Closes set.",
      stream: "stdout",
      matches,
      shipsPast,
    };
  }
  const sample = shipsPast
    .slice(0, 8)
    .map((entry) => "#" + String(entry.number))
    .join(", ");
  return {
    code: 1,
    message:
      "Consumer hard-stops: fail -- " +
      String(shipsPast.length) +
      " open hard-stop(s) not in this cut Closes set: " +
      sample +
      ". " +
      REMEDIATION,
    stream: "stderr",
    matches,
    shipsPast,
  };
}

export function issueFromInventoryRow(row: Record<string, unknown>): HardStopIssue | null {
  const number = row.number;
  const title = row.title;
  if (typeof number !== "number" || !Number.isInteger(number) || typeof title !== "string") {
    return null;
  }
  if ("pull_request" in row) {
    return null;
  }
  const labelsRaw = row.labels;
  const labels: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const item of labelsRaw) {
      if (typeof item === "string") {
        labels.push(item);
      } else if (item !== null && typeof item === "object" && "name" in item) {
        const name = (item as { name?: unknown }).name;
        if (typeof name === "string") {
          labels.push(name);
        }
      }
    }
  }
  return { number, title, labels };
}
