/** One audit-log row matching ``vbrief/schemas/candidates.schema.json``. */
export interface AuditEntry {
  decision_id: string;
  timestamp: string;
  repo: string;
  issue_number: number;
  decision: string;
  actor: string;
  reason?: string;
  linked_to?: number;
  prior_decision_id?: string;
  resume_on?: string;
}

export interface CandidatesLog {
  append(entry: AuditEntry, options?: { path?: string }): string;
  latestDecision(issueNumber: number, repo: string, options?: { path?: string }): AuditEntry | null;
  newDecisionId(): string;
}

/** Structured accept-ingest outcome (#4962 Prefer-A Bound). */
export interface AcceptIngestResult {
  result: "created" | "duplicate" | "refused" | "dryrun";
  path: string | null;
  message: string;
}

export interface IssueIngest {
  /**
   * Ingest issue into proposed/; return structured created|duplicate|refused (#4962).
   * Legacy absolute-path / null returns remain accepted for tests.
   */
  ingestSingleForAccept(
    issueNumber: number,
    repo: string,
    options?: { projectRoot?: string },
  ): AcceptIngestResult | string | null | undefined;
}

/** Accept command outcome threaded into formatAcceptOutput (#4962). */
export interface AcceptOutcome {
  decisionId: string | null;
  disposition: "created" | "duplicate" | "refused" | "idempotent";
  relativePath: string | null;
  ingestMessage: string | null;
}

export interface ScmRunner {
  call(
    source: string,
    verb: string,
    args: readonly string[],
    options?: { check?: boolean },
  ): { returncode: number; stdout: string; stderr: string };
}

export interface TriageActionsDeps {
  candidatesLog: CandidatesLog;
  issueIngest: IssueIngest;
  scm: ScmRunner;
  nowIso?: () => string;
  stderr?: (message: string) => void;
}

export interface AcceptOptions {
  actor?: string | null;
  projectRoot?: string;
  /** After accept+ingest, promote proposed → pending (#1136). */
  autoPromote?: boolean;
  /** WIP-cap override for the auto-promote leg. */
  force?: boolean;
}

export interface RejectOptions {
  actor?: string | null;
  projectRoot?: string;
}

export interface DeferOptions {
  actor?: string | null;
  resumeOn?: string | null;
  projectRoot?: string;
}
