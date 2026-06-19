import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StepOutcome } from "./types.js";

export const GITIGNORE_LINE = ".deft-cache/";

export const GITIGNORE_DEFT_RUNTIME_SENTINELS: readonly string[] = [
  ".deft/ritual-state.json",
  ".deft/last-session.json",
];

export const GITIGNORE_EVAL_ENTRIES: readonly string[] = [
  "vbrief/.eval/candidates.jsonl",
  "vbrief/.eval/summary-history.jsonl",
  "vbrief/.eval/scope-lifecycle.jsonl",
  "vbrief/.eval/decompositions/",
  "vbrief/.eval/doctor-state.json",
];

export const GITATTRIBUTES_EVAL_RULE = "vbrief/.eval/*.jsonl  merge=union";

export const FORBIDDEN_BLANKET_EVAL_LINES: readonly string[] = ["vbrief/.eval/", "vbrief/.eval"];

const GITATTRIBUTES_EVAL_GLOB = "vbrief/.eval/*.jsonl";

const DEFT_CACHE_RATIONALE =
  "\n# Triage v1 local content cache (#845, #883). Mirrors upstream\n" +
  "# issues into .deft-cache/github-issue/<owner>/<repo>/<N>/. See\n" +
  "# docs/privacy-nfr.md for the gitignore-default + opt-in-commit-cache\n" +
  "# contract. Comment this line out to opt in to committing the cache.\n";

const EVAL_ENTRIES_RATIONALE =
  "\n# vbrief/.eval/ tracking governance (#1144, N4 of #1119).\n" +
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
  "#   - slices.jsonl           -> TRACKED (team-shared cohort records\n" +
  "#                               produced by slicing skills; see\n" +
  "#                               #1132 / D13).\n" +
  "# See vbrief/.eval/README.md for the full policy + merge=union\n" +
  "# rebase note.\n";

const GITATTRIBUTES_EVAL_RATIONALE =
  "\n# Append-only JSON-lines logs under vbrief/.eval/ use the union merge driver\n" +
  "# (#1144, N4 of #1119). Both branches' appended lines are concatenated on\n" +
  "# auto-merge so single-operator rebases of two append branches resolve\n" +
  "# without manual conflict surgery. Note: merge=union does NOT dedupe; see\n" +
  "# vbrief/.eval/README.md for the operator-facing semantics.\n";

const EVAL_ENTRIES_RATIONALE_SENTINEL = "# vbrief/.eval/ tracking governance (#1144, N4 of #1119).";

export const EVAL_README_BODY = `# \`vbrief/.eval/\` -- triage + slicing evaluation artefacts

This directory holds the append-only JSON-lines logs that the triage and
slicing skills emit. The framework governs which files in here are tracked
by git versus gitignored using a **hybrid policy** (#1144, child of #1119).

## Tracking policy

| File | Tracked? | Why |
| --- | --- | --- |
| \`slices.jsonl\` | Yes -- **committed** | Team-shared cohort records produced by slicing skills (D13 / #1132). New operators joining the team need to see prior cohort outputs to detect orphans and avoid re-slicing the same scope. |
| \`candidates.jsonl\` | No -- **gitignored** | Operator-private triage decisions (#845 Story 2). Each operator's local accept / defer / reject stream is per-machine state; sharing it would conflate operators' timing + identity across the team. Re-derive on a fresh clone via \`task triage:bootstrap\`. |
| \`summary-history.jsonl\` | No -- **gitignored** | Operator-private observability for \`task triage:summary\` output time-series. Not load-bearing for any decision. |
| \`scope-lifecycle.jsonl\` | No -- **gitignored** | Operator-private scope-lifecycle audit decisions (D1 / #1121). Each demote (\`task scope:demote\`) appends one entry including a \`demote_meta\` block (\`was_promoted\`, \`original_promotion_decision_id\`, \`days_in_pending\`, \`demote_reason\`, \`demoted_from\`). Per-operator stream; sharing would conflate operators' demote timing across the team. Lightweight metrics over this log are tracked separately at #1180. |
| \`decompositions/\` | No -- **gitignored** | Temporary story-decomposition proposal drafts. These JSON drafts are local scratch artifacts, not vBRIEFs; generated child story vBRIEFs are created by \`task scope:decompose\` in lifecycle folders, defaulting to \`vbrief/pending/\`. |
| \`doctor-state.json\` | No -- **gitignored** | Per-machine \`task doctor\` throttle state (last exit code + timestamps) persisted to gate the 24h/4h re-probe window (#1308 / #1464). Local to each clone; never committed. |

The gitignore lines live in the repo-root \`.gitignore\` (\`vbrief/.eval/candidates.jsonl\`,
\`vbrief/.eval/summary-history.jsonl\`, \`vbrief/.eval/scope-lifecycle.jsonl\`,
\`vbrief/.eval/decompositions/\`, and \`vbrief/.eval/doctor-state.json\`). All paths
not listed above remain committed by default.

## Fresh-clone regeneration

On a fresh clone (or any machine that has never run triage), \`candidates.jsonl\`
is absent. Regenerate it with:

\`\`\`
task triage:bootstrap
\`\`\`

The bootstrap path detects the missing file, runs the auto-classifier, and
writes a fresh \`vbrief/.eval/candidates.jsonl\`. It does NOT touch the tracked
\`slices.jsonl\`; cohort records remain a team-shared resource.

## \`merge=union\` policy for \`*.jsonl\`

The repo-root \`.gitattributes\` declares:

\`\`\`
vbrief/.eval/*.jsonl  merge=union
\`\`\`

The \`union\` merge driver concatenates both sides' appended lines on
auto-merge, so two branches that each appended a different record to the
same JSON-lines file rebase cleanly without operator surgery. Two things
operators should know:

- **Concatenation, not set-union.** When two branches append DIFFERENT
  records to the file, the merge driver concatenates both sides' lines
  -- there is no smart deduplication of "semantically similar" records.
  (Identical line-for-line appends collapse because git's three-way
  merge sees them as the same change, but distinct records always
  survive verbatim, even if a downstream reader would consider them
  redundant.) The append-only writers in \`scripts/candidates_log.py\`
  mint a fresh \`decision_id\` per call, so genuinely duplicate records
  are not the expected case, but downstream readers MUST tolerate
  multiple records describing the same logical decision.
- **Single-operator scope only.** This is the foundational rebase
  ergonomic for the single-operator case (operator A rebases their
  feature branch onto a master that grew while they were AFK).
  Multi-operator merge-conflict resolution is explicitly out of scope per
  #1119 R4 (tracked separately as M1-M4 in #1183).

## See also

- Current Shape comment on #1144 for the canonical decisions (the source
  of truth this README documents).
- \`.gitignore\` -- selective gitignore entries for the operator-private
  files.
- \`.gitattributes\` -- the \`merge=union\` rule.
- \`scripts/candidates_log.py\` -- the writer for \`candidates.jsonl\`.
`;

const CANDIDATES_RELPATH = "vbrief/.eval/candidates.jsonl";

function stepOutcome(
  name: string,
  ok: boolean,
  message: string,
  details: Record<string, unknown> = {},
  error: string | null = null,
): StepOutcome {
  return { name, ok, message, error, details };
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
  gitignorePath: string,
  line: string,
  stepName: string,
  createIfMissing: boolean,
  rationaleBlock: string,
  optInMessage: string,
): StepOutcome {
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
      writeFileSync(gitignorePath, `${line}\n`, { encoding: "utf8" });
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
    writeFileSync(gitignorePath, newContent, { encoding: "utf8" });
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
    " WARNING: stale blanket vbrief/.eval/ line detected in .gitignore -- " +
    "remove it manually (it hides tracked slices.jsonl from git per #1251)"
  );
}

function gitattributesHasEvalMergeUnion(body: string): boolean {
  for (const raw of body.split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0 || stripped.startsWith("#")) continue;
    const parts = stripped.split(/\s+/);
    if (parts.length === 0) continue;
    if (parts[0] !== GITATTRIBUTES_EVAL_GLOB) continue;
    if (parts.slice(1).includes("merge=union")) return true;
  }
  return false;
}

function ensureGitignoreSelectiveEntries(gitignorePath: string, stepName: string): StepOutcome {
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
  const missing = GITIGNORE_EVAL_ENTRIES.filter((entry) => !existingLines.has(entry));
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
    writeFileSync(gitignorePath, newContent, { encoding: "utf8" });
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

function ensureGitattributesMergeUnion(gitattributesPath: string, stepName: string): StepOutcome {
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
    if (gitattributesHasEvalMergeUnion(existing)) {
      return stepOutcome(
        stepName,
        true,
        "vbrief/.eval/*.jsonl merge=union already in .gitattributes (no-op)",
        {
          gitattributes_appended: false,
          gitattributes_already_present: true,
        },
      );
    }
    const suffix = existing.endsWith("\n") || existing === "" ? "" : "\n";
    const newContent = `${existing + suffix + GITATTRIBUTES_EVAL_RATIONALE + GITATTRIBUTES_EVAL_RULE}\n`;
    try {
      writeFileSync(gitattributesPath, newContent, { encoding: "utf8" });
    } catch (exc) {
      return stepOutcome(
        stepName,
        false,
        "could not write .gitattributes",
        { gitattributes_appended: false },
        String(exc),
      );
    }
    return stepOutcome(
      stepName,
      true,
      "appended vbrief/.eval/*.jsonl merge=union to .gitattributes",
      { gitattributes_appended: true, gitattributes_created: false },
    );
  }

  const newContent = `${GITATTRIBUTES_EVAL_RATIONALE + GITATTRIBUTES_EVAL_RULE}\n`;
  try {
    writeFileSync(gitattributesPath, newContent, { encoding: "utf8" });
  } catch (exc) {
    return stepOutcome(
      stepName,
      false,
      "could not create .gitattributes",
      { gitattributes_appended: false },
      String(exc),
    );
  }
  return stepOutcome(
    stepName,
    true,
    "created .gitattributes with vbrief/.eval/*.jsonl merge=union",
    { gitattributes_appended: true, gitattributes_created: true },
  );
}

function ensureEvalReadme(readmePath: string, stepName: string): StepOutcome {
  try {
    readFileSync(readmePath, { encoding: "utf8" });
    return stepOutcome(stepName, true, "vbrief/.eval/README.md already present (no-op)", {
      readme_created: false,
      readme_already_present: true,
    });
  } catch {
    // create below
  }

  try {
    mkdirSync(dirname(readmePath), { recursive: true });
    writeFileSync(readmePath, EVAL_README_BODY, { encoding: "utf8" });
  } catch (exc) {
    return stepOutcome(
      stepName,
      false,
      `could not create ${readmePath}`,
      { readme_created: false },
      String(exc),
    );
  }
  return stepOutcome(stepName, true, "created vbrief/.eval/README.md (#1144 hybrid policy)", {
    readme_created: true,
  });
}

/** Ensure the #1144 hybrid policy is encoded in the repo (idempotent). */
export function stepEnsureGitignoreEvalEntries(projectRoot: string): StepOutcome {
  const gitignorePath = `${projectRoot}/.gitignore`;
  const gitattributesPath = `${projectRoot}/.gitattributes`;
  const readmePath = `${projectRoot}/vbrief/.eval/README.md`;
  const stepName = "ensure_gitignore_eval_entries";
  const details: Record<string, unknown> = {};

  const giResult = ensureGitignoreSelectiveEntries(gitignorePath, stepName);
  if (!giResult.ok) {
    Object.assign(details, giResult.details);
    return stepOutcome(stepName, false, giResult.message, details, giResult.error ?? null);
  }
  Object.assign(details, giResult.details);

  const gaResult = ensureGitattributesMergeUnion(gitattributesPath, stepName);
  if (!gaResult.ok) {
    Object.assign(details, gaResult.details);
    return stepOutcome(stepName, false, gaResult.message, details, gaResult.error ?? null);
  }
  Object.assign(details, gaResult.details);

  const rdResult = ensureEvalReadme(readmePath, stepName);
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
      "and vbrief/.eval/README.md already present (#1144 hybrid " +
      "policy satisfied; no-op)";
  } else {
    const parts: string[] = [];
    if (appendedLines > 0) {
      const entryWord = appendedLines === 1 ? "entry" : "entries";
      parts.push(`${appendedLines} selective .gitignore ${entryWord}`);
    }
    if (appendedAttr) parts.push(".gitattributes merge=union rule");
    if (createdReadme) parts.push("vbrief/.eval/README.md");
    message = `wrote ${parts.join(" + ")} per #1144 hybrid policy`;
  }
  message += formatBlanketWarning(Boolean(details.blanket_present));
  return stepOutcome(stepName, true, message, details);
}

/** Ensure `vbrief/.eval/candidates.jsonl` exists (#1240 option A). */
export function stepSeedCandidatesLog(projectRoot: string): StepOutcome {
  const auditPath = `${projectRoot}/${CANDIDATES_RELPATH}`;
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
    const relative = CANDIDATES_RELPATH;
    return stepOutcome("seed_candidates_log", true, `${relative} already present (no-op)`, {
      created: false,
      already_present: true,
    });
  } catch {
    // create below
  }

  try {
    writeFileSync(auditPath, "", { encoding: "utf8" });
  } catch (exc) {
    return stepOutcome(
      "seed_candidates_log",
      false,
      `could not seed ${auditPath}`,
      {},
      String(exc),
    );
  }
  return stepOutcome("seed_candidates_log", true, `created empty ${CANDIDATES_RELPATH}`, {
    created: true,
    already_present: false,
  });
}
