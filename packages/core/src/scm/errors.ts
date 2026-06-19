/** Raised on argv-validation or binary-resolution failures. */
export class ScmStubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmStubError";
  }
}
