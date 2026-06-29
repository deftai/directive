import { cmdRollback } from "../release-rollback/main.js";

/** Native TypeScript release rollback (#1860). */
export function rollbackMain(argv: string[]): number {
  return cmdRollback(argv);
}
