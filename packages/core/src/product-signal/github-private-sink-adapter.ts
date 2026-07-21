import {
  GhRestError,
  type GhRestSeams,
  restCreateIssue,
  restIssueListPaginated,
  restPostComment,
  restUpdateIssue,
} from "../scm/gh-rest.js";
import { normalizeActorKey } from "./actor-name.js";
import { classifySinkError } from "./gates.js";
import type { ProductSignalPayload, ProductSignalSurface } from "./payload.js";
import type { SubmitAdapter, SubmitResult } from "./submit-adapter.js";

export const PRODUCT_SIGNAL_MARKER_PREFIX = "<!-- deft:product-signal v1";

export const SURFACE_LABELS: Record<ProductSignalSurface, string> = {
  pulse: "surface:pulse",
  portrait: "surface:portrait",
};

/** Build HTML comment marker for standing-thread lookup (#2693 D8). */
export function buildThreadMarker(
  installId: string,
  actorName: string,
  surface: ProductSignalSurface,
): string {
  return (
    `${PRODUCT_SIGNAL_MARKER_PREFIX} ` +
    `installId=${installId} actorKey=${normalizeActorKey(actorName)} surface=${surface} -->`
  );
}

function npsLabels(nps: number | null): readonly string[] {
  if (nps === null) {
    return ["nps:none"];
  }
  if (nps >= 9) {
    return ["nps:promoter"];
  }
  if (nps >= 7) {
    return ["nps:passive"];
  }
  return ["nps:detractor"];
}

function directiveVersionLabel(version: string): string {
  const match = version.match(/^(\d+\.\d+)/);
  const minor = match?.[1] ?? "0.0";
  return `directive:${minor}`;
}

function formatPayloadBody(payload: ProductSignalPayload): string {
  const marker = buildThreadMarker(payload.installId, payload.actorName, payload.surface);
  const humanLines: string[] = [];
  if (payload.human.nps !== null) {
    humanLines.push(`- NPS: ${payload.human.nps}`);
  }
  for (const answer of payload.human.answers) {
    humanLines.push(`- **${answer.q}**: ${answer.a}`);
  }
  if (payload.human.freeText !== null && payload.human.freeText.trim().length > 0) {
    humanLines.push(`- Free text: ${payload.human.freeText.trim()}`);
  }
  const summaryJson =
    payload.localSignalSummary !== null
      ? `\n<details><summary>localSignalSummary</summary>\n\n\`\`\`json\n${JSON.stringify(payload.localSignalSummary, null, 2)}\n\`\`\`\n</details>\n`
      : "";
  const skillsJson =
    payload.skillsSummary !== null
      ? `\n<details><summary>skillsSummary</summary>\n\n\`\`\`json\n${JSON.stringify(payload.skillsSummary, null, 2)}\n\`\`\`\n</details>\n`
      : "";
  return [
    marker,
    "",
    `## ${payload.surface === "portrait" ? "Portrait" : "Pulse"} — ${payload.actorName}`,
    "",
    `- installId: \`${payload.installId}\``,
    `- actorNameSource: ${payload.actorNameSource}`,
    `- directive: ${payload.directiveVersion}`,
    `- harness: ${payload.harness}${payload.harnessVersion ? ` (${payload.harnessVersion})` : ""}`,
    `- os: ${payload.os} / shell: ${payload.shell}`,
    `- collectedAt: ${payload.collectedAt}`,
    "",
    "### Human",
    "",
    humanLines.length > 0 ? humanLines.join("\n") : "_(no human answers)_",
    payload.agentNotes ? `\n### Agent notes\n\n${payload.agentNotes}` : "",
    summaryJson,
    skillsJson,
    "",
    "_Submitted via product-signal (Refs #2693)._",
    "",
  ].join("\n");
}

function formatPulseComment(payload: ProductSignalPayload): string {
  const date = payload.collectedAt.slice(0, 10);
  const humanLines: string[] = [];
  if (payload.human.nps !== null) {
    humanLines.push(`NPS ${payload.human.nps}`);
  }
  for (const answer of payload.human.answers) {
    humanLines.push(`${answer.q}: ${answer.a}`);
  }
  if (payload.human.freeText) {
    humanLines.push(payload.human.freeText);
  }
  return [`**Pulse ${date}**`, "", ...humanLines, ""].join("\n");
}

function findStandingIssue(
  repo: string,
  installId: string,
  actorName: string,
  surface: ProductSignalSurface,
  seams: GhRestSeams,
): Record<string, unknown> | null {
  const needleKey = normalizeActorKey(actorName);
  const markerNeedle = `installId=${installId} actorKey=${needleKey} surface=${surface}`;
  const issues = restIssueListPaginated(
    repo,
    { state: "open", labels: [SURFACE_LABELS[surface]], limit: 200 },
    seams,
  );
  for (const issue of issues) {
    const body = typeof issue.body === "string" ? issue.body : "";
    if (body.includes(markerNeedle)) {
      return issue;
    }
  }
  return null;
}

function issueUrlFromRecord(issue: Record<string, unknown>): string | null {
  const url = issue.html_url;
  return typeof url === "string" ? url : null;
}

function issueNumberFromRecord(issue: Record<string, unknown>): number | null {
  const num = issue.number;
  return typeof num === "number" ? num : null;
}

export interface GitHubPrivateSinkAdapterOptions {
  readonly sinkRepo: string;
  readonly seams?: GhRestSeams;
}

/** Phase-1 GitHub private sink adapter (#2693 D5/D8). */
export class GitHubPrivateSinkAdapter implements SubmitAdapter {
  readonly id = "github-private-sink";
  private readonly repo: string;
  private readonly seams: GhRestSeams;

  constructor(options: GitHubPrivateSinkAdapterOptions) {
    this.repo = options.sinkRepo;
    this.seams = options.seams ?? {};
  }

  async submit(payload: ProductSignalPayload): Promise<SubmitResult> {
    try {
      const labels = [
        SURFACE_LABELS[payload.surface],
        ...npsLabels(payload.human.nps),
        directiveVersionLabel(payload.directiveVersion),
      ];
      if (payload.surface === "portrait") {
        return this.submitPortrait(payload, labels);
      }
      return this.submitPulse(payload, labels);
    } catch (err: unknown) {
      if (err instanceof GhRestError) {
        const outcome = classifySinkError(err.stderr, err.exitCode);
        return {
          outcome,
          message: `product-signal soft-skip (${outcome}): ${err.stderr || err.message}`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        outcome: "sink-unreachable",
        message: `product-signal soft-skip (sink-unreachable): ${message}`,
      };
    }
  }

  private submitPortrait(payload: ProductSignalPayload, labels: readonly string[]): SubmitResult {
    const body = formatPayloadBody(payload);
    const title = `[portrait] ${payload.actorName} @ ${payload.installId.slice(0, 8)}`;
    const existing = findStandingIssue(
      this.repo,
      payload.installId,
      payload.actorName,
      "portrait",
      this.seams,
    );
    if (existing !== null) {
      const num = issueNumberFromRecord(existing);
      if (num === null) {
        return { outcome: "sink-unreachable", message: "standing portrait issue missing number" };
      }
      const updated = restUpdateIssue(this.repo, num, { body, labels: [...labels] }, this.seams);
      return {
        outcome: "submitted",
        issueUrl: issueUrlFromRecord(updated),
        issueNumber: issueNumberFromRecord(updated),
        message: `portrait upserted on #${num}`,
      };
    }
    const created = restCreateIssue(this.repo, title, body, labels, this.seams);
    return {
      outcome: "submitted",
      issueUrl: issueUrlFromRecord(created),
      issueNumber: issueNumberFromRecord(created),
      message: "portrait standing issue created",
    };
  }

  private submitPulse(payload: ProductSignalPayload, labels: readonly string[]): SubmitResult {
    const existing = findStandingIssue(
      this.repo,
      payload.installId,
      payload.actorName,
      "pulse",
      this.seams,
    );
    let issueNumber: number | null;
    let issueUrl: string | null;
    if (existing === null) {
      const title = `[pulse] ${payload.actorName} @ ${payload.installId.slice(0, 8)}`;
      const body = formatPayloadBody(payload);
      const created = restCreateIssue(this.repo, title, body, labels, this.seams);
      issueNumber = issueNumberFromRecord(created);
      issueUrl = issueUrlFromRecord(created);
    } else {
      issueNumber = issueNumberFromRecord(existing);
      issueUrl = issueUrlFromRecord(existing);
      if (issueNumber !== null) {
        restUpdateIssue(this.repo, issueNumber, { labels: [...labels] }, this.seams);
      }
    }
    if (issueNumber === null) {
      return { outcome: "sink-unreachable", message: "pulse standing issue missing number" };
    }
    restPostComment(this.repo, issueNumber, formatPulseComment(payload), this.seams);
    return {
      outcome: "submitted",
      issueUrl,
      issueNumber,
      message: `pulse comment appended on #${issueNumber}`,
    };
  }
}

/** Append a Gap: comment on the standing pulse thread (#2693 D19). */
export function appendGapComment(
  options: GitHubPrivateSinkAdapterOptions & {
    readonly installId: string;
    readonly actorName: string;
    readonly gapText: string;
    readonly collectedAt?: string;
  },
): SubmitResult {
  const seams = options.seams ?? {};
  try {
    const existing = findStandingIssue(
      options.sinkRepo,
      options.installId,
      options.actorName,
      "pulse",
      seams,
    );
    if (existing === null) {
      return {
        outcome: "sink-unreachable",
        message: "no standing pulse issue for gap comment",
      };
    }
    const num = issueNumberFromRecord(existing);
    if (num === null) {
      return { outcome: "sink-unreachable", message: "pulse issue missing number" };
    }
    const date = (options.collectedAt ?? new Date().toISOString()).slice(0, 10);
    const body = `**Gap ${date}**\n\nGap: ${options.gapText.trim()}\n`;
    restPostComment(options.sinkRepo, num, body, seams);
    restUpdateIssue(options.sinkRepo, num, { labels: ["signal:gap"] }, seams);
    return {
      outcome: "submitted",
      issueUrl: issueUrlFromRecord(existing),
      issueNumber: num,
      message: `gap comment appended on pulse #${num}`,
    };
  } catch (err: unknown) {
    if (err instanceof GhRestError) {
      const outcome = classifySinkError(err.stderr, err.exitCode);
      return {
        outcome,
        message: `gap comment soft-skip (${outcome}): ${err.stderr || err.message}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "sink-unreachable", message };
  }
}
