/**
 * Checks 5 and 6 -- operator disclosure at the release decision point (#3900).
 *
 * New-refusal census and net-posture are judgments. They are printed for the
 * operator and never fail-closed, never dressed as a computed verdict.
 */

const FAIL_CLOSED_HINT =
  /fail-closed|fail closed|refuses? to|MUST NOT|must not|blocks? (?:the )?(?:tag|cut|release)|new refusal/i;

export interface RefusalHint {
  readonly line: number;
  readonly excerpt: string;
}

export interface ConsumerReadinessDisclosure {
  readonly blocking: false;
  readonly newRefusalHints: readonly RefusalHint[];
  readonly text: string;
}

function unreleasedSection(changelogText: string): string {
  const rest = changelogText.split(/^## \[Unreleased\]\s*$/m)[1];
  if (rest === undefined) {
    return "";
  }
  const next = rest.split(/^## \[/m)[0] ?? rest;
  return next;
}

export function collectNewRefusalHints(changelogText: string): RefusalHint[] {
  const section = unreleasedSection(changelogText);
  const hints: RefusalHint[] = [];
  const lines = section.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (FAIL_CLOSED_HINT.test(line)) {
      hints.push({ line: i + 1, excerpt: line.trim().slice(0, 160) });
    }
  }
  return hints;
}

export function formatConsumerReadinessDisclosure(
  changelogText: string,
): ConsumerReadinessDisclosure {
  const hints = collectNewRefusalHints(changelogText);
  const lines = [
    "Consumer-readiness disclosure (does not block the tag) -- #3900 checks 5 and 6.",
    "",
    "Check 5 -- new-refusal census (operator judgment):",
  ];
  if (hints.length === 0) {
    lines.push("  No Unreleased lines matched fail-closed / new-refusal hints.");
  } else {
    lines.push("  Unreleased lines that may introduce a consumer-visible refusal:");
    for (const hint of hints.slice(0, 20)) {
      lines.push("  - " + hint.excerpt);
    }
  }
  lines.push(
    "  Each new refusal needs remediation text and an escape hatch. This is not a computed verdict.",
  );
  lines.push("");
  lines.push("Check 6 -- net-posture (operator judgment):");
  lines.push(
    "  Does this candidate fix more consumer-visible breakage than it introduces, and on which surfaces?",
  );
  lines.push(
    "  Holding a release is only correct when that answer is negative. The operator decides.",
  );
  return { blocking: false, newRefusalHints: hints, text: lines.join("\n") };
}
