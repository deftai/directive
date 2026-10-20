# Repo-upgrade harness (Wave 4 / P0-6)

Real-repo upgrade proof: **clone → md5 → tip upgrade → md5 → allowlist → independent sanity + doctor**.

Sterile field:

- Fixtures **only** under `~/yolo-5490/fixtures/repo-upgrade/`
- **Never** dogfood `~/Projects/directive` as a consumer
- `source ~/yolo-5490/env.sh` + YOLO prefix / Verdaccio tip
- Tip tag default: `yolo-cp-wave4a` (falls back to `yolo-cp-wave3z`)

## Layout

```
~/yolo-5490/repo-upgrade/
  README.md
  run-sample.sh          # one sample
  run-all.sh             # catalog / survey JSON
  catalog.example.json
  lib/
    common.sh
    manifest.sh          # recursive md5 (myquickdiff or builtin)
    allowlist.sh         # planned change path patterns
    sanity.sh            # directive-install-sanity + doctor
```

Results land in `~/yolo-5490/logs/wave4/repo-upgrade-results/`.

## Quick start

```bash
source ~/yolo-5490/env.sh
export PATH="$HOME/yolo-5490/prefix/bin:$PATH"
export NPM_CONFIG_USERCONFIG="$HOME/yolo-5490/.npmrc-yolo"

# Dry-run synthetic smoke (no upgrade mutation beyond optional pre-install skip)
~/yolo-5490/repo-upgrade/run-sample.sh \
  --name local-smoke --source synthetic-ovpr-v --dry-run

# Live synthetic smoke (install older pin, then upgrade to tip)
~/yolo-5490/repo-upgrade/run-sample.sh \
  --name local-smoke --source synthetic-ovpr-v --tag yolo-cp-wave3z

# Batch from catalog / survey
~/yolo-5490/repo-upgrade/run-all.sh --dry-run
~/yolo-5490/repo-upgrade/run-all.sh --catalog ~/yolo-5490/logs/wave4/deftai-survey.json
```

When `~/yolo-5490/logs/wave4/deftai-survey.json` exists (P0-5), `run-all.sh` picks it up automatically.

## Per-sample protocol

1. **Materialize** clone (pinned SHA) or local/synthetic copy into  
   `~/yolo-5490/fixtures/repo-upgrade/<name>-<stamp>/`
2. Write hybrid `.npmrc` (`registry=npmjs`, `@deftai` → Verdaccio) **before** pre-manifest
3. **Pre-manifest** (see node_modules policy below)
4. Detect operation (`upgrade` / `install` / `convert`) and run tip:  
   `directive upgrade --yes --target-version <HT_VER>`  
   (or `install` for greenfield / forced install)
5. **Post-manifest**
6. Diff paths (removed / added / changed). Paths outside allowlist → **FAIL**
7. Independent sanity (`~/Projects/directive-install-sanity` via `npx tsx src/cli.ts --root …`) + `directive doctor` (non-mutating expectation)
8. Write `result.json` + `snippet.md` under results

## Manifest / node_modules policy

| Phase | `.git` | `node_modules` |
| --- | --- | --- |
| **pre** | excluded | **excluded entirely** (prefer hash before install churn) |
| **post** | excluded | excluded **except** `node_modules/@deftai/**` (pin/runtime surface) |

Prefer [`~/Projects/myquickdiff`](file:///Users/polfer/Projects/myquickdiff) (`md5tree.rb` / `quickdiff.rb`) when present. Fallback: builtin walker + `md5`/`md5sum`/`shasum -a 256`.

Manifest format: md5sum-style `hex  ./relative/path`, sorted.

## Operation detection

| Signal | Operation |
| --- | --- |
| `@deftai/directive-runtime` pin in package.json | `upgrade` |
| `.deft/core` and/or fat `@deftai/directive` dep (no runtime pin) | `convert` → runs `directive upgrade` (product migrate path); override with `--operation install` if needed |
| neither | `install` |

Catalog may set `"operation": "upgrade"|"install"|"convert"|"auto"`.

## Allowlist (initial)

Expected churn — refine per sample via `allowlist_extra`:

- `package.json` pin
- lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock*`)
- `.deft/**` (incl. `GENERATION.json`, wiring-ready markers)
- wiring / host files (`.agents/**`, `.claude/**`, `.cursor/**`, `.codex/**`, `.github/**`)
- `.githooks/**`, `Taskfile.yml` / `Taskfile.yaml`
- `AGENTS.md` / `CLAUDE.md` managed section (file-level allow)
- `.gitignore` / `.npmrc` (root only on default allowlist; nested `**/.gitignore` / `**/.gitkeep` are not product-owned — pre/post manifests prune only the `./.git` directory so tip-tree nested ignores do not false-add)
- `node_modules/@deftai/**`
- `xbrief/**` / `vbrief/**` (upgrade-owned migration)

**Unexpected application source edits → FAIL.**

Scoring (wave4e): convert that lands exact `@deftai/directive-runtime` pin, removes `.deft/core`, allowlist clean, and sanity PASS is **PASS_WITH_SETUP_CONFLICTS** when upgrade exits nonzero solely for unmanaged `.githooks` refuse-to-overwrite (product-correct). Catalog `skip_reason` → recorded **SKIP** (not silent drop).

`core.hooksPath` lives under `.git/config` (excluded from manifests); doctor covers hooks activation separately.

## Catalog / survey schema

Harness catalog (`catalog.example.json`):

```json
{
  "version": 1,
  "samples": [
    {
      "name": "my-sample",
      "clone_url": "https://github.com/deftai/….git",
      "sha": "<pinned>",
      "shape": "legacy-core",
      "operation": "auto",
      "enabled": true,
      "allowlist_extra": ["./docs/managed/**"],
      "notes": "…"
    }
  ]
}
```

**Survey adapter** (`run-all.sh`) also accepts P0-5-style docs with `samples` / `selected` / `repos` and field aliases:

| Harness | Aliases |
| --- | --- |
| name | repo, id |
| clone_url | url, cloneUrl, git_url |
| sha | recommendedCheckoutSha, tipSha, tip_sha, commit, pinned_sha, rev |
| shape | era, layout, install_shape |
| operation | op (auto: `convert` when era has copied-core / hasDeftCore) |
| local_path | localPath |
| allowlist_extra | allowlistExtra |
| enabled | include, selected, shortlisted |

Skipped when `supportability` ∈ {unsupported, skip, SKIP, no}, or `skip_reason` / `unsupported_reason` set (unless `force`). P0-5 YES+MAYBE rows are kept; when `shortlisted` is present, only shortlisted rows run by default (P0-5 N=12).

The product repo name `directive` is skipped unless `allow_directive_sample: true` — and even then the work tree must not be `~/Projects/directive`.

## Dry-run

`--dry-run` on `run-sample.sh` / `run-all.sh`:

- Materializes fixture (clone/copy; synthetic skips the older install)
- Writes pre-manifest
- Records planned command
- Does **not** run upgrade / post-manifest / allowlist mutation checks

## Outputs

Per sample (`…/repo-upgrade-results/<name>-<stamp>/`):

| File | Meaning |
| --- | --- |
| `pre.md5tree` / `post.md5tree` | manifests |
| `diff/diff.txt`, `diff.json`, `added|removed|changed.txt` | churn |
| `unexpected.txt`, `allowlist-report.md` | allowlist |
| `upgrade.log` | tip command log |
| `sanity.log` / `doctor.log` | independent checks |
| `result.json`, `snippet.md` | machine + markdown |

Batch: `…/batch-<stamp>/SUMMARY.md`, `summary.json`, `SNIPPETS.md`.

## Tip overrides

```bash
./run-sample.sh … --tag yolo-cp-wave4a
./run-sample.sh … --tag yolo-cp-wave3z --target-version 0.0.0-yolo.cp-wave3z.1
```

Launcher must already be on PATH from `$YOLO_5490/prefix` (HT-00 / pack scripts).
