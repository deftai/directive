# Gitcrawl Fallback (gh-only mode)

## What this document is

`task triage:bootstrap` tries to install [`gitcrawl`](https://pypi.org/project/gitcrawl/) so the local issue cache can pull richer data than the GitHub CLI (`gh`) alone provides. On Windows in particular, the install can fail silently when neither `uv` nor `pipx` is on PATH, or when the install attempt itself fails. When that happens the bootstrap **defers** the install and continues -- the rest of triage still works against `gh`, just with fewer fields.

This document tells you, the maintainer using deft, what that fallback means, what data you lose, and how to install gitcrawl manually if you want it.

## When does this fire?

You will see a recap line like the following when you run `task triage:bootstrap`:

```
✗ ensure_gitcrawl: deferred -- gitcrawl unavailable on this platform (...);
  falling back to gh-only mode for triage (missing: body_html, reactions, comments_full).
  Install manually: uv tool install gitcrawl  OR  pipx install gitcrawl
```

The deferral fires when **all** of the following are true:

1. `gitcrawl` is not already on your PATH.
2. The bootstrap could not install it via `uv tool install gitcrawl` (uv missing, or the install command exited non-zero).
3. The bootstrap could not install it via the historical `pipx install gitcrawl` fallback either.

The bootstrap exit code stays `0` -- the rest of the triage flow runs normally. Only the gitcrawl-specific fields are missing.

## What you lose in gh-only mode

The local issue cache (`.deft-cache/issues/<owner>-<repo>/<N>.json`) is populated from one of two sources:

- **gitcrawl path (preferred)**: returns the GitHub issue **plus** rich metadata that the REST `gh issue view` shape does not surface.
- **`gh` fallback path (gh-only mode)**: returns the basic issue payload only.

In gh-only mode the following fields are **not** in the cache and are **not** available to the refinement / triage skill when it walks each candidate:

- `body_html` -- the rendered HTML form of the issue body. The `gh` JSON output gives you the markdown source but not the rendered HTML, so any rendering / link-extraction step that operates on HTML is unavailable.
- `reactions` -- 👍 / 👎 / 🎉 / ❤️ / 🚀 / 👀 / 😄 / 😕 counts on the issue. Reaction counts are a useful weak signal of community demand during refinement and are absent in gh-only mode.
- `comments_full` -- the full comment thread with author, timestamps, and body for every comment. The `gh` fallback returns the issue itself but not the full comment expansion.

## Why this matters during triage

The refinement skill's Phase 0 walks each cached candidate one by one. The agent surfaces the title, origin URL, labels, and body excerpt to you so you can decide accept / reject / defer / needs-AC / mark-duplicate.

In gh-only mode:

- You can still triage. Title, body text, labels, and origin URL are all present.
- Reaction-weighted heuristics (e.g. "issues with more 👍 surface first") are **not** available.
- Cross-comment context ("did the original reporter clarify in a follow-up?") is **not** present in the cache; you can still click through to GitHub for context if needed.

If your triage workflow does not depend on reactions or full comment threads, gh-only mode is fine. If it does, install gitcrawl manually using one of the commands below.

## Manual install commands

Pick whichever installer you already have. You only need one.

### Recommended: uv (already a deft requirement)

```
uv tool install gitcrawl
```

uv is already on your machine if you have run any deft task -- every deft task script runs via `uv run python ...`. This is the quickest path.

### Alternative: pipx

```
pipx install gitcrawl
```

If you have pipx for other tooling, this works the same way. On Windows, install pipx itself per the [pipx installation docs](https://pipx.pypa.io/stable/installation/).

### After install

Re-run the bootstrap so the cache is repopulated with the rich gitcrawl payload:

```
task triage:bootstrap
```

The `ensure_gitcrawl` step will now report `already on PATH (no-op)`, and the next `task triage:cache` run will populate the cache via the gitcrawl path.

## Verifying gh-only mode is what you have

If the recap above scrolled off your terminal, you can re-run with the `--json` flag to inspect the structured outcome:

```
uv run python scripts/triage_bootstrap.py --json | python -m json.tool
```

Look for the `ensure_gitcrawl` step. Its `details` payload will include:

```
"falling_back_to": "gh-only",
"missing_fields": ["body_html", "reactions", "comments_full"],
"install_hint": "Install manually: uv tool install gitcrawl  OR  pipx install gitcrawl"
```

## Why not fail the bootstrap?

`gitcrawl` is **best-effort** by design. The triage workflow is built on a documented fallback to `gh issue list` (Story 1 of the #845 cascade) precisely so that consumers without gitcrawl on PATH can still use triage. Failing the bootstrap on a missing optional installer would punish first-time Windows users who do not have `pipx` pre-installed; deferring with a structured, visible status line is the better trade-off.

## Related

- `scripts/triage_bootstrap.py::step_ensure_gitcrawl` -- the install attempt and deferral logic.
- `scripts/triage_cache.py` -- the cache writer that consumes either gitcrawl or `gh` as the data source.
- `docs/privacy-nfr.md` -- the privacy contract for `.deft-cache/` (gitignore default + opt-in commit-cache).
