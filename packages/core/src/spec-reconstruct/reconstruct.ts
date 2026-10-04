/**
 * Brownfield spec reconstruction engine (#1589 Prefer-A Bound C1).
 *
 * Emits a draft candidate only — never auto-promotes to specification.xbrief.json.
 * Code oracle: consume shipped #1595 codebase map (+ freshness when present).
 * Sufficiency feeds resolveSpecAuthority (one greenfield predicate).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { projectionOutputPath } from "../codebase/map.js";
import { checkCodebaseMapFresh } from "../codebase/map-fresh.js";
import { containedWrite } from "../fs/contained-write.js";
import { resolveAuditPath, resolveLifecycleRoot } from "../layout/resolve.js";
import { PENDING_DECISIONS_LOG_NAME } from "../policy/decisions.js";
import { resolveSpecAuthority } from "../spec-authority/resolver.js";

export const DEFAULT_SUFFICIENCY_THRESHOLD = Number.parseInt("20", 10);
export const DEFAULT_ADJUDICATION_BUDGET = Number.parseInt("8", 10);
export const DRAFT_REL_PATH = "spec-reconstruct-draft.json";

export type Confidence = "high" | "medium" | "low";
export type ProvenanceKind = "completed-xbrief" | "codebase-map" | "conflict" | "synthetic";

export interface ReconstructedRequirement {
  readonly id: string;
  readonly title: string;
  readonly intendedRequirement: string;
  readonly observedBehavior: string;
  readonly unresolvedConflict: string | null;
  readonly provenance: {
    readonly kind: ProvenanceKind;
    readonly sources: readonly string[];
  };
  readonly confidence: Confidence;
  readonly supersededBy: string | null;
}

export interface SpecReconstructDraft {
  readonly kind: "deft.spec-reconstruct.draft.v1";
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly draftOnly: true;
  readonly autoPromote: false;
  readonly sufficiency: {
    readonly completedCount: number;
    readonly threshold: number;
    readonly adviseGreenfieldInterview: boolean;
    readonly authorityKind: "full-spec" | "greenfield" | "unavailable";
  };
  readonly codeOracle: {
    readonly mapPath: string;
    readonly mapPresent: boolean;
    readonly mapFreshFindings: readonly string[];
    readonly moduleCount: number;
    readonly moduleTokens: readonly string[];
  };
  readonly requirements: readonly ReconstructedRequirement[];
  readonly pendingHumanDecisions: readonly string[];
  readonly adjudication: {
    readonly budget: number;
    readonly resolvedCount: number;
    readonly deferredCount: number;
  };
}

export interface SpecReconstructOptions {
  readonly sufficiencyThreshold?: number;
  readonly adjudicationBudget?: number;
  readonly now?: Date;
}

interface CompletedBrief {
  readonly relPath: string;
  readonly id: string;
  readonly title: string;
  readonly overview: string;
  readonly supersedes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utcIso(now?: Date): string {
  return (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function listCompletedBriefs(projectRoot: string): CompletedBrief[] {
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    return [];
  }
  const completedDir = join(lifecycleRoot, "completed");
  if (!existsSync(completedDir)) return [];
  const out: CompletedBrief[] = [];
  for (const name of readdirSync(completedDir)) {
    if (!name.endsWith(".xbrief.json") && !name.endsWith(".vbrief.json")) continue;
    const abs = join(completedDir, name);
    try {
      if (!statSync(abs).isFile()) continue;
      const data = JSON.parse(readFileSync(abs, "utf8")) as unknown;
      if (!isRecord(data) || !isRecord(data.plan)) continue;
      const plan = data.plan;
      const id =
        typeof plan.id === "string" && plan.id.length > 0
          ? plan.id
          : name.replace(/\.(x|v)brief\.json$/u, "");
      const title = typeof plan.title === "string" ? plan.title : id;
      const narratives = isRecord(plan.narratives) ? plan.narratives : {};
      const overview =
        typeof narratives.Overview === "string"
          ? narratives.Overview
          : typeof narratives.Description === "string"
            ? narratives.Description
            : title;
      const supersedes: string[] = [];
      const refs = Array.isArray(plan.references) ? plan.references : [];
      for (const ref of refs) {
        if (!isRecord(ref)) continue;
        const typ = typeof ref.type === "string" ? ref.type : "";
        if (typ.includes("supersede") || typ.includes("replaces")) {
          if (typeof ref.uri === "string") supersedes.push(ref.uri);
          if (typeof ref.title === "string") supersedes.push(ref.title);
        }
      }
      const meta = isRecord(plan.metadata) ? plan.metadata : {};
      if (typeof meta.supersedes === "string") supersedes.push(meta.supersedes);
      if (Array.isArray(meta.supersedes)) {
        for (const s of meta.supersedes) {
          if (typeof s === "string") supersedes.push(s);
        }
      }
      out.push({
        relPath: relative(projectRoot, abs).replace(/\\/g, "/"),
        id,
        title,
        overview: overview.slice(0, 2000),
        supersedes,
      });
    } catch {
      // skip unreadable / malformed
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function detectSupersession(briefs: readonly CompletedBrief[]): Map<string, string> {
  const superseded = new Map<string, string>();
  const byId = new Map(briefs.map((b) => [b.id, b]));
  const byTitle = new Map(briefs.map((b) => [b.title.toLowerCase(), b]));
  for (const brief of briefs) {
    for (const token of brief.supersedes) {
      const hit = byId.get(token) ?? byTitle.get(token.toLowerCase());
      if (hit !== undefined && hit.id !== brief.id) {
        superseded.set(hit.id, brief.id);
      }
    }
  }
  // Title-prefix heuristic: later path wins when titles share a long prefix.
  for (let i = 0; i < briefs.length; i += 1) {
    for (let j = i + 1; j < briefs.length; j += 1) {
      const a = briefs[i];
      const b = briefs[j];
      if (a === undefined || b === undefined) continue;
      const ta = a.title.toLowerCase();
      const tb = b.title.toLowerCase();
      if (ta.length < 24 || tb.length < 24) continue;
      if (ta === tb || ta.startsWith(tb) || tb.startsWith(ta)) {
        const later = a.relPath < b.relPath ? b : a;
        const earlier = later.id === a.id ? b : a;
        superseded.set(earlier.id, later.id);
      }
    }
  }
  return superseded;
}

function readCodeOracle(projectRoot: string): SpecReconstructDraft["codeOracle"] {
  const mapRel = projectionOutputPath(projectRoot);
  const mapAbs = resolve(projectRoot, mapRel);
  const mapPresent = existsSync(mapAbs);
  const mapFreshFindings = mapPresent
    ? checkCodebaseMapFresh(projectRoot, { outputPath: mapRel })
    : ["codebase MAP absent; reconstruction continues without a local projection (#1595)"];
  let moduleCount = 0;
  let moduleTokens: string[] = [];
  if (mapPresent) {
    try {
      const text = readFileSync(mapAbs, "utf8");
      // #1595 MAP renders modules as markdown table rows under "## Modules", not `- **` bullets.
      const modulesSection = text.split(/^## Modules\s*$/m)[1] ?? "";
      const untilNext = modulesSection.split(/^## /m)[0] ?? modulesSection;
      const rows = untilNext.match(/^\| `([^`]+)` \| ([^|]+) \|/gm) ?? [];
      moduleCount = rows.length;
      const tokens = new Set<string>();
      for (const row of rows) {
        const m = /^\| `([^`]+)` \| ([^|]+) \|/.exec(row);
        if (m?.[1]) tokens.add(m[1].toLowerCase());
        const name = m?.[2]?.trim().toLowerCase();
        if (name !== undefined && name.length > 0) {
          for (const part of name.split(/\s+/)) {
            if (part.length > 3) tokens.add(part);
          }
        }
      }
      moduleTokens = [...tokens];
    } catch {
      moduleCount = 0;
      moduleTokens = [];
    }
  }
  return {
    mapPath: mapRel.replace(/\\/g, "/"),
    mapPresent,
    mapFreshFindings,
    moduleCount,
    moduleTokens,
  };
}

function appendPendingDecisions(
  projectRoot: string,
  decisions: readonly { readonly decision_id: string; readonly summary: string }[],
): void {
  if (decisions.length === 0) return;
  const abs = resolveAuditPath(projectRoot, PENDING_DECISIONS_LOG_NAME);
  const rel = relative(resolve(projectRoot), abs).replace(/\\/g, "/");
  const lines = decisions
    .map((d) =>
      JSON.stringify({
        decision_id: d.decision_id,
        status: "pending",
        kind: "spec-reconstruct-adjudication",
        summary: d.summary,
        timestamp: utcIso(),
      }),
    )
    .join("\n");
  containedWrite({
    root: projectRoot,
    target: rel,
    data: `${lines}\n`,
    mode: existsSync(abs) ? "append" : "create",
  });
}

/** Build a draft-only reconstruction candidate. */
export function reconstructSpecDraft(
  projectRoot: string,
  options: SpecReconstructOptions = {},
): SpecReconstructDraft {
  const root = resolve(projectRoot);
  const threshold = options.sufficiencyThreshold ?? DEFAULT_SUFFICIENCY_THRESHOLD;
  const budget = options.adjudicationBudget ?? DEFAULT_ADJUDICATION_BUDGET;
  const briefs = listCompletedBriefs(root);
  const superseded = detectSupersession(briefs);
  const authority = resolveSpecAuthority(root);
  const codeOracle = readCodeOracle(root);

  const requirements: ReconstructedRequirement[] = [];
  const pending: { decision_id: string; summary: string }[] = [];
  let resolvedCount = 0;
  let deferredCount = 0;

  for (const brief of briefs) {
    const supersededBy = superseded.get(brief.id) ?? null;
    const titleTokens = brief.title
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((tok) => tok.length > 3);
    const mapHit = titleTokens.some((tok) => codeOracle.moduleTokens.includes(tok));
    const mapMentions =
      codeOracle.mapPresent &&
      codeOracle.moduleCount > 0 &&
      codeOracle.mapFreshFindings.length === 0 &&
      mapHit;
    let observedBehavior = "not observed in local codebase MAP";
    let unresolvedConflict: string | null = null;
    let confidence: Confidence = supersededBy !== null ? "low" : "medium";
    let provenanceKind: ProvenanceKind = "completed-xbrief";

    if (mapMentions) {
      observedBehavior = `codebase MAP module/token overlap (${codeOracle.moduleCount} modules)`;
      confidence = supersededBy === null ? "high" : "medium";
      provenanceKind = "codebase-map";
    }

    if (supersededBy !== null) {
      const conflict = `superseded by ${supersededBy}`;
      if (resolvedCount < budget) {
        resolvedCount += 1;
        unresolvedConflict = null;
        confidence = "low";
      } else {
        deferredCount += 1;
        unresolvedConflict = conflict;
        provenanceKind = "conflict";
        const decisionId = randomUUID();
        pending.push({
          decision_id: decisionId,
          summary: `Adjudicate reconstruct conflict for ${brief.id}: ${conflict}`,
        });
      }
    }

    requirements.push({
      id: `req-${createHash("sha256").update(brief.id).digest("hex").slice(0, 12)}`,
      title: brief.title,
      intendedRequirement: brief.overview,
      observedBehavior,
      unresolvedConflict,
      provenance: {
        kind: provenanceKind,
        sources: [brief.relPath, ...(codeOracle.mapPresent ? [codeOracle.mapPath] : [])],
      },
      confidence,
      supersededBy,
    });
  }

  appendPendingDecisions(root, pending);

  // Sufficiency is a discovery heuristic on the draft; do not let a stale full-spec
  // artifact suppress interview advice when the completed corpus is below threshold.
  const adviseGreenfieldInterview = briefs.length < threshold;

  return {
    kind: "deft.spec-reconstruct.draft.v1",
    generatedAt: utcIso(options.now),
    projectRoot: root,
    draftOnly: true,
    autoPromote: false,
    sufficiency: {
      completedCount: briefs.length,
      threshold,
      adviseGreenfieldInterview,
      authorityKind: authority?.kind ?? "unavailable",
    },
    codeOracle,
    requirements,
    pendingHumanDecisions: pending.map((p) => p.decision_id),
    adjudication: {
      budget,
      resolvedCount,
      deferredCount,
    },
  };
}

/** Write draft under xbrief/.audit/; never touches specification.xbrief.json. */
export function writeSpecReconstructDraft(
  projectRoot: string,
  draft: SpecReconstructDraft,
): string {
  const root = resolve(projectRoot);
  const abs = resolveAuditPath(root, DRAFT_REL_PATH);
  const rel = relative(root, abs).replace(/\\/g, "/");
  containedWrite({
    root,
    target: rel,
    data: `${JSON.stringify(draft, null, 2)}\n`,
    mode: existsSync(abs) ? "replace" : "create",
  });
  return abs;
}

export interface SpecReconstructCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSpecReconstructCli(argv: string[]): SpecReconstructCliResult {
  let projectRoot = ".";
  let json = false;
  let threshold: number | undefined;
  let budget: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--sufficiency-threshold") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --sufficiency-threshold: expected a non-negative integer\n",
        };
      }
      threshold = Number(value);
      i += 1;
    } else if (arg === "--adjudication-budget") {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --adjudication-budget: expected a non-negative integer\n",
        };
      }
      budget = Number(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return {
        exitCode: 0,
        stdout:
          "Usage: spec-reconstruct [--project-root <dir>] [--json] " +
          "[--sufficiency-threshold N] [--adjudication-budget N]\n" +
          "Emits a draft candidate only; never writes specification.xbrief.json (#1589).\n",
        stderr: "",
      };
    } else if (arg !== undefined && arg.length > 0) {
      return { exitCode: 2, stdout: "", stderr: `unknown argument: ${arg}\n` };
    }
  }

  try {
    const draft = reconstructSpecDraft(projectRoot, {
      sufficiencyThreshold: threshold,
      adjudicationBudget: budget,
    });
    const outPath = writeSpecReconstructDraft(projectRoot, draft);
    if (json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ...draft, draftPath: outPath }, null, 2)}\n`,
        stderr: "",
      };
    }
    const lines = [
      `spec:reconstruct draft written: ${outPath}`,
      `draftOnly=true autoPromote=false`,
      `completed=${draft.sufficiency.completedCount} threshold=${draft.sufficiency.threshold}`,
      `authority=${draft.sufficiency.authorityKind}`,
      `adviseGreenfieldInterview=${String(draft.sufficiency.adviseGreenfieldInterview)}`,
      `requirements=${draft.requirements.length}`,
      `pendingHumanDecisions=${draft.pendingHumanDecisions.length}`,
      `codeOracle.mapPresent=${String(draft.codeOracle.mapPresent)}`,
    ];
    if (draft.sufficiency.adviseGreenfieldInterview) {
      lines.push(
        "sufficiency: below threshold with greenfield/unavailable authority — prefer make-spec interview (resolveSpecAuthority)",
      );
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } catch (err) {
    return { exitCode: 2, stdout: "", stderr: `spec-reconstruct failed: ${String(err)}\n` };
  }
}
