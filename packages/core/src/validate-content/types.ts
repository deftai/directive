export type OutputStream = "stdout" | "stderr" | "none";

/** Three-state gate result mirroring the Python verify/validate gates. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
}
