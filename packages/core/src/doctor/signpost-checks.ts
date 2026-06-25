import { type CheckSeams, checkCanonicalVendoredNpmSignpost, checkLegacyLayout } from "./checks.js";
import type { OutputSink } from "./output.js";
import { runningInsideDeftRepo } from "./paths.js";
import type { Finding } from "./types.js";

export interface LocalSignpostSeams extends CheckSeams {
  readonly runningInsideDeftRepo?: (root: string) => boolean;
}

/** Lightweight, local-only signpost probes for the throttle-skip path (#1997). */
export function runLocalSignpostChecks(
  projectRoot: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  seams: LocalSignpostSeams = {},
): void {
  const insideDeft =
    seams.runningInsideDeftRepo?.(projectRoot) ?? runningInsideDeftRepo(projectRoot, seams);
  if (insideDeft) {
    return;
  }
  for (const result of [
    checkLegacyLayout(projectRoot, seams),
    checkCanonicalVendoredNpmSignpost(projectRoot, seams),
  ]) {
    if (result.status === "skip") {
      continue;
    }
    if (result.status === "fail") {
      sink.warn(result.detail);
      addFinding({
        severity: "warning",
        message: result.detail,
        check: result.name,
        status: result.status,
        data: result.data ?? {},
      });
    }
  }
}
