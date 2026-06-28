/** CLI wrapper for project:export-spec (#2013 / #1502). */
import { exportSpecMain } from "@deftai/directive-core/render";

export async function runExportSpecCli(argv: readonly string[]): Promise<number> {
  return exportSpecMain(argv);
}
