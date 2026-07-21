import { spawnSync } from "node:child_process";
import { DEFAULT_PRODUCT_SIGNAL_SINK_REPO } from "../policy/product-signal.js";
import { GhRestError, type GhRestSeams, restCreateLabel } from "../scm/gh-rest.js";

/** D20 minimum label bootstrap set (#2693). */
export const PRODUCT_SIGNAL_BOOTSTRAP_LABELS: readonly {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}[] = [
  { name: "surface:pulse", color: "1D76DB", description: "Standing pulse thread" },
  { name: "surface:portrait", color: "5319E7", description: "Standing portrait thread" },
  { name: "nps:promoter", color: "0E8A16", description: "NPS 9-10" },
  { name: "nps:passive", color: "FBCA04", description: "NPS 7-8" },
  { name: "nps:detractor", color: "D93F0B", description: "NPS 0-6" },
  { name: "nps:none", color: "C5DEF5", description: "No NPS score" },
  { name: "signal:gap", color: "B60205", description: "Gap comment on pulse thread" },
];

export const PRODUCT_SIGNAL_SINK_README = `# deftai/product-signal

Private operator inbox for consented Directive product-improvement signal (Phase 1 under epic #2603).

## Standing threads

- Thread key: \`(installId, actorName)\` — see issue body marker \`<!-- deft:product-signal v1 ... -->\`
- **Portrait**: one open issue per key; body upserted in place (\`surface:portrait\`)
- **Pulse**: dated comments appended on standing issue (\`surface:pulse\`)
- **Gap notes**: \`Gap:\` comments on the pulse thread (\`signal:gap\` label when present)

## Labels (bootstrapped)

- \`surface:pulse\`, \`surface:portrait\`
- \`nps:promoter\`, \`nps:passive\`, \`nps:detractor\`, \`nps:none\`
- \`signal:gap\`
- \`directive:<major.minor>\` — created on first use per directive version

This repo is an operator-readable inbox, not the long-term analytics warehouse (#2603).
`;

export interface BootstrapSinkResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly repo: string;
}

/** Bootstrap D20 labels (idempotent — ignores existing label 422). */
export function bootstrapProductSignalLabels(
  repo: string = DEFAULT_PRODUCT_SIGNAL_SINK_REPO,
  seams: GhRestSeams = {},
): { created: number; skipped: number; errors: string[] } {
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const label of PRODUCT_SIGNAL_BOOTSTRAP_LABELS) {
    try {
      restCreateLabel(repo, label.name, label.color, label.description, seams);
      created += 1;
    } catch (err: unknown) {
      if (err instanceof GhRestError) {
        if (err.stderr.toLowerCase().includes("already_exists") || err.exitCode === 422) {
          skipped += 1;
          continue;
        }
        errors.push(`${label.name}: ${err.stderr || err.message}`);
      } else {
        errors.push(`${label.name}: ${String(err)}`);
      }
    }
  }
  return { created, skipped, errors };
}

/** Create private sink repo + README + labels via gh CLI (#2693 D6/D20). */
export function bootstrapProductSignalSink(
  options: { repo?: string; dryRun?: boolean; seams?: GhRestSeams } = {},
): BootstrapSinkResult {
  const repo = options.repo ?? DEFAULT_PRODUCT_SIGNAL_SINK_REPO;
  if (options.dryRun) {
    return {
      exitCode: 0,
      stdout: `[dry-run] would bootstrap private sink ${repo} with README + ${PRODUCT_SIGNAL_BOOTSTRAP_LABELS.length} labels\n`,
      repo,
    };
  }
  const create = spawnSync(
    "gh",
    [
      "repo",
      "create",
      repo,
      "--private",
      "--description",
      "Private product-improvement signal inbox for Directive partners (Refs #2693)",
      "--add-readme",
    ],
    { encoding: "utf8" },
  );
  if (create.status !== 0 && !String(create.stderr).toLowerCase().includes("already exists")) {
    return {
      exitCode: 2,
      stdout: `sink bootstrap failed: ${create.stderr || create.stdout}\n`,
      repo,
    };
  }
  const labelResult = bootstrapProductSignalLabels(repo, options.seams);
  const lines = [
    `product-signal sink ${repo} ready (or already existed).`,
    `labels: created=${labelResult.created} skipped=${labelResult.skipped}`,
  ];
  if (labelResult.errors.length > 0) {
    lines.push(`label warnings: ${labelResult.errors.join("; ")}`);
  }
  lines.push("", "Update repo README with standing-thread conventions if empty.");
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, repo };
}
