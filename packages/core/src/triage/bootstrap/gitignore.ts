import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { containedWrite } from "../../fs/contained-write.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../../fs/projection-containment.js";
import { MIGRATED_ARTIFACT_DIR, resolveLifecycleLayout } from "../../layout/resolve.js";
import {
  resolveCandidatesLogPath,
  resolveTriageCachePath,
  TRIAGE_CACHE_DIR_NAME,
  triageCacheRelPath,
} from "../cache-path.js";
import type { StepOutcome } from "./types.js";

/** POSIX-style display path for `absPath` relative to `projectRoot` (#2109). */
function evalRelDisplay(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).split(/[\\/]/).join("/");
}

export const GITIGNORE_LINE = ".deft-cache/";

export const GITIGNORE_DEFT_RUNTIME_SENTINELS: readonly string[] = [
  ".deft/ritual-state.json",
  ".deft/last-session.json",
];

/** Legacy static vbrief paths kept for tests referencing the pre-#1703 constant shape. */
export const GITIGNORE_EVAL_ENTRIES: readonly string[] = [
  "xbrief/.triage-cache/candidates.jsonl",
  "xbrief/.triage-cache/summary-history.jsonl",
  "xbrief/.triage-cache/scope-lifecycle.jsonl",
  "xbrief/.triage-cache/decompositions/",
  "xbrief/.triage-cache/doctor-state.json",
  // Per-clone session state (#3146); selective only — hybrid policy preserved.
  "xbrief/.triage-cache/staleness-tickler-state.json",
  "xbrief/.triage-cache/release-availability-state.json",
  // SCM label-mirror discovery tip throttle (#3124).
  "xbrief/.triage-cache/scm-label-mirror-discovery-state.json",
];

/** Layout-aware gitignore lines for triage working-set files (#1703). */
export function gitignoreTriageCacheEntries(projectRoot: string): readonly string[] {
  const decomp = triageCacheRelPath(projectRoot, "decompositions");
  return [
    triageCacheRelPath(projectRoot, "candidates.jsonl"),
    triageCacheRelPath(projectRoot, "summary-history.jsonl"),
    triageCacheRelPath(projectRoot, "scope-lifecycle.jsonl"),
    decomp.endsWith("/") ? decomp : `${decomp}/`,
    triageCacheRelPath(projectRoot, "doctor-state.json"),
    // Per-clone session state (#3146); selective only — hybrid policy preserved.
    triageCacheRelPath(projectRoot, "staleness-tickler-state.json"),
    triageCacheRelPath(projectRoot, "release-availability-state.json"),
    // SCM label-mirror discovery tip throttle (#3124).
    triageCacheRelPath(projectRoot, "scm-label-mirror-discovery-state.json"),
  ];
}

export function gitattributesTriageCacheGlob(projectRoot: string): string {
  let artifactDir: string;
  try {
    artifactDir = resolveLifecycleLayout(projectRoot).artifactDir;
  } catch {
    artifactDir = MIGRATED_ARTIFACT_DIR; // No layout; default to xbrief/.
  }
  return `${artifactDir}/${TRIAGE_CACHE_DIR_NAME}/*.jsonl`;
}

export const GITATTRIBUTES_EVAL_RULE = "vbrief/.triage-cache/*.jsonl  merge=union";

export const FORBIDDEN_BLANKET_EVAL_LINES: readonly string[] = [
  "vbrief/.triage-cache/",
  "vbrief/.triage-cache",
  "vbrief/.triage-cache/",
  "vbrief/.eval",
];

const DEFT_CACHE_RATIONALE =
  "\n# Triage v1 local content cache (#845, #883). Mirrors upstream\n" +
  "# issues into .deft-cache/github-issue/<owner>/<repo>/<N>/. See\n" +
  "# docs/privacy-nfr.md for the gitignore-default + opt-in-commit-cache\n" +
  "# contract. Comment this line out to opt in to committing the cache.\n";

const EVAL_ENTRIES_RATIONALE =
  "\n# vbrief/.triage-cache/ tracking governance (#1144, N4 of #1119).\n" +
  "# Hybrid policy from the Current Shape comment on #1144:\n" +
  "#   - candidates.jsonl       -> gitignored (operator-private triage\n" +
  "#                               decisions; re-derive via\n" +
  "#                               `task triage:bootstrap` on a fresh\n" +
  "#                               clone). #845 Story 2 + #915.\n" +
  "#   - summary-history.jsonl  -> gitignored (operator-private\n" +
  "#                               observability; not load-bearing for\n" +
  "#                               any decision).\n" +
  "#   - scope-lifecycle.jsonl  -> gitignored (operator-private\n" +
  "#                               scope-lifecycle audit decisions;\n" +
  "#                               D1 / #1121). Per-operator demote\n" +
  "#                               stream; sharing would conflate\n" +
  "#                               operators' demote timing across the\n" +
  "#                               team.\n" +
  "#   - decompositions/        -> gitignored (local story-decomposition\n" +
  "#                               draft scratch; generated child story\n" +
  "#                               vBRIEFs live in lifecycle folders via\n" +
  "#                               `task scope:decompose`).\n" +
  "#   - doctor-state.json      -> gitignored (per-machine `task doctor`\n" +
  "#                               throttle state gating the 24h/4h\n" +
  "#                               re-probe window; #1308 / #1464). Local\n" +
  "#                               to each clone; never committed.\n" +
  "#   - staleness-tickler-state.json -> gitignored (per-clone upgrade\n" +
  "#                               tickler throttle; #2488 / #3146).\n" +
  "#   - release-availability-state.json -> gitignored (per-clone npm\n" +
  "#                               release-availability throttle; #1692 / #3146).\n" +
  "#   - slices.jsonl           -> TRACKED (team-shared cohort records\n" +
  "#                               produced by slicing skills; see\n" +
  "#                               #1132 / D13).\n" +
  "# See vbrief/.triage-cache/README.md for the full policy + merge=union\n" +
  "# rebase note.\n";

const GITATTRIBUTES_EVAL_RATIONALE =
  "\n# Append-only JSON-lines logs under vbrief/.triage-cache/ use the union merge driver\n" +
  "# (#1144, N4 of #1119). Both branches' appended lines are concatenated on\n" +
  "# auto-merge so single-operator rebases of two append branches resolve\n" +
  "# without manual conflict surgery. Note: merge=union does NOT dedupe; see\n" +
  "# vbrief/.triage-cache/README.md for the operator-facing semantics.\n";

const EVAL_ENTRIES_RATIONALE_SENTINEL =
  "# vbrief/.triage-cache/ tracking governance (#1144, N4 of #1119).";

export const EVAL_README_BODY = `# \`vbrief/.triage-cache/\` — triage working-set files

This directory holds JSON-lines logs and scratch files that Deft triage and
slicing workflows emit. Deft configures your repo's \`.gitignore\` and
\`.gitattributes\` so some files stay local while team-shared records can be
committed.

## What lives here

| File | Committed? | Notes |
| --- | --- | --- |
| \`slices.jsonl\` | Yes | Team-shared cohort records from slicing skills. New teammates use prior cohort outputs to spot orphans and avoid re-slicing the same scope. |
| \`candidates.jsonl\` | No | Your local triage accept / defer / reject stream. Re-create on a fresh clone with \`deft triage:bootstrap\`. |
| \`summary-history.jsonl\` | No | Local history of \`deft triage:summary\` output; not required for day-to-day work. |
| \`scope-lifecycle.jsonl\` | No | Local audit trail for scope demotions (\`deft scope:demote\`). Each operator's stream stays on their machine. |
| \`decompositions/\` | No | Draft story-decomposition scratch. Produced child story xBRIEFs live in lifecycle folders via \`deft scope:decompose\`. |
| \`doctor-state.json\` | No | Per-clone throttle state for \`deft doctor\` re-probe timing. |
| \`staleness-tickler-state.json\` | No | Per-clone upgrade-tickler throttle state. |
| \`release-availability-state.json\` | No | Per-clone release-availability probe throttle state. |
| \`scm-label-mirror-discovery-state.json\` | No | Per-clone SCM label-mirror discovery tip throttle (#3124). |

Paths listed as "No" above are added to \`.gitignore\` during bootstrap; anything
not listed remains committable by default. The selective ignore entries live in
the repo-root \`.gitignore\` (\`vbrief/.triage-cache/candidates.jsonl\`,
\`vbrief/.triage-cache/summary-history.jsonl\`, \`vbrief/.triage-cache/scope-lifecycle.jsonl\`,
\`vbrief/.triage-cache/decompositions/\`, \`vbrief/.triage-cache/doctor-state.json\`,
\`vbrief/.triage-cache/staleness-tickler-state.json\`,
\`vbrief/.triage-cache/release-availability-state.json\`, and
\`vbrief/.triage-cache/scm-label-mirror-discovery-state.json\`).

## Fresh clone

If \`candidates.jsonl\` is missing, run:

\`\`\`
deft triage:bootstrap
\`\`\`

Bootstrap rebuilds the local candidates log without altering committed
\`slices.jsonl\`.

## Merge behavior for \`*.jsonl\`

The repo-root \`.gitattributes\` may declare:

\`\`\`
vbrief/.triage-cache/*.jsonl  merge=union
\`\`\`

The \`union\` merge driver concatenates both sides' appended lines on auto-merge,
so parallel append-only edits to the same JSON-lines file rebase without manual
conflict surgery. It does not dedupe semantically similar records — downstream
readers should tolerate duplicate-looking entries.

## See also

- \`.gitignore\` — selective ignore rules for operator-private files
- \`.gitattributes\` — merge driver for committed JSON-lines logs
`;

/** Layout-aware triage-cache README body for the active lifecycle tree (#2344 / #2349). */
export function generateTriageCacheReadmeBody(projectRoot: string): string {
  let artifactDir: string;
  try {
    artifactDir = resolveLifecycleLayout(projectRoot).artifactDir;
  } catch {
    artifactDir = MIGRATED_ARTIFACT_DIR; // No layout; default to xbrief/.
  }
  const triagePrefix = `${artifactDir}/${TRIAGE_CACHE_DIR_NAME}`;
  return EVAL_README_BODY.replaceAll("vbrief/.triage-cache", triagePrefix);
}

function stepOutcome(
  name: string,
  ok: boolean,
  message: string,
  details: Record<string, unknown> = {},
  error: string | null = null,
): StepOutcome {
  return { name, ok, message, error, details };
}

function containmentFailure(stepName: string, err: unknown): StepOutcome {
  const message =
    err instanceof ProjectionContainmentError
      ? err.message
      : `projection path containment refused: ${String(err)}`;
  return stepOutcome(stepName, false, message, {}, message);
}

/** Strip an inline `# ...` comment from a gitignore line. */
export function stripGitignoreInlineComment(line: string): string {
  const stripped = line.trim();
  if (stripped.length === 0) return "";
  if (stripped.startsWith("#")) return "";
  const commentIdx = stripped.indexOf("#");
  if (commentIdx === -1) return stripped;
  return stripped.slice(0, commentIdx).trimEnd();
}

function gitignoreAlreadyCovers(gitignoreText: string, line: string): boolean {
  const target = line.trim();
  return gitignoreText.split("\n").some((raw) => stripGitignoreInlineComment(raw) === target);
}

function isCommentedGitignoreLine(raw: string, gitignoreLine: string): boolean {
  const stripped = raw.trim();
  if (!stripped.startsWith("#")) return false;
  let body = stripped.slice(1);
  if (body.startsWith(" ")) body = body.slice(1);
  return body === gitignoreLine;
}

function ensureGitignoreLine(
  projectRoot: string,
  gitignorePath: string,
  line: string,
  stepName: string,
  createIfMissing: boolean,
  rationaleBlock: string,
  optInMessage: string,
): StepOutcome {
  try {
    assertProjectionContained(projectRoot, gitignorePath);
  } catch (err) {
    return containmentFailure(stepName, err);
  }

  if (!existsSync(gitignorePath)) {
    if (!createIfMissing) {
      return stepOutcome(
        stepName,
        false,
        `.gitignore not present after the prior gitignore step; ${line} not written -- re-run bootstrap to retry`,
        { created: false, appended: false, skipped: "no-gitignore" },
        "prior gitignore step did not create .gitignore",
      );
    }
    try {
      // #2980 wave D: product write sink routes through containedWrite.
      const root = resolve(projectRoot);
      containedWrite({
        root,
        target: gitignorePath,
        data: `${line}\n`,
        mode: "create",
      });
    } catch (exc) {
      return stepOutcome(stepName, false, "could not create .gitignore", {}, String(exc));
    }
    return stepOutcome(stepName, true, `created .gitignore with ${line} line`, {
      created: true,
      appended: false,
    });
  }

  let existing: string;
  try {
    existing = readFileSync(gitignorePath, { encoding: "utf8" });
  } catch (exc) {
    return stepOutcome(stepName, false, "could not read .gitignore", {}, String(exc));
  }

  const hasCommentedForm = existing.split("\n").some((raw) => isCommentedGitignoreLine(raw, line));

  if (gitignoreAlreadyCovers(existing, line)) {
    return stepOutcome(stepName, true, `${line} already in .gitignore (no-op)`, {
      created: false,
      appended: false,
      already_present: true,
    });
  }

  if (hasCommentedForm) {
    return stepOutcome(stepName, true, optInMessage, {
      created: false,
      appended: false,
      opt_in_commit: true,
    });
  }

  const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  const newContent = `${existing + suffix + rationaleBlock + line}\n`;
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: gitignorePath,
      data: newContent,
      mode: "replace",
    });
  } catch (exc) {
    return stepOutcome(stepName, false, "could not write .gitignore", {}, String(exc));
  }
  return stepOutcome(stepName, true, `appended ${line} to .gitignore`, {
    created: false,
    appended: true,
  });
}

/** Append `.deft-cache/` to `.gitignore` when absent. */
export function stepEnsureGitignoreEntry(projectRoot: string): StepOutcome {
  return ensureGitignoreLine(
    projectRoot,
    `${projectRoot}/.gitignore`,
    GITIGNORE_LINE,
    "ensure_gitignore_entry",
    true,
    DEFT_CACHE_RATIONALE,
    `${GITIGNORE_LINE} is commented out (operator has opted in to commit the cache per docs/privacy-nfr.md NFR-2; not re-adding)`,
  );
}

function formatBlanketWarning(blanketPresent: boolean): string {
  if (!blanketPresent) return "";
  return (
    " WARNING: stale blanket vbrief/.triage-cache/ line detected in .gitignore -- " +
    "remove it manually (it hides tracked slices.jsonl from git per #1251)"
  );
}

function gitattributesHasEvalMergeUnion(body: string, glob: string): boolean {
  for (const raw of body.split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0 || stripped.startsWith("#")) continue;
    const parts = stripped.split(/\s+/);
    if (parts.length === 0) continue;
    if (parts[0] !== glob) continue;
    if (parts.slice(1).includes("merge=union")) return true;
  }
  return false;
}

function ensureGitignoreSelectiveEntries(
  projectRoot: string,
  stepName: string,
  entries: readonly string[],
): StepOutcome {
  const gitignorePath = `${projectRoot}/.gitignore`;
  try {
    assertProjectionContained(projectRoot, gitignorePath);
  } catch (err) {
    return containmentFailure(stepName, err);
  }

  let existing: string;
  try {
    existing = readFileSync(gitignorePath, { encoding: "utf8" });
  } catch {
    return stepOutcome(
      stepName,
      false,
      ".gitignore not present after the prior gitignore step; selective eval entries not written -- re-run bootstrap",
      { gitignore_appended_lines: 0, skipped: "no-gitignore" },
      "prior gitignore step did not create .gitignore",
    );
  }

  const existingLines = new Set(
    existing
      .split("\n")
      .map((raw) => stripGitignoreInlineComment(raw))
      .filter((stripped) => stripped.length > 0),
  );
  const blanketPresent = FORBIDDEN_BLANKET_EVAL_LINES.some((forbidden) =>
    existingLines.has(forbidden),
  );
  const rationaleAlreadyPresent = existing.includes(EVAL_ENTRIES_RATIONALE_SENTINEL);
  const missing = entries.filter((entry) => !existingLines.has(entry));
  const blanketWarning = formatBlanketWarning(blanketPresent);

  if (missing.length === 0) {
    return stepOutcome(
      stepName,
      true,
      `all #1144 selective entries already in .gitignore (no-op)${blanketWarning}`,
      {
        gitignore_appended_lines: 0,
        gitignore_already_selective: true,
        blanket_present: blanketPresent,
      },
    );
  }

  const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
  const appendedBlock = rationaleAlreadyPresent
    ? `${missing.join("\n")}\n`
    : `${EVAL_ENTRIES_RATIONALE}${missing.join("\n")}\n`;
  const newContent = existing + suffix + appendedBlock;
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: gitignorePath,
      data: newContent,
      mode: "replace",
    });
  } catch (exc) {
    return stepOutcome(
      stepName,
      false,
      "could not write .gitignore",
      { gitignore_appended_lines: 0 },
      String(exc),
    );
  }
  const entryWord = missing.length === 1 ? "entry" : "entries";
  return stepOutcome(
    stepName,
    true,
    `appended ${missing.length} selective .gitignore ${entryWord}${blanketWarning}`,
    {
      gitignore_appended_lines: missing.length,
      gitignore_appended_entries: [...missing],
      blanket_present: blanketPresent,
      rationale_already_present: rationaleAlreadyPresent,
    },
  );
}

function ensureGitattributesMergeUnion(
  projectRoot: string,
  stepName: string,
  glob: string,
  ruleLine: string,
): StepOutcome {
  const gitattributesPath = `${projectRoot}/.gitattributes`;
  try {
    assertProjectionContained(projectRoot, gitattributesPath);
  } catch (err) {
    return containmentFailure(stepName, err);
  }

  if (existsSync(gitattributesPath)) {
    let existing: string;
    try {
      existing = readFileSync(gitattributesPath, { encoding: "utf8" });
    } catch (exc) {
      return stepOutcome(
        stepName,
        false,
        "could not read .gitattributes",
        { gitattributes_appended: false },
        String(exc),
      );
    }
    if (gitattributesHasEvalMergeUnion(existing, glob)) {
      return stepOutcome(stepName, true, `${glob} merge=union already in .gitattributes (no-op)`, {
        gitattributes_appended: false,
        gitattributes_already_present: true,
      });
    }
    const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
    const newContent = `${existing + suffix + GITATTRIBUTES_EVAL_RATIONALE + ruleLine}\n`;
    try {
      // #2980 wave D: product write sink routes through containedWrite.
      containedWrite({
        root: resolve(projectRoot),
        target: gitattributesPath,
        data: newContent,
        mode: "replace",
      });
    } catch (exc) {
      return stepOutcome(
        stepName,
        false,
        "could not write .gitattributes",
        { gitattributes_appended: false },
        String(exc),
      );
    }
    return stepOutcome(stepName, true, `appended ${glob} merge=union to .gitattributes`, {
      gitattributes_appended: true,
      gitattributes_created: false,
    });
  }

  const newContent = `${GITATTRIBUTES_EVAL_RATIONALE + ruleLine}\n`;
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: gitattributesPath,
      data: newContent,
      mode: "create",
    });
  } catch (exc) {
    return stepOutcome(
      stepName,
      false,
      "could not create .gitattributes",
      { gitattributes_appended: false },
      String(exc),
    );
  }
  return stepOutcome(stepName, true, `created .gitattributes with ${glob} merge=union`, {
    gitattributes_appended: true,
    gitattributes_created: true,
  });
}

interface EnsureEvalReadmeOptions {
  readonly projectRoot: string;
  readonly readmePath: string;
  readonly readmeRel: string;
  readonly stepName: string;
}

function ensureEvalReadme(options: EnsureEvalReadmeOptions): StepOutcome {
  const { projectRoot, readmePath, readmeRel, stepName } = options;
  try {
    assertProjectionContained(projectRoot, readmePath);
  } catch (err) {
    return containmentFailure(stepName, err);
  }

  try {
    readFileSync(readmePath, { encoding: "utf8" });
    return stepOutcome(stepName, true, `${readmeRel} already present (no-op)`, {
      readme_created: false,
      readme_already_present: true,
    });
  } catch {
    // create below
  }

  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: readmePath,
      data: generateTriageCacheReadmeBody(projectRoot),
      mode: "create",
    });
  } catch (exc) {
    return stepOutcome(
      stepName,
      false,
      `could not create ${readmePath}`,
      { readme_created: false },
      String(exc),
    );
  }
  return stepOutcome(stepName, true, `created ${readmeRel} (#1144 hybrid policy)`, {
    readme_created: true,
  });
}

/** Ensure the #1144 hybrid policy is encoded in the repo (idempotent). */
export function stepEnsureGitignoreEvalEntries(projectRoot: string): StepOutcome {
  const stepName = "ensure_gitignore_eval_entries";
  let readmePath: string;
  try {
    readmePath = resolveTriageCachePath(projectRoot, "README.md");
  } catch (err) {
    return containmentFailure(stepName, err);
  }
  const readmeRel = evalRelDisplay(projectRoot, readmePath);
  const entries = gitignoreTriageCacheEntries(projectRoot);
  const glob = gitattributesTriageCacheGlob(projectRoot);
  const ruleLine = `${glob}  merge=union`;
  const details: Record<string, unknown> = {};

  const giResult = ensureGitignoreSelectiveEntries(projectRoot, stepName, entries);
  if (!giResult.ok) {
    Object.assign(details, giResult.details);
    return stepOutcome(stepName, false, giResult.message, details, giResult.error ?? null);
  }
  Object.assign(details, giResult.details);

  const gaResult = ensureGitattributesMergeUnion(projectRoot, stepName, glob, ruleLine);
  if (!gaResult.ok) {
    Object.assign(details, gaResult.details);
    return stepOutcome(stepName, false, gaResult.message, details, gaResult.error ?? null);
  }
  Object.assign(details, gaResult.details);

  const rdResult = ensureEvalReadme({ projectRoot, readmePath, readmeRel, stepName });
  if (!rdResult.ok) {
    Object.assign(details, rdResult.details);
    return stepOutcome(stepName, false, rdResult.message, details, rdResult.error ?? null);
  }
  Object.assign(details, rdResult.details);

  const appendedLines = Number(details.gitignore_appended_lines ?? 0);
  const appendedAttr = Boolean(details.gitattributes_appended);
  const createdReadme = Boolean(details.readme_created);
  let message: string;
  if (appendedLines === 0 && !appendedAttr && !createdReadme) {
    message =
      ".gitignore selective entries, .gitattributes merge=union, " +
      `and ${readmeRel} already present (#1144 hybrid ` +
      "policy satisfied; no-op)";
  } else {
    const parts: string[] = [];
    if (appendedLines > 0) {
      const entryWord = appendedLines === 1 ? "entry" : "entries";
      parts.push(`${appendedLines} selective .gitignore ${entryWord}`);
    }
    if (appendedAttr) parts.push(".gitattributes merge=union rule");
    if (createdReadme) parts.push(readmeRel);
    message = `wrote ${parts.join(" + ")} per #1144 hybrid policy`;
  }
  message += formatBlanketWarning(Boolean(details.blanket_present));
  return stepOutcome(stepName, true, message, details);
}

/** Ensure `vbrief/.triage-cache/candidates.jsonl` exists (#1240 option A). */
export function stepSeedCandidatesLog(projectRoot: string): StepOutcome {
  // Layout-aware (#2109): seed under the active lifecycle `.eval` dir (xbrief/
  // when migrated, else vbrief/) instead of a hardcoded vbrief/ path.
  const auditPath = resolveCandidatesLogPath(projectRoot);
  const auditRel = evalRelDisplay(projectRoot, auditPath);
  const auditDir = dirname(auditPath);
  try {
    mkdirSync(auditDir, { recursive: true });
  } catch (exc) {
    return stepOutcome(
      "seed_candidates_log",
      false,
      `could not create ${auditDir}`,
      {},
      String(exc),
    );
  }

  try {
    readFileSync(auditPath, { encoding: "utf8" });
    return stepOutcome("seed_candidates_log", true, `${auditRel} already present (no-op)`, {
      created: false,
      already_present: true,
    });
  } catch {
    // create below
  }

  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: auditPath,
      data: "",
      mode: "create",
    });
  } catch (exc) {
    return stepOutcome(
      "seed_candidates_log",
      false,
      `could not seed ${auditPath}`,
      {},
      String(exc),
    );
  }
  return stepOutcome("seed_candidates_log", true, `created empty ${auditRel}`, {
    created: true,
    already_present: false,
  });
}
