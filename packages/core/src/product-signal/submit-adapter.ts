import type { ProductSignalOutcome } from "./gates.js";
import type { ProductSignalPayload } from "./payload.js";

export interface SubmitResult {
  readonly outcome: ProductSignalOutcome;
  readonly issueUrl?: string | null;
  readonly issueNumber?: number | null;
  readonly message: string;
}

/** Transport-pluggable submit seam (#2693 D5). */
export interface SubmitAdapter {
  readonly id: string;
  submit(payload: ProductSignalPayload): Promise<SubmitResult>;
}
