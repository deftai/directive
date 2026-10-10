/**
 * Shared helpers for lifecycle CLI retarget specs (#1838 s3).
 */
import { type DispatchIo, dispatch } from "../dispatch.js";

export interface CapturedDispatch {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Invoke the unified deft-ts dispatcher with captured stdout/stderr. */
export async function runDispatch(argv: readonly string[]): Promise<CapturedDispatch> {
  const out: string[] = [];
  const err: string[] = [];
  const io: DispatchIo = {
    writeOut: (text) => {
      out.push(text);
    },
    writeErr: (text) => {
      err.push(text);
    },
  };
  const exitCode = await dispatch([...argv], io);
  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}
