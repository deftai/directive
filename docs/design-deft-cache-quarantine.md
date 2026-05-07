# Design: Unified Content Cache and Quarantine Layer

**Status:** Draft  
**Related issues:** #845 (issue triage), #583 (injection quarantine), #835 (memory write security), #881 (scm:* tasks), #610 (wiki-llm)

---

## Problem

Directive is accumulating multiple ad-hoc cache implementations for the same underlying concern: external content arrives from untrusted sources, needs to be persisted locally, sanitized before LLM consumption, and eventually invalidated. Today this happens in at least three places with three different designs:

- **#845 triage** — `.deft-cache/issues/<repo>/<N>.{json,md}` for GitHub issues
- **#583/#835** — separate quarantine scans for ingested content and memory writes
- **#610 wiki-llm** — unspecified ingress mechanism for knowledge base pages

Building a content-agnostic, shared cache and quarantine layer once prevents three incompatible implementations, establishes consistent security properties across all ingress paths, and gives TTL and invalidation the proper treatment they require.

---

## Goals

1. Content-agnostic — works for GitHub issues, PR reviews, URLs, emails, files, webhook payloads
2. Consistent quarantine — every external content item passes the same injection scanner before storage
3. Proper TTL and invalidation — entries expire, mutations invalidate, cleanup runs automatically
4. Clean integration with `scm:*` tasks — fetching is the task namespace's job; caching is the cache layer's job
5. ghx-compatible — ghx handles within-session API deduplication; this handles cross-session persistence and quarantine

---

## Architecture

### Storage layout

```
.deft-cache/           ← gitignored by default (may contain sensitive content)
  meta.json            ← global: cache version, per-source stats, last-prune timestamp
  quarantine-audit.jsonl ← append-only log of all scan results
  <source>/
    <key>/
      raw.json         ← original fetched data, unmodified
      content.md       ← quarantine-passed content, safe for LLM consumption
      meta.json        ← TTL, fetched_at, etag, scan_result, source, key
```

**Two files per entry — always:**

`raw.json` is the immutable record of what was received. It is never fed to an LLM directly. It exists for auditing, re-scanning on updated rules, and debugging.

`content.md` is the quarantine-passed version. It is what flows into triage evaluation, wiki-llm ingestion, and any other LLM-consuming workflow. It is only written when the quarantine scan passes. If the scan fails, `content.md` is absent and `meta.json.scan_result.passed` is `false`.

### Source types

| Source | Key format | Default TTL | Invalidation trigger |
|---|---|---|---|
| `github-issue` | `<owner>/<repo>/<N>` | 7 days | `scm:issue:close`, `scm:issue:edit` |
| `github-pr` | `<owner>/<repo>/<N>` | 1 day | `scm:pr:merge`, `scm:pr:close` |
| `github-review` | `<owner>/<repo>/<N>/reviews` | 1 hour | `scm:pr:merge` |
| `url` | `sha256(<url>)` | 24 hours | Explicit only |
| `email` | `<message-id>` | 30 days | Explicit only |
| `file` | `<path>` | Checksum-based | File modification |

Source types are explicit, not inferred from key format. This enables type-specific TTLs and invalidation strategies without ambiguity.

### Entry metadata (`meta.json`)

```json
{
  "source": "github-issue",
  "key": "deftai/directive/845",
  "fetched_at": "2026-05-04T00:00:00Z",
  "ttl_seconds": 604800,
  "expires_at": "2026-05-11T00:00:00Z",
  "etag": "abc123",
  "scan_result": {
    "passed": true,
    "scanned_at": "2026-05-04T00:00:01Z",
    "scanner_version": "1.0.0",
    "flags": []
  },
  "size_bytes": 4821,
  "stale": false
}
```

---

## Task interface

### Core operations

```bash
# Store content (runs quarantine scan first; fails if scan fails)
task cache:put SOURCE KEY --content-file /tmp/content.json [--ttl=7d] [--etag=abc123]

# Retrieve cached content (returns content.md path + metadata)
task cache:get SOURCE KEY [--allow-stale]

# Check if entry exists and is fresh
task cache:check SOURCE KEY

# Explicitly invalidate an entry
task cache:invalidate SOURCE KEY [--reason="issue closed"]

# Re-fetch and re-quarantine an existing entry
task cache:refresh SOURCE KEY

# Prune expired and stale entries
task cache:prune [--older-than=30d] [--source=github-issue] [--dry-run]

# Show cache statistics
task cache:stats [--source=github-issue] [--json]

# Verify cache integrity (missing files, corrupt meta, scan results that should be re-run)
task cache:doctor

# Run the quarantine scanner standalone (for testing / manual use)
task quarantine:scan --content-file /tmp/content.md [--source=github-issue]
```

### Bulk fetch (integrates scm:* tasks)

```bash
# Fetch all open issues for a repo into cache
task cache:fetch-all --source=github-issue --repo=deftai/directive [--ttl=7d]

# Internally: task scm:issue:list → for each N: task scm:issue:view PR=N | task cache:put
```

The bulk fetch is a thin orchestrator. `scm:*` tasks do the fetching; `cache:put` does the storage and quarantine. They are composable, not coupled.

---

## Quarantine scanner

Runs on every `cache:put` before writing `content.md`. Checks for:

- **Prompt injection signatures** — "ignore previous instructions", "disregard above", "new system prompt", "you are now", etc.
- **Credential patterns** — private key headers, API key formats (sk-..., ghp_...), bearer tokens
- **Shell command injection** — patterns that look like instructions to run commands disguised as facts
- **Invisible Unicode** — U+200B (zero-width space), U+FEFF (BOM), other invisible control characters
- **Exfiltration patterns** — instructions to send content to external endpoints

Scan result is recorded in `meta.json` and appended to `quarantine-audit.jsonl`. The audit log is never trimmed — it is the complete record of what was received, when, and what was flagged.

When a scan fails:
- `raw.json` is written (original content preserved for audit)
- `content.md` is NOT written
- `meta.json.scan_result.passed` is `false`
- `cache:put` exits non-zero with a structured error describing the flag
- Callers must handle this case explicitly; they cannot silently consume quarantine failures

The scanner is versioned. When scanner rules are updated (version bump), entries can be re-scanned via `cache:doctor --rescan`.

---

## TTL and invalidation

### TTL mechanics

- Every entry has `fetched_at` + `ttl_seconds` → computed `expires_at`
- On `cache:get`: if current time > `expires_at`, entry is stale
- Default behavior on stale hit: return stale content with `stale: true` flag in metadata, so callers can decide (serve stale, refresh, or block)
- `--allow-stale` flag: explicitly accept stale content (for offline/degraded mode)
- `--no-stale` flag: fail if entry is stale (for strict freshness requirements)

### Mutation-triggered invalidation

`scm:*` mutation tasks emit an invalidation call after execution:

```yaml
scm:issue:close:
  cmds:
    - GH_PAGER=cat ghx issue close {{.N}} --comment "{{.REASON}}" --json
    - task cache:invalidate github-issue {{.REPO}}/{{.N}} --reason="closed upstream"
```

This is automatic — the caller doesn't need to know about the cache. The `scm:*` task encapsulates both the mutation and the cache invalidation. Clean interface, correct behavior.

### ETag-based conditional refresh

When an entry has an `etag`, `cache:refresh` issues a conditional request:

```bash
task scm:issue:view N=845 --etag=abc123
# → If upstream returns 304 Not Modified: update fetched_at, extend TTL, skip re-scan
# → If upstream returns 200: re-quarantine, write new raw.json and content.md
```

This reduces API calls and quarantine overhead for frequently-checked entries.

### Cleanup and prune

`task cache:prune` removes entries where `expires_at` is older than the prune threshold. It does not touch entries that are stale but within the prune window (configurable).

Recommended: run `cache:prune --older-than=30d` weekly via the dream cycle / skill curator pattern.

---

## Integration points

### triage (#845)

`task triage:cache` becomes:

```bash
task cache:fetch-all --source=github-issue --repo={{.REPO}}
```

The triage workflow then calls `task cache:get github-issue <REPO>/<N>` to get the quarantined `content.md` for each candidate. `candidates.jsonl` remains the triage *decision* log — orthogonal to the cache.

### wiki-llm (#610)

```bash
task wiki:ingest --url https://example.com/article
# → internally: task cache:put url <hash> --content-file <fetched> --ttl=24h
# → reads content.md for the quarantine-passed version
# → feeds content.md into compiled-truth-timeline format (#820)
```

All wiki ingress goes through the quarantine layer. No raw external content reaches the LLM.

### scm:* tasks (#881)

`scm:*` tasks are the *fetching* layer. The cache is the *persistence + quarantine* layer. They compose:

```
scm:issue:view → raw JSON → cache:put → quarantine scan → content.md
```

`scm:*` tasks do not write to cache themselves. Callers decide whether to cache. This keeps `scm:*` tasks pure (fetch-only) and the cache layer focused (persist + quarantine).

### ghx

ghx handles within-session API deduplication and speed (~0.1s vs ~1s). The deft cache handles cross-session persistence and security quarantine. They operate at different layers:

- ghx: transparent proxy between `scm:*` tasks and GitHub API
- deft cache: intentional, managed, queryable content store

When `scm:issue:view` is called during `cache:fetch-all`, ghx coalesces concurrent requests. The response flows into `cache:put`. Both layers contribute without conflict.

---

## Configuration

```yaml
# In project config (e.g. .deft/config.yaml)
cache:
  dir: .deft-cache          # default; gitignored
  default_ttls:
    github-issue: 604800    # 7 days
    github-pr: 86400        # 1 day
    github-review: 3600     # 1 hour
    url: 86400              # 24 hours
    email: 2592000          # 30 days
  prune_threshold_days: 30  # entries older than this are pruned
  stale_behavior: warn      # warn | fail | allow
  scanner_version: "1.0.0"
  audit_log: .deft-cache/quarantine-audit.jsonl
```

---

## What this is NOT

- **Not a secret store** — credentials go in `secrets/` per directive convention; cache holds content
- **Not a search index** — bulk metadata queries (label/author/age filters) run against `meta.json` files; full-text search is out of scope for v1
- **Not a replication layer** — entries are local only; no sync, no remote storage
- **Not a replacement for ghx** — ghx handles API efficiency; this handles persistence and security

---

## Open questions

1. **Scanner pattern registry** — flat list in code, or configurable YAML patterns? YAML enables per-project custom rules without code changes.
2. **Re-scan on rule update** — when scanner version bumps, should `cache:doctor` automatically re-scan existing entries? Probably yes for security-critical updates.
3. **Disk quota** — should `cache:prune` enforce a maximum cache size in addition to age-based pruning?
4. **Private-repo content** — cache stores issue bodies which may be sensitive. `.gitignore` is mandatory; should the cache also encrypt at rest for extra-sensitive repos?

---

## Acceptance criteria

- [ ] `cache:put` runs quarantine scan on all content before writing `content.md`
- [ ] `cache:put` exits non-zero and does not write `content.md` when scan fails
- [ ] `cache:get` returns `stale: true` for expired entries; does not silently serve stale
- [ ] `scm:issue:close` and `scm:pr:merge` automatically invalidate related cache entries
- [ ] `cache:prune` removes entries beyond the prune threshold; reports what was removed
- [ ] `cache:doctor` identifies corrupt entries, missing `content.md` (failed scan), and entries with outdated scanner versions
- [ ] `quarantine-audit.jsonl` receives an entry for every `cache:put` regardless of scan result
- [ ] `.deft-cache/` is in `.gitignore` by default; `task setup` verifies this
- [ ] wiki-llm ingress and issue triage both use `cache:put`/`cache:get` rather than direct file writes
