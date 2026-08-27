import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_RE } from "../cache/constants.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { defaultWhich, resolveBinary, type WhichFn } from "../scm/binary.js";
import { restIssueListOpenInventory } from "../scm/gh-rest.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import type { IssueRef } from "./refs.js";

export type IssueState = "open" | "closed";

/**
 * How a verdict was reached (#3767). `unverified` means the gate could not
 * establish state, so a pass on that reference proves nothing.
 */
export type StateBasis = "inventory" | "live" | "cache" | "unverified";

export type StateResolution =
  /** Resolved from the complete open-issue inventory or an authoritative read. */
  | { readonly state: IssueState; readonly basis: "inventory" | "live" }
  /** Resolved from a triage-cache entry inside the freshness bound. */
  | { readonly state: IssueState; readonly basis: "cache"; readonly cacheAgeMs: number }
  /** State could not be established; a pass on this reference proves nothing. */
  | { readonly state: null; readonly basis: "unverified"; readonly detail: string };

/**
 * A cache hit older than this is no longer evidence (#3767). The measured
 * defect was a ~12 h old cached `open` suppressing the live read that would
 * have corrected it; 15 min keeps warm-cache offline runs working while making
 * an overnight entry non-authoritative.
 */
export const ISSUE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Latency budget for scoped `--issue N`: one authoritative issue read plus at
 * most one linked-PR read. Measured ~0.75 s per `gh api` read; the headroom
 * covers a slow network or a `ghx` proxy hop.
 */
export const SCOPED_LATENCY_BUDGET_MS = 5_000;

/**
 * Latency budget for the unscoped aggregate sweep. One complete open-issue
 * inventory measured 4.2 s constant on deftai/directive (560 open issues),
 * against 14.2 s and 76.6 s for per-brief reads at the WIP cap of 20 on two
 * hosts. The budget is sized for the inventory plus a few confirming reads and
 * keeps the gate inside the fast-preflight tier.
 */
export const AGGREGATE_LATENCY_BUDGET_MS = 15_000;

/** `resolveBinary` view that hides `ghx`, so this gate reads through plain `gh` when it exists. */
const GH_ONLY_WHICH: WhichFn = (name) => (name === "ghx" ? null : defaultWhich(name));

export interface GateRunner {
  readonly runGh: RunGhFn;
  /**
   * True when reads resolve through `ghx`, a cached GET proxy. The freshness
   * guarantee is then bounded by that proxy, which this gate cannot inspect.
   */
  readonly proxied: boolean;
}

/**
 * Pin plain `gh` for this gate's authoritative reads (#3767). `resolveBinary`
 * prefers `ghx` — a cached GET proxy — so an unpinned "live" read is itself a
 * cache. When `gh` is absent we still run, and report the proxy caveat rather
 * than claiming freshness we cannot deliver. Whether `ghx` should be preferred
 * at all is #3737.
 */
export function makeGateRunner(): GateRunner {
  let pinned: string | null = null;
  try {
    pinned = resolveBinary(GH_ONLY_WHICH);
  } catch {
    pinned = null;
  }
  if (pinned === null) {
    return { runGh: defaultRunGh, proxied: true };
  }
  const binary = pinned;
  return { runGh: (cmd) => defaultRunGh(cmd, binary), proxied: false };
}

function isSafeRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cacheEntryDir(projectRoot: string, ref: IssueRef): string | null {
  const [owner, name] = ref.repo.split("/", 2);
  if (!owner || !name) {
    return null;
  }
  return join(
    projectRoot,
    CACHE_DIR_NAME,
    CACHE_SOURCE_GITHUB_ISSUE,
    owner,
    name,
    String(ref.number),
  );
}

function cacheEntryAgeMs(entryDir: string, rawPath: string, nowMs: number): number | null {
  const meta = readJson(join(entryDir, "meta.json"));
  const stamp = meta?.fetched_at ?? meta?.cached_at ?? meta?.updated_at;
  if (typeof stamp === "string") {
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) {
      return Math.max(0, nowMs - parsed);
    }
  }
  try {
    return Math.max(0, nowMs - statSync(rawPath).mtimeMs);
  } catch {
    return null;
  }
}

interface CachedIssue {
  readonly state: IssueState | null;
  readonly ageMs: number | null;
}

const CACHE_MISS: CachedIssue = { state: null, ageMs: null };

/** Read the triage-cache issue state together with the entry's age (#3767). */
export function readCachedIssue(projectRoot: string, ref: IssueRef, nowMs: number): CachedIssue {
  const entryDir = cacheEntryDir(projectRoot, ref);
  if (entryDir === null) {
    return CACHE_MISS;
  }
  const rawPath = join(entryDir, "raw.json");
  if (!existsSync(rawPath)) {
    return CACHE_MISS;
  }
  const raw = readJson(rawPath);
  if (raw === null) {
    return CACHE_MISS;
  }
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : "";
  if (state !== "open" && state !== "closed") {
    return CACHE_MISS;
  }
  return { state, ageMs: cacheEntryAgeMs(entryDir, rawPath, nowMs) };
}

/** Authoritative single-issue REST read. Returns `null` on any failure. */
export function fetchIssueStateLive(ref: IssueRef, runGh: RunGhFn): IssueState | null {
  const result = runGh(["gh", "api", `repos/${ref.repo}/issues/${ref.number}`]);
  if (result.returncode !== 0) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (payload === null || typeof payload !== "object") {
      return null;
    }
    const state = (payload as Record<string, unknown>).state;
    return state === "open" || state === "closed" ? state : null;
  } catch {
    return null;
  }
}

type InventoryLookup = { numbers: ReadonlySet<number> } | { error: string };

/**
 * One complete open-issue inventory per repo per run (#3767, reusing #3752).
 * `restIssueListOpenInventory` fails closed on command failure, non-array JSON,
 * malformed rows, buffer exhaustion, and pagination cap — so absence from a
 * successful inventory really does mean "not open", and a truncated read is an
 * error rather than a silent "closed".
 */
export class OpenIssueInventory {
  private readonly byRepo = new Map<string, InventoryLookup>();
  private readonly confirmations = new Map<string, IssueState | null>();

  constructor(private readonly runGh: RunGhFn) {}

  lookup(repo: string): InventoryLookup {
    const memo = this.byRepo.get(repo);
    if (memo !== undefined) {
      return memo;
    }
    const resolved = this.fetch(repo);
    this.byRepo.set(repo, resolved);
    return resolved;
  }

  /**
   * Confirm an inventory absence with one authoritative read, reused for the
   * rest of this run when several briefs name the same issue (#3767).
   */
  confirm(ref: IssueRef): IssueState | null {
    const key = `${ref.repo}#${ref.number}`;
    if (this.confirmations.has(key)) {
      return this.confirmations.get(key) ?? null;
    }
    const confirmed = fetchIssueStateLive(ref, this.runGh);
    this.confirmations.set(key, confirmed);
    return confirmed;
  }

  private fetch(repo: string): InventoryLookup {
    try {
      const rows = restIssueListOpenInventory(repo, {
        runGhApiFn: (args) => this.runGh(["gh", "api", ...args]),
      });
      const numbers = new Set<number>();
      for (const row of rows) {
        const n = row.number;
        if (typeof n === "number" && Number.isInteger(n)) {
          numbers.add(n);
        }
      }
      return { numbers };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message.split("\n")[0] ?? "unknown error" };
    }
  }
}

export interface ResolveContext {
  readonly projectRoot: string;
  readonly runGh: RunGhFn;
  readonly skipGh: boolean;
  readonly nowMs: number;
  readonly inventory: OpenIssueInventory;
}

function unverified(detail: string): StateResolution {
  return { state: null, basis: "unverified", detail };
}

/** A cache entry recent enough to still count as evidence, with its age pinned. */
type FreshCache = { readonly state: IssueState; readonly ageMs: number };

function freshOrNull(cached: CachedIssue): FreshCache | null {
  return cached.state !== null && cached.ageMs !== null && cached.ageMs <= ISSUE_CACHE_MAX_AGE_MS
    ? { state: cached.state, ageMs: cached.ageMs }
    : null;
}

function fromCache(fresh: FreshCache): StateResolution {
  return { state: fresh.state, basis: "cache", cacheAgeMs: fresh.ageMs };
}

function staleDetail(cached: CachedIssue): string {
  const age = cached.ageMs === null ? "unknown age" : formatAge(cached.ageMs);
  return `cached ${cached.state} is ${age} old (max ${formatAge(ISSUE_CACHE_MAX_AGE_MS)})`;
}

/** Human-readable duration for basis reporting: `42s`, `9m`, `12h`, `3d`. */
export function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * Scoped `--issue N`: a proof obligation before DONE, so read authoritatively
 * first and accept a cache hit only inside the freshness bound. Unknown stays
 * fail-closed at the call site.
 */
export function resolveIssueStateScoped(ref: IssueRef, ctx: ResolveContext): StateResolution {
  if (!isSafeRepo(ref.repo)) {
    return unverified(`reference repo '${ref.repo}' is not a valid owner/repo slug`);
  }
  if (!ctx.skipGh) {
    const live = fetchIssueStateLive(ref, ctx.runGh);
    if (live !== null) {
      return { state: live, basis: "live" };
    }
  }
  const cached = readCachedIssue(ctx.projectRoot, ref, ctx.nowMs);
  const fresh = freshOrNull(cached);
  if (fresh !== null) {
    return fromCache(fresh);
  }
  if (cached.state !== null) {
    return unverified(`${staleDetail(cached)} and the authoritative read was unavailable`);
  }
  return unverified(
    ctx.skipGh ? "--skip-gh with no cache entry" : "live issue read failed and no cache entry",
  );
}

/**
 * Unscoped aggregate: resolve every reference from one complete open-issue
 * inventory rather than a live read per brief. Membership means open. Absence
 * means "not open", which is the direction that tells an operator to run
 * `scope:complete`, so it is confirmed by one authoritative read before the
 * gate acts on it.
 */
export function resolveIssueStateAggregate(ref: IssueRef, ctx: ResolveContext): StateResolution {
  if (!isSafeRepo(ref.repo)) {
    return unverified(`reference repo '${ref.repo}' is not a valid owner/repo slug`);
  }
  const cached = readCachedIssue(ctx.projectRoot, ref, ctx.nowMs);
  const fresh = freshOrNull(cached);
  if (ctx.skipGh) {
    if (fresh !== null) {
      return fromCache(fresh);
    }
    return unverified(
      cached.state === null
        ? "--skip-gh with no cache entry"
        : `--skip-gh and ${staleDetail(cached)}`,
    );
  }

  const inventory = ctx.inventory.lookup(ref.repo);
  if ("error" in inventory) {
    if (fresh !== null) {
      return fromCache(fresh);
    }
    return unverified(`open-issue inventory unavailable: ${inventory.error}`);
  }
  if (inventory.numbers.has(ref.number)) {
    return { state: "open", basis: "inventory" };
  }
  const confirmed = ctx.inventory.confirm(ref);
  if (confirmed !== null) {
    return { state: confirmed, basis: "live" };
  }
  return unverified("absent from the open-issue inventory but the confirming read failed");
}
