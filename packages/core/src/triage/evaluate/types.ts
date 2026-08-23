/** Stage A issue-eval types (#3648). */

export const DEFAULT_CONCURRENCY = 4;
export const ORIGIN_MASTER = "origin/master";
export const SHA12_LENGTH = 12;
export const CRITIQUE_RECOMMEND_FIELD = "critique-recommend";
export const RESERVED_CLEARANCE_RE =
  /design-critique:\s*(?:warranted|not warranted)(?:\s*\|\s*(?:warranted|not warranted))?\s*,\s*because/iu;

export const VALIDITY_STATES = [
  "still-open",
  "partial",
  "likely-shipped",
  "needs-re-scope",
] as const;

export type ValidityState = (typeof VALIDITY_STATES)[number];

export interface ValidityVerdict {
  readonly state: ValidityState;
  readonly evidence: string;
  readonly worktreePath: string;
  readonly sessionStartReadOnly: true;
}

export interface WipHit {
  readonly kind: "active-xbrief" | "pending-xbrief" | "plan-sequence";
  readonly path: string;
  readonly issue: number;
}

export interface WipCensus {
  readonly active: readonly WipHit[];
  readonly pending: readonly WipHit[];
  readonly planSequence: readonly WipHit[];
}

export interface GithubIssueSnapshot {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly htmlUrl: string | null;
  readonly pullRequest: boolean;
  readonly duplicateOf: number | null;
}

export interface GithubPullSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly htmlUrl: string | null;
  readonly mentions: readonly number[];
}

export interface GithubCensus {
  readonly issues: Readonly<Record<number, GithubIssueSnapshot>>;
  readonly openIssues: readonly GithubIssueSnapshot[];
  readonly openPulls: readonly GithubPullSnapshot[];
}

export interface ValueAdvice {
  readonly [CRITIQUE_RECOMMEND_FIELD]: boolean;
  readonly reason: string;
}

export interface IssueEvalVerdict {
  readonly issue: number;
  readonly sha12: string;
  readonly invocationId: string;
  readonly validity: ValidityVerdict | null;
  readonly wip: readonly WipHit[];
  readonly github: GithubIssueSnapshot | null;
  readonly openPulls: readonly GithubPullSnapshot[];
  readonly duplicates: readonly number[];
  readonly value: ValueAdvice;
  readonly error: string | null;
}

export interface EvaluateResult {
  readonly sha12: string;
  readonly invocationId: string;
  readonly originSha: string;
  readonly sinkDir: string;
  readonly concurrency: number;
  readonly verdicts: readonly IssueEvalVerdict[];
}

export interface GitRunnerResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => GitRunnerResult;

export type SessionStartFn = (worktreePath: string) => void;

export type GithubReader = {
  readonly viewIssue: (repo: string, n: number) => GithubIssueSnapshot;
  readonly listOpenIssues: (repo: string) => readonly GithubIssueSnapshot[];
  readonly listOpenPulls: (repo: string) => readonly GithubPullSnapshot[];
};

export interface EvaluateOptions {
  readonly projectRoot: string;
  readonly repo: string;
  readonly issues: readonly number[];
  readonly concurrency?: number;
  readonly invocationId?: string;
  readonly git?: GitRunner;
  readonly sessionStart?: SessionStartFn;
  readonly github?: GithubReader;
}
