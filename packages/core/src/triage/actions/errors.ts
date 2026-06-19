/** Validation errors for audit-log entries. */
export class CandidatesLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidatesLogError";
  }
}

/** Raised when a triage action cannot complete. */
export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageError";
  }
}

/** ``gh issue close`` failed; companion audit entry has been rolled back. */
export class UpstreamCloseError extends TriageError {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamCloseError";
  }
}

/** Resume-condition grammar parse failure. */
export class ResumeGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeGrammarError";
  }
}
