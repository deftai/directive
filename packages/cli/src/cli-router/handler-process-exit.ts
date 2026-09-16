/**
 * In-process CLI test seam: honor handler process.exit(code) as that code.
 * dispatch must not reclassify this as a generic dispatch error (2).
 */

export class HandlerProcessExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${String(code)})`);
    this.name = "HandlerProcessExit";
    this.code = code;
  }
}

export function isHandlerProcessExit(err: unknown): err is HandlerProcessExit {
  return err instanceof HandlerProcessExit;
}
