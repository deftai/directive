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

export interface IssueIngest {
  ingestSingleForAccept(
    issueNumber: number,
    repo: string,
    options?: { projectRoot?: string },
  ): void;
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
