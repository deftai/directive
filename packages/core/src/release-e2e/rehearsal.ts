import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REHEARSAL_VERSION } from "./constants.js";
import { dispatchTaskRelease, dispatchTaskReleaseRollback } from "./entrypoint.js";
import { emit } from "./flags.js";
import { verifyDraftRelease } from "./gh-ops.js";
import { cloneRepoToTemp, pushMirror, setOriginToTempRepo, verifyTag } from "./git-ops.js";
import type { E2ESeams } from "./types.js";

export function runRehearsal(
  owner: string,
  slug: string,
  projectRoot: string,
  version: string = REHEARSAL_VERSION,
  seams: E2ESeams = {},
): [boolean, string] {
  const repoFull = `${owner}/${slug}`;
  const mkdtemp = seams.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const rmTemp = seams.rmTemp ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const tmpdirPath = mkdtemp("deft-e2e-");
  const cloneDir = join(tmpdirPath, "clone");

  try {
    const steps: Array<[string, () => [boolean, string]]> = [
      ["clone", () => cloneRepoToTemp(projectRoot, cloneDir, seams)],
      ["set-origin", () => setOriginToTempRepo(cloneDir, owner, slug, seams)],
      ["push-mirror", () => pushMirror(cloneDir, seams)],
      ["task release", () => dispatchTaskRelease(cloneDir, version, repoFull, seams)],
      ["verify draft", () => verifyDraftRelease(owner, slug, version, seams)],
      ["verify tag", () => verifyTag(cloneDir, version, seams)],
      [
        "task release:rollback",
        () => dispatchTaskReleaseRollback(cloneDir, version, repoFull, seams),
      ],
    ];

    for (const [label, step] of steps) {
      const [ok, reason] = step();
      emit(`  rehearsal step: ${label}`, `${ok ? "OK" : "FAIL"} (${reason})`);
      if (!ok) {
        return [false, `${label}: ${reason}`];
      }
    }

    return [
      true,
      `pipeline-mirror rehearsal succeeded against ${repoFull} ` +
        "(7 steps; clone -> push heads+tags -> task release -> verify -> rollback)",
    ];
  } finally {
    rmTemp(tmpdirPath);
  }
}
