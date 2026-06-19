import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_SOURCES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DELAY_MS,
  DEFAULT_PRUNE_OLDER_THAN_DAYS,
} from "./constants.js";
import {
  CacheCapBreachedError,
  CacheError,
  CacheFetchError,
  CacheNotFoundError,
  CacheValidationError,
} from "./errors.js";
import { cacheFetchAll, cacheRefreshClosed } from "./fetch.js";
import { pythonBool, pythonJsonPretty } from "./json.js";
import { cacheGet, cacheInvalidate, cachePrune, cachePruneToCap, cachePut } from "./operations.js";
import { resolveCaps } from "./quota.js";

function normaliseLabelFilter(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  return raw.flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function usage(): void {
  process.stderr.write("usage: cache [-h] {put,get,invalidate,fetch-all,prune} ...\n");
}

function cmdPut(args: string[]): number {
  let source = "";
  let key = "";
  let rawFile: string | undefined;
  let ttlSeconds: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--raw-file") {
      rawFile = args[i + 1];
      i += 1;
    } else if (arg === "--ttl-seconds") {
      ttlSeconds = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (!source) {
      source = arg ?? "";
    } else if (!key) {
      key = arg ?? "";
    } else {
      throw new CacheError(`unexpected argument: ${arg}`);
    }
  }
  if (!source || !key || !rawFile) {
    process.stderr.write(
      "usage: cache put [-h] --raw-file RAW_FILE [--ttl-seconds TTL_SECONDS] {github-issue} key\n",
    );
    process.stderr.write(
      "cache put: error: the following arguments are required: source, key, --raw-file\n",
    );
    return 2;
  }
  if (!ALLOWED_SOURCES.includes(source)) {
    process.stderr.write(`cache put: error: invalid source '${source}'\n`);
    return 2;
  }
  const rawPath = resolve(rawFile);
  if (!existsSync(rawPath)) {
    throw new CacheError(`--raw-file not found: ${rawPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(rawPath, "utf8"));
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new CacheError(`--raw-file is not valid JSON: ${msg}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CacheError(
      `--raw-file must be a JSON object (got ${Array.isArray(raw) ? "array" : typeof raw})`,
    );
  }
  const result = cachePut(source, key, raw as Record<string, unknown>, { ttlSeconds });
  const flagCats = result.scanResult.flags.map((f) => `'${f.category}'`).join(", ");
  process.stdout.write(
    `cache:put source=${result.source} key=${result.key} scan_passed=${pythonBool(result.scanResult.passed)} flags=[${flagCats}] content_written=${pythonBool(result.contentWritten)} dir=${result.entryDir}\n`,
  );
  return result.scanResult.passed ? 0 : 2;
}

function cmdGet(args: string[]): number {
  let source = "";
  let key = "";
  let allowStale = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allow-stale") {
      allowStale = true;
    } else if (arg === "--no-stale") {
      allowStale = false;
    } else if (!source) {
      source = arg ?? "";
    } else if (!key) {
      key = arg ?? "";
    }
  }
  if (!source || !key) {
    process.stderr.write("usage: cache get [-h] {github-issue} key [--allow-stale | --no-stale]\n");
    return 2;
  }
  try {
    const result = cacheGet(source, key, { allowStale });
    const payload = {
      source: result.source,
      key: result.key,
      entry_dir: result.entryDir,
      content_path: result.contentPath,
      stale: result.stale,
      meta: result.meta,
    };
    process.stdout.write(`${pythonJsonPretty(payload)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof CacheNotFoundError) {
      process.stderr.write(`cache:get miss: ${JSON.stringify(err.message)}\n`);
      return 1;
    }
    throw err;
  }
}

function cmdInvalidate(args: string[]): number {
  let source = "";
  let key = "";
  let reason: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--reason") {
      reason = args[i + 1];
      i += 1;
    } else if (!source) {
      source = arg ?? "";
    } else if (!key) {
      key = arg ?? "";
    }
  }
  if (!source || !key) {
    process.stderr.write("usage: cache invalidate [-h] {github-issue} key [--reason TEXT]\n");
    return 2;
  }
  const existed = cacheInvalidate(source, key, { reason });
  process.stdout.write(
    `cache:invalidate source=${source} key=${key} existed=${pythonBool(existed)}\n`,
  );
  return 0;
}

function cmdFetchAll(args: string[]): number {
  let source = "";
  let repo = "";
  let batchSize = DEFAULT_BATCH_SIZE;
  let delayMs = DEFAULT_DELAY_MS;
  let ttlSeconds: number | undefined;
  let state = "open";
  let limit = 1000;
  const labels: string[] = [];
  let author: string | undefined;
  let refreshClosed = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--source") {
      source = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo") {
      repo = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--batch-size") {
      batchSize = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--delay-ms") {
      delayMs = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--ttl-seconds") {
      ttlSeconds = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--state") {
      state = args[i + 1] ?? "open";
      i += 1;
    } else if (arg === "--limit") {
      limit = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--label") {
      labels.push(args[i + 1] ?? "");
      i += 1;
    } else if (arg === "--author") {
      author = args[i + 1];
      i += 1;
    } else if (arg === "--refresh-closed") {
      refreshClosed = true;
    }
  }

  if (!source || !repo) {
    process.stderr.write("usage: cache fetch-all --source SOURCE --repo OWNER/NAME [options]\n");
    return 2;
  }

  const report = cacheFetchAll({
    source,
    repo,
    batchSize,
    delayMs,
    ttlSeconds,
    state,
    limit,
    labels: normaliseLabelFilter(labels),
    author: author ?? null,
  });
  process.stdout.write(`${report.toJson()}\n`);
  let rc = report.issuesFailed === 0 ? 0 : 1;
  if (refreshClosed) {
    const refresh = cacheRefreshClosed({
      source,
      repo,
      ttlSeconds,
      delayMs,
      limit,
    });
    process.stdout.write(`${refresh.toJson()}\n`);
    if (refresh.refreshFailed) rc = 1;
  }
  return rc;
}

function cmdPrune(args: string[]): number {
  let olderThanDays = DEFAULT_PRUNE_OLDER_THAN_DAYS;
  let source: string | undefined;
  let dryRun = false;
  let toCap = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--older-than-days") {
      olderThanDays = Number.parseInt(args[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--source") {
      source = args[i + 1];
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--to-cap") {
      toCap = true;
    }
  }

  if (toCap) {
    const evicted = cachePruneToCap({ dryRun });
    const caps = resolveCaps();
    const payload = {
      mode: "to-cap",
      max_bytes: caps.maxBytes,
      max_entries: caps.maxEntries,
      dry_run: dryRun,
      evicted_count: evicted.length,
      evicted_keys: evicted.map((e) => `${e.source}/${e.key}`),
      freed_bytes: evicted.reduce((sum, e) => sum + e.sizeBytes, 0),
    };
    process.stdout.write(`${pythonJsonPretty(payload)}\n`);
    return 0;
  }

  const removed = cachePrune({ olderThanDays, source, dryRun });
  const payload = {
    older_than_days: olderThanDays,
    source: source ?? "all",
    dry_run: dryRun,
    removed_count: removed.length,
    removed_paths: removed,
  };
  process.stdout.write(`${pythonJsonPretty(payload)}\n`);
  return 0;
}

/** CLI entry point (mirrors `scripts/cache.py::main`). */
export function main(argv: readonly string[]): number {
  if (argv.length === 0) {
    usage();
    process.stderr.write("cache: error: the following arguments are required: cmd\n");
    return 2;
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  try {
    switch (cmd) {
      case "put":
        return cmdPut(rest);
      case "get":
        return cmdGet(rest);
      case "invalidate":
        return cmdInvalidate(rest);
      case "fetch-all":
        return cmdFetchAll(rest);
      case "prune":
        return cmdPrune(rest);
      default:
        usage();
        process.stderr.write(`cache: error: argument cmd: invalid choice: '${cmd}'\n`);
        return 2;
    }
  } catch (err) {
    if (err instanceof CacheCapBreachedError) {
      process.stderr.write(`cache: cap breached: ${err.message}\n`);
      return 3;
    }
    if (err instanceof CacheError || err instanceof CacheFetchError) {
      process.stderr.write(`cache: error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof CacheValidationError) {
      process.stderr.write(`cache: schema error: ${err.message}\n`);
      return 2;
    }
    /* v8 ignore next -- unexpected internal errors propagate */
    throw err;
  }
}
