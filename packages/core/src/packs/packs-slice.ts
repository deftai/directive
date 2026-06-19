/** Port of scripts/packs_slice.py — named slice access to content packs (#1283, #1294). */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

const REPO_ROOT = resolveRepoRoot();

function effectiveRepoRoot(repoRoot?: string): string {
  return repoRoot ?? REPO_ROOT;
}

export interface PackRegistryPaths {
  readonly source: string;
  readonly schema: string;
}

export const PACK_REGISTRY: Record<string, PackRegistryPaths> = {
  lessons: {
    source: join(REPO_ROOT, "packs", "lessons", "lessons-pack-0.1.json"),
    schema: join(REPO_ROOT, "vbrief", "schemas", "lessons-pack.schema.json"),
  },
};

export const PACKS_DIR = join(REPO_ROOT, "packs");
export const SCHEMAS_DIR = join(REPO_ROOT, "vbrief", "schemas");

export const DEFAULT_DISPLAY: Record<string, unknown> = {
  heading: "title",
  fields: [],
  body: "body",
  noun: "lessons",
};

export class UsageError extends Error {
  override readonly message: string;
  readonly suggestion: string | null;

  constructor(message: string, suggestion: string | null = null) {
    super(message);
    this.message = message;
    this.suggestion = suggestion;
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relToRepo(path: string, repoRoot?: string): string {
  const root = effectiveRepoRoot(repoRoot);
  try {
    return relative(root, resolve(path)).split("\\").join("/");
  } catch {
    return path.split(/[/\\]/).pop() ?? path;
  }
}

function isDigitRange(value: string, start: number, count: number): boolean {
  if (start + count > value.length) {
    return false;
  }
  for (let i = start; i < start + count; i += 1) {
    const ch = value[i] as string;
    if (ch < "0" || ch > "9") {
      return false;
    }
  }
  return true;
}

export function isValidSince(value: string): boolean {
  if (value.length === 7) {
    return value[4] === "-" && isDigitRange(value, 0, 4) && isDigitRange(value, 5, 2);
  }
  if (value.length === 10) {
    return (
      value[4] === "-" &&
      value[7] === "-" &&
      isDigitRange(value, 0, 4) &&
      isDigitRange(value, 5, 2) &&
      isDigitRange(value, 8, 2)
    );
  }
  return false;
}

function longestCommonSubsequenceLength(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols).fill(0);
  let curr = new Array<number>(cols).fill(0);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] as number) + 1;
      } else {
        curr[j] = Math.max(prev[j] as number, curr[j - 1] as number);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length] as number;
}

function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  const matches = longestCommonSubsequenceLength(a, b);
  return (2 * matches) / (a.length + b.length);
}

/** Simple ratio-based did-you-mean (n=1, cutoff 0.6 — mirrors difflib.get_close_matches). */
export function getCloseMatches(
  word: string,
  possibilities: readonly string[],
  n = 1,
  cutoff = 0.6,
): string[] {
  const scored = possibilities
    .map((candidate) => ({ candidate, ratio: similarityRatio(word, candidate) }))
    .filter((entry) => entry.ratio >= cutoff)
    .sort((left, right) => right.ratio - left.ratio);
  return scored.slice(0, n).map((entry) => entry.candidate);
}

export function resolvePack(packName: string): [string, string] {
  const registryEntry = PACK_REGISTRY[packName];
  if (registryEntry !== undefined) {
    return [registryEntry.source, registryEntry.schema];
  }

  const packDir = join(PACKS_DIR, packName);
  let sources: string[] = [];
  if (existsSync(packDir) && statSync(packDir).isDirectory()) {
    sources = readdirSync(packDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(packDir, name));
  }
  const schemaPath = join(SCHEMAS_DIR, `${packName}-pack.schema.json`);
  if (sources.length > 0 && existsSync(schemaPath)) {
    return [sources[0] as string, schemaPath];
  }

  const discovered = discoverPacks().map((pack) => pack.name as string);
  const known = [...new Set([...Object.keys(PACK_REGISTRY), ...discovered])].sort();
  const suggestions = getCloseMatches(packName, known, 1);
  throw new UsageError(`unknown pack '${packName}'`, suggestions[0] ?? null);
}

export function loadDisplay(schemaPath: string): Record<string, unknown> {
  if (!existsSync(schemaPath)) {
    throw new UsageError(`pack schema not found: ${schemaPath}`);
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const display = schema["x-display"];
  if (typeof display !== "object" || display === null || Array.isArray(display)) {
    return { ...DEFAULT_DISPLAY };
  }
  return display as Record<string, unknown>;
}

export function loadRegistry(schemaPath: string): Record<string, Record<string, unknown>> {
  if (!existsSync(schemaPath)) {
    throw new UsageError(`pack schema not found: ${schemaPath}`);
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const registry = schema["x-sliceRegistry"];
  if (typeof registry !== "object" || registry === null || Array.isArray(registry)) {
    throw new UsageError(`pack schema has no x-sliceRegistry: ${schemaPath}`);
  }
  return registry as Record<string, Record<string, unknown>>;
}

export function loadSource(sourcePath: string): Record<string, unknown> {
  if (!existsSync(sourcePath)) {
    throw new UsageError(`pack source not found: ${sourcePath}`);
  }
  return JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
}

export function resolveDottedPath(data: unknown, dotted: string): unknown {
  let current: unknown = data;
  for (const segment of dotted.split(".")) {
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      const next = (current as Record<string, unknown>)[segment];
      if (next === undefined) {
        return null;
      }
      current = next;
    } else {
      return null;
    }
  }
  return current;
}

export function applySince(
  entries: Array<Record<string, unknown>>,
  since: string,
): Array<Record<string, unknown>> {
  const sinceYm = since.slice(0, 7);
  return entries.filter((entry) => {
    const date = entry.date;
    return typeof date === "string" && date.length > 0 && date >= sinceYm;
  });
}

export function applyTags(
  entries: Array<Record<string, unknown>>,
  tags: string[],
): Array<Record<string, unknown>> {
  const wanted = new Set(tags);
  return entries.filter((entry) => {
    const entryTags = entry.tags;
    if (!Array.isArray(entryTags)) {
      return false;
    }
    return entryTags.some((tag) => wanted.has(String(tag)));
  });
}

export function applyTriggers(
  entries: Array<Record<string, unknown>>,
  triggers: string[],
): Array<Record<string, unknown>> {
  const wanted = new Set(triggers.map((trigger) => trigger.toLowerCase()));
  return entries.filter((entry) => {
    const entryTriggers = entry.triggers;
    if (!Array.isArray(entryTriggers)) {
      return false;
    }
    return entryTriggers.some((trigger) => wanted.has(String(trigger).toLowerCase()));
  });
}

export function applyScalar(
  entries: Array<Record<string, unknown>>,
  field: string,
  values: string[],
): Array<Record<string, unknown>> {
  const wanted = new Set(values.map((value) => value.toLowerCase()));
  return entries.filter((entry) => wanted.has(String(entry[field] ?? "").toLowerCase()));
}

function normalizeIssue(value: string): string {
  return value.replace(/^#/, "").trim().toLowerCase();
}

export function applyIssueRefs(
  entries: Array<Record<string, unknown>>,
  issues: string[],
): Array<Record<string, unknown>> {
  const wanted = new Set(issues.map((issue) => normalizeIssue(issue)));
  return entries.filter((entry) => {
    const refs = entry.issue_refs;
    if (!Array.isArray(refs)) {
      return false;
    }
    return refs.some((ref) => wanted.has(normalizeIssue(String(ref))));
  });
}

export function applySelect(
  entries: Array<Record<string, unknown>>,
  select: Record<string, unknown>,
): Array<Record<string, unknown>> {
  let result = entries;
  const tierIn = select.tier_in;
  if (Array.isArray(tierIn) && tierIn.length > 0) {
    const wanted = new Set(tierIn.map((tier) => String(tier).toLowerCase()));
    result = result.filter((entry) => wanted.has(String(entry.tier ?? "").toLowerCase()));
  }
  const needles = select.body_contains_any;
  if (Array.isArray(needles) && needles.length > 0) {
    const lowered = needles.map((needle) => String(needle).toLowerCase());
    result = result.filter((entry) => {
      const body = String(entry.body ?? "").toLowerCase();
      return lowered.some((needle) => body.includes(needle));
    });
  }
  return result;
}

function validateFilters(
  sliceName: string,
  allowed: string[],
  filters: {
    since: string | null;
    tags: string[];
    triggers: string[];
    tiers: string[];
    domains: string[];
    issues: string[];
    ids: string[];
  },
): void {
  const provided: string[] = [];
  if (filters.since !== null) {
    provided.push("since");
  }
  if (filters.tags.length > 0) {
    provided.push("tag");
  }
  if (filters.triggers.length > 0) {
    provided.push("trigger");
  }
  if (filters.tiers.length > 0) {
    provided.push("tier");
  }
  if (filters.domains.length > 0) {
    provided.push("domain");
  }
  if (filters.issues.length > 0) {
    provided.push("issue");
  }
  if (filters.ids.length > 0) {
    provided.push("id");
  }
  for (const filt of provided) {
    if (!allowed.includes(filt)) {
      throw new UsageError(
        `slice '${sliceName}' does not support the --${filt} filter (allowed: ${allowed.join(", ") || "none"})`,
      );
    }
  }
}

export interface SliceResult {
  pack: string;
  slice: string;
  source: string;
  source_sha: string;
  count: number;
  results: Array<Record<string, unknown>>;
}

export function slicePack(
  packId: string,
  sliceName: string,
  registry: Record<string, Record<string, unknown>>,
  sourceData: Record<string, unknown>,
  sourcePath: string,
  options: {
    since?: string | null;
    tags?: string[] | null;
    triggers?: string[] | null;
    tiers?: string[] | null;
    domains?: string[] | null;
    issues?: string[] | null;
    ids?: string[] | null;
    repoRoot?: string;
  } = {},
): SliceResult {
  if (!(sliceName in registry)) {
    const suggestions = getCloseMatches(sliceName, Object.keys(registry), 1);
    throw new UsageError(`unknown slice '${sliceName}' for pack ${packId}`, suggestions[0] ?? null);
  }

  const spec = registry[sliceName] as Record<string, unknown>;
  const allowedRaw = spec.filters;
  const allowed = Array.isArray(allowedRaw) ? allowedRaw.map(String) : [];
  const since = options.since ?? null;
  const tags = options.tags ?? [];
  const triggers = options.triggers ?? [];
  const tiers = options.tiers ?? [];
  const domains = options.domains ?? [];
  const issues = options.issues ?? [];
  const ids = options.ids ?? [];

  validateFilters(sliceName, allowed, {
    since,
    tags,
    triggers,
    tiers,
    domains,
    issues,
    ids,
  });

  if (since !== null && !isValidSince(since)) {
    throw new UsageError(`--since must be YYYY-MM or YYYY-MM-DD, got '${since}'`);
  }

  const resolved = resolveDottedPath(sourceData, String(spec.path));
  let entries: Array<Record<string, unknown>> = Array.isArray(resolved)
    ? (resolved as Array<Record<string, unknown>>)
    : [];

  const select = spec.select;
  if (typeof select === "object" && select !== null && !Array.isArray(select)) {
    entries = applySelect(entries, select as Record<string, unknown>);
  }

  if (since !== null) {
    entries = applySince(entries, since);
  }
  if (tags.length > 0) {
    entries = applyTags(entries, tags);
  }
  if (triggers.length > 0) {
    entries = applyTriggers(entries, triggers);
  }
  if (tiers.length > 0) {
    entries = applyScalar(entries, "tier", tiers);
  }
  if (domains.length > 0) {
    entries = applyScalar(entries, "domain", domains);
  }
  if (issues.length > 0) {
    entries = applyIssueRefs(entries, issues);
  }
  if (ids.length > 0) {
    entries = applyScalar(entries, "id", ids);
  }

  return {
    pack: packId,
    slice: sliceName,
    source: relToRepo(sourcePath, options.repoRoot),
    source_sha: sha256File(sourcePath),
    count: entries.length,
    results: entries,
  };
}

export function listSlices(
  packId: string,
  registry: Record<string, Record<string, unknown>>,
  sourcePath: string,
  repoRoot?: string,
): Record<string, unknown> {
  const slices = Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => ({
      name,
      description: spec.description ?? "",
      filters: spec.filters ?? [],
    }));
  return {
    pack: packId,
    source: relToRepo(sourcePath, repoRoot),
    source_sha: sha256File(sourcePath),
    slices,
  };
}

export function oneLine(text: string): string {
  const folded = text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
  const head = folded.split(". ", 1)[0] ?? "";
  return head.length > 0 ? head.replace(/\.$/, "") : "";
}

export function discoverPacks(
  packsDir: string = PACKS_DIR,
  schemasDir: string = SCHEMAS_DIR,
  repoRoot?: string,
): Array<Record<string, unknown>> {
  const packs: Array<Record<string, unknown>> = [];
  if (!existsSync(packsDir) || !statSync(packsDir).isDirectory()) {
    return packs;
  }
  for (const entry of readdirSync(packsDir).sort()) {
    const packDir = join(packsDir, entry);
    if (!statSync(packDir).isDirectory()) {
      continue;
    }
    const shortName = entry;
    const sources = readdirSync(packDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(packDir, name));
    if (sources.length === 0) {
      continue;
    }
    const sourcePath = sources[0] as string;
    let sourceData: Record<string, unknown>;
    try {
      sourceData = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const packId = String(sourceData.pack ?? shortName);
    const version = String(sourceData.version ?? "");

    let description = "";
    const schemaPath = join(schemasDir, `${shortName}-pack.schema.json`);
    if (existsSync(schemaPath)) {
      try {
        const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
        description = oneLine(String(schema.description ?? schema.title ?? ""));
      } catch {
        description = "";
      }
    }

    packs.push({
      name: shortName,
      pack: packId,
      version,
      description,
      source: relToRepo(sourcePath, repoRoot),
    });
  }
  return packs;
}

export function listPacks(
  packsDir: string = PACKS_DIR,
  schemasDir: string = SCHEMAS_DIR,
  repoRoot?: string,
): Record<string, unknown> {
  return { packs: discoverPacks(packsDir, schemasDir, repoRoot) };
}

export function formatListPacksText(payload: Record<string, unknown>): string {
  const packs = payload.packs as Array<Record<string, unknown>>;
  if (!Array.isArray(packs) || packs.length === 0) {
    return "No content packs found.\n";
  }
  const nameWidth = Math.max(...packs.map((pack) => String(pack.name).length));
  const versionWidth = Math.max(...packs.map((pack) => String(pack.version).length));
  const lines = ["Available content packs:"];
  for (const pack of packs) {
    lines.push(
      `  ${String(pack.name).padEnd(nameWidth)}  ${String(pack.version).padEnd(versionWidth)}  ${String(pack.description)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatSliceText(
  result: SliceResult,
  display: Record<string, unknown> | null = null,
): string {
  const displaySpec = display ?? DEFAULT_DISPLAY;
  const header =
    `# pack: ${result.pack} | slice: ${result.slice} | ` +
    `source: ${result.source} | source_sha: ${result.source_sha} | ` +
    `${result.count} result(s)`;
  const noun = String(displaySpec.noun ?? "entries");
  if (result.results.length === 0) {
    return `${header}\n\n(no matching ${noun})`;
  }

  const headingField = String(displaySpec.heading ?? "title");
  const fieldSpecs = Array.isArray(displaySpec.fields) ? displaySpec.fields.map(String) : [];
  const bodyField = displaySpec.body;

  const parts = [header];
  for (const entry of result.results) {
    let block = `\n## ${String(entry[headingField])}\n`;
    const fieldLines: string[] = [];
    for (const field of fieldSpecs) {
      const value = entry[field];
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        continue;
      }
      const rendered = Array.isArray(value) ? value.map(String).join(", ") : String(value);
      fieldLines.push(`- ${field}: ${rendered}`);
    }
    if (fieldLines.length > 0) {
      block += `\n${fieldLines.join("\n")}\n`;
    }
    if (bodyField !== null && bodyField !== undefined) {
      const body = entry[String(bodyField)];
      if (body) {
        block += `\n${String(body)}\n`;
      }
    }
    parts.push(block);
  }
  return parts.join("");
}

export function formatListText(payload: Record<string, unknown>): string {
  const slices = payload.slices as Array<Record<string, unknown>>;
  const lines = [`Slices for pack ${String(payload.pack)} (source: ${String(payload.source)}):`];
  const width =
    slices.length > 0 ? Math.max(...slices.map((slice) => String(slice.name).length)) : 0;
  for (const slice of slices) {
    const filtersRaw = slice.filters;
    const filters = Array.isArray(filtersRaw) ? filtersRaw.map(String) : [];
    const filterText = filters.length > 0 ? filters.join(", ") : "none";
    lines.push(
      `  ${String(slice.name).padEnd(width)}  ${String(slice.description)}  [filters: ${filterText}]`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function collectTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    for (const part of item.split(",")) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

interface ParsedCliArgs {
  pack: string | null;
  name: string | null;
  since: string | null;
  tag: string[];
  trigger: string[];
  tier: string[];
  domain: string[];
  issue: string[];
  ids: string[];
  format: "text" | "json";
  listSlices: boolean;
  listPacks: boolean;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    pack: null,
    name: null,
    since: null,
    tag: [],
    trigger: [],
    tier: [],
    domain: [],
    issue: [],
    ids: [],
    format: "text",
    listSlices: false,
    listPacks: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--list") {
      parsed.listSlices = true;
    } else if (arg === "--list-packs") {
      parsed.listPacks = true;
    } else if (arg === "--since") {
      parsed.since = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--since=")) {
      parsed.since = arg.slice("--since=".length);
    } else if (arg === "--format") {
      const value = argv[i + 1] ?? "text";
      parsed.format = value === "json" ? "json" : "text";
      i += 1;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      parsed.format = value === "json" ? "json" : "text";
    } else if (arg === "--tag") {
      parsed.tag.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--tag=")) {
      parsed.tag.push(arg.slice("--tag=".length));
    } else if (arg === "--trigger") {
      parsed.trigger.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--trigger=")) {
      parsed.trigger.push(arg.slice("--trigger=".length));
    } else if (arg === "--tier") {
      parsed.tier.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--tier=")) {
      parsed.tier.push(arg.slice("--tier=".length));
    } else if (arg === "--domain") {
      parsed.domain.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--domain=")) {
      parsed.domain.push(arg.slice("--domain=".length));
    } else if (arg === "--issue") {
      parsed.issue.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--issue=")) {
      parsed.issue.push(arg.slice("--issue=".length));
    } else if (arg === "--id") {
      parsed.ids.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--id=")) {
      parsed.ids.push(arg.slice("--id=".length));
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  parsed.pack = positionals[0] ?? null;
  parsed.name = positionals[1] ?? null;
  return parsed;
}

export function main(argv?: string[]): number {
  const args = parseCliArgs(argv ?? process.argv.slice(2));
  const fmt = args.format;
  const tags = collectTags(args.tag);
  const triggers = collectTags(args.trigger);
  const tiers = collectTags(args.tier);
  const domains = collectTags(args.domain);
  const issues = collectTags(args.issue);
  const ids = collectTags(args.ids);

  try {
    if (args.listPacks) {
      const payload = listPacks();
      if (fmt === "json") {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stdout.write(formatListPacksText(payload));
      }
      return 0;
    }

    if (args.pack === null) {
      throw new UsageError("a pack name is required (or pass --list-packs)");
    }

    const [sourcePath, schemaPath] = resolvePack(args.pack);
    const registry = loadRegistry(schemaPath);
    const display = loadDisplay(schemaPath);
    const sourceData = loadSource(sourcePath);
    const packId = String(sourceData.pack ?? args.pack);

    if (args.listSlices) {
      const payload = listSlices(packId, registry, sourcePath);
      if (fmt === "json") {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stdout.write(formatListText(payload));
      }
      return 0;
    }

    if (args.name === null) {
      throw new UsageError("a slice name is required (or pass --list)");
    }

    const result = slicePack(packId, args.name, registry, sourceData, sourcePath, {
      since: args.since,
      tags,
      triggers,
      tiers,
      domains,
      issues,
      ids,
    });
    if (fmt === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatSliceText(result, display));
    }
    return 0;
  } catch (exc) {
    if (exc instanceof UsageError) {
      let msg = `error: ${exc.message}`;
      if (exc.suggestion) {
        msg += `. Did you mean '${exc.suggestion}'?`;
      }
      process.stderr.write(`${msg}\n`);
      return 2;
    }
    throw exc;
  }
}
