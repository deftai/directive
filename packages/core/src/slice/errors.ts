/** Raised when a record passed to write_slice fails validation. */
export class SliceRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SliceRecordError";
  }
}

/** Raised when an issue number cannot be validated via the SCM shim. */
export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueValidationError";
  }
}
