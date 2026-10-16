import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  PHASE2_NARRATIVE_KEYS,
  mergePhase2NarrativePartial,
  parsePhase2NarrativeDocument,
  type Phase2NarrativeKey,
  type Phase2Narratives,
} from "../vbrief-build/phase2-narratives.js";
import { projectDefinitionPath } from "../vbrief-build/project-definition-io.js";
import { storePhase2Narratives } from "./project-render.js";

const USAGE =
  "Usage: project-write-narratives --narratives-file <path> [--title <text>] [--project-root <dir>] [--merge-existing] [--expected-revision <sha256>]\n";

interface ParsedCli {
  readonly projectRoot: string;
  readonly narrativesFile: string | undefined;
  readonly title: string | undefined;
  readonly mergeExisting: boolean;
  readonly expectedRevision: string | undefined;
  readonly error: string | undefined;
}

function parseCli(argv: readonly string[]): ParsedCli {
  let projectRoot = ".";
  let narrativesFile: string | undefined;
  let title: string | undefined;
  let mergeExisting = false;
  let expectedRevision: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --project-root");
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--narratives-file") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --narratives-file");
      narrativesFile = value;
      i += 1;
    } else if (arg.startsWith("--narratives-file=")) {
      narrativesFile = arg.slice("--narratives-file=".length);
    } else if (arg === "--title") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --title");
      title = value;
      i += 1;
    } else if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
    } else if (arg === "--merge-existing") {
      mergeExisting = true;
    } else if (arg === "--expected-revision") {
      const value = argv[i + 1];
      if (value === undefined) return blank("missing value for --expected-revision");
      expectedRevision = value;
      i += 1;
    } else if (arg.startsWith("--expected-revision=")) {
      expectedRevision = arg.slice("--expected-revision=".length);
    } else {
      return blank(`Unknown flag: ${arg}`);
    }
  }
  return {
    projectRoot,
    narrativesFile,
    title,
    mergeExisting,
    expectedRevision,
    error: undefined,
  };
}

function blank(error: string): ParsedCli {
  return {
    projectRoot: ".",
    narrativesFile: undefined,
    title: undefined,
    mergeExisting: false,
    expectedRevision: undefined,
    error,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readExistingNarratives(projectRoot: string): {
  narratives: Partial<Phase2Narratives>;
  revision: string | null;
  artifactPath: string;
} {
  const artifactPath = projectDefinitionPath(resolve(projectRoot));
  if (!existsSync(artifactPath)) {
    return { narratives: {}, revision: null, artifactPath };
  }
  try {
    if (!statSync(artifactPath).isFile()) {
      return { narratives: {}, revision: null, artifactPath };
    }
  } catch {
    return { narratives: {}, revision: null, artifactPath };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(artifactPath);
  } catch {
    return { narratives: {}, revision: null, artifactPath };
  }
  const revision = createHash("sha256").update(raw).digest("hex");
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return { narratives: {}, revision, artifactPath };
  }
  const root = asRecord(json);
  const plan = root === null ? null : asRecord(root.plan);
  const nested = plan === null ? null : asRecord(plan.narratives);
  const narratives: Partial<Phase2Narratives> = {};
  if (nested !== null) {
    for (const key of PHASE2_NARRATIVE_KEYS) {
      const field = nested[key];
      if (typeof field === "string") narratives[key] = field;
    }
  }
  return { narratives, revision, artifactPath };
}

/** Parse a partial narratives document; omitted keys are absent. */
export function parsePartialPhase2NarrativeDocument(
  value: unknown,
):
  | { narratives: Partial<Phase2Narratives>; presentKeys: Set<Phase2NarrativeKey>; title?: string }
  | { error: string } {
  const root = asRecord(value);
  if (root === null) return { error: "Phase 2 narratives file must be a JSON object" };
  const plan = asRecord(root.plan);
  const nested = plan === null ? null : asRecord(plan.narratives);
  const source = nested ?? root;
  const narratives: Partial<Phase2Narratives> = {};
  const presentKeys = new Set<Phase2NarrativeKey>();
  for (const key of PHASE2_NARRATIVE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const field = source[key];
    if (typeof field !== "string") {
      return { error: `Phase 2 narrative ${key} must be a string` };
    }
    narratives[key] = field;
    presentKeys.add(key);
  }
  const title = plan !== null && typeof plan.title === "string" ? plan.title : undefined;
  return title === undefined ? { narratives, presentKeys } : { narratives, presentKeys, title };
}

function describeChanges(
  before: Partial<Phase2Narratives>,
  after: Phase2Narratives,
  presentKeys: ReadonlySet<Phase2NarrativeKey>,
): string[] {
  const lines: string[] = [];
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const prev = before[key];
    const next = after[key];
    if (!presentKeys.has(key)) {
      lines.push(`  ${key}: keep ${JSON.stringify(prev ?? "")}`);
      continue;
    }
    if (prev === next) {
      lines.push(`  ${key}: unchanged ${JSON.stringify(next)}`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(prev ?? null)} -> ${JSON.stringify(next)}`);
    }
  }
  return lines;
}

/** CLI for `project:write-narratives` (#4663 / #4961 merge semantics). */
export function writePhase2NarrativesMain(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parsed = parseCli(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.narrativesFile === undefined || parsed.narrativesFile.length === 0) {
    process.stderr.write(`missing --narratives-file\n${USAGE}`);
    return 2;
  }

  let raw: string;
  try {
    raw = readFileSync(parsed.narrativesFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`could not read narratives file: ${message}\n`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`narratives file is not valid JSON: ${message}\n`);
    return 2;
  }

  const existing = readExistingNarratives(parsed.projectRoot);
  if (parsed.expectedRevision !== undefined) {
    const current = existing.revision ?? "";
    if (current !== parsed.expectedRevision) {
      process.stderr.write(
        `stale approval: expected revision ${parsed.expectedRevision} but artifact is ${current || "(missing)"}; stop for a fresh diff\n`,
      );
      return 1;
    }
  }

  let narratives: Phase2Narratives;
  let title: string | undefined;
  let presentKeys: Set<Phase2NarrativeKey> = new Set(PHASE2_NARRATIVE_KEYS);

  if (parsed.mergeExisting) {
    const partial = parsePartialPhase2NarrativeDocument(json);
    if ("error" in partial) {
      process.stderr.write(`${partial.error}\n`);
      return 2;
    }
    narratives = mergePhase2NarrativePartial(
      existing.narratives,
      partial.narratives,
      partial.presentKeys,
    );
    presentKeys = partial.presentKeys;
    title = parsed.title !== undefined ? parsed.title : partial.title;
    process.stdout.write("Field changes:\n");
    for (const line of describeChanges(existing.narratives, narratives, presentKeys)) {
      process.stdout.write(`${line}\n`);
    }
  } else {
    const document = parsePhase2NarrativeDocument(json);
    if ("error" in document) {
      process.stderr.write(`${document.error}\n`);
      return 2;
    }
    narratives = document.narratives;
    title = parsed.title !== undefined ? parsed.title : document.title;
  }

  const [ok, message] = storePhase2Narratives(resolve(parsed.projectRoot), {
    narratives,
    ...(title !== undefined ? { title } : {}),
  });
  if (!ok) {
    process.stderr.write(`${message}\n`);
    return 1;
  }
  process.stdout.write(`${message}\n`);
  return 0;
}
