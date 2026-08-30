import type { WhichFn } from "./binary.js";
import type { ScmBinaryRole } from "./call-shape.js";

/** Windows NTSTATUS STATUS_DLL_INIT_FAILED (#3737). Unsigned and signed 32-bit. */
export const STATUS_DLL_INIT_FAILED = 0xc0000142;
const STATUS_DLL_INIT_FAILED_SIGNED = -1073741502;

export function unsignedExitStatus(status: number): number {
  return status >>> 0;
}

export function classifySpawnStatus(
  status: number | null | undefined,
  error?: { readonly message?: string; readonly code?: string },
): string {
  if (typeof status !== "number") {
    if (typeof error?.code === "string" && error.code.length > 0) {
      return error.code;
    }
    if (typeof error?.message === "string" && error.message.trim().length > 0) {
      return error.message.trim();
    }
    return "spawn-failed";
  }
  const unsigned = unsignedExitStatus(status);
  if (unsigned === STATUS_DLL_INIT_FAILED || status === STATUS_DLL_INIT_FAILED_SIGNED) {
    return "0xC0000142 STATUS_DLL_INIT_FAILED";
  }
  if (unsigned >= 0xc0000000) {
    return `0x${unsigned.toString(16).toUpperCase()}`;
  }
  return `exit ${status}`;
}

export function isAvailabilitySpawnFailure(result: {
  readonly status: number | null | undefined;
  readonly error?: { readonly message?: string; readonly code?: string };
  readonly stdout?: string;
  readonly stderr?: string;
}): boolean {
  if (result.error !== undefined) {
    return true;
  }
  if (typeof result.status !== "number") {
    return true;
  }
  const unsigned = unsignedExitStatus(result.status);
  const emptyOut =
    (result.stdout ?? "").trim().length === 0 && (result.stderr ?? "").trim().length === 0;
  return (
    emptyOut &&
    (unsigned === STATUS_DLL_INIT_FAILED || result.status === STATUS_DLL_INIT_FAILED_SIGNED)
  );
}

export function formatScmSpawnDiagnostic(
  binary: string,
  status: number | null | undefined,
  stderr: string,
  error?: { readonly message?: string; readonly code?: string },
): string {
  const cls = classifySpawnStatus(status, error);
  const err = stderr.trim();
  if (err.length > 0) {
    return `${binary} failed (${cls}): ${err}`;
  }
  return `${binary} failed (${cls}); stderr empty`;
}

/** Return `gh` when a cached-get ghx spawn failed and live gh is on PATH. */
export function ghxSpawnFallbackBinary(
  role: ScmBinaryRole,
  invoked: string,
  whichFn: WhichFn,
  failure: {
    readonly status: number | null | undefined;
    readonly error?: { readonly message?: string; readonly code?: string };
    readonly stdout?: string;
    readonly stderr?: string;
  },
): string | null {
  if (role !== "cached-get" || invoked !== "ghx" || whichFn("gh") === null) {
    return null;
  }
  return isAvailabilitySpawnFailure(failure) ? "gh" : null;
}
