# vBRIEF Filename Conventions

Canonical rules for scope vBRIEF filenames and slug normalization.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [../vbrief/vbrief.md](../vbrief/vbrief.md) | [./references.md](./references.md) | [../main.md](../main.md)

---

## Filename Shape

Scope vBRIEFs in `vbrief/proposed/`, `vbrief/pending/`, `vbrief/active/`, `vbrief/completed/`, and `vbrief/cancelled/` follow the pattern:

```
YYYY-MM-DD-<slug>.vbrief.json
```

- ! The leading date is the **creation date** in `YYYY-MM-DD` form. It is immutable — it MUST NOT change as the scope moves through the lifecycle.
- ! The `<slug>` is a lowercase hyphen-separated descriptor derived from the scope title (or origin issue title for ingested vBRIEFs).
- ! The filename MUST end in `.vbrief.json`.
- ! The filename MUST match `scripts/vbrief_validate.py`'s `FILENAME_PATTERN`: `^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$`.

speckit Phase 4 scope vBRIEFs use the extended pattern `YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json` where `<NNN>` is the implementation-phase index zero-padded to exactly three digits (e.g. `ip001`, `ip042`, `ip128`). See [`../vbrief/vbrief.md`](../vbrief/vbrief.md#speckit-phase-4-scope-vbriefs) for detail.

## Slug Normalization Rules

`scripts/slug_normalize.py` exposes the canonical `normalize_slug(title, issue_number=None)` function. Every tool or skill that coins a scope vBRIEF filename MUST either call that function or apply the same rules documented below so that two different producers always agree on the slug for the same title.

The rules, applied in order:

1. ! **Lowercase** the full input string.
2. ! **Strip GitHub issue-number prefixes** like `#123 ` or `123: ` from the start of the title before slugging (they belong in the date prefix and the references, not in the slug).
3. ! **Replace non-ASCII letters** with their closest ASCII equivalent when possible (e.g. `é` → `e`). Characters without a reasonable fold are dropped.
4. ! **Replace runs of non-alphanumeric characters** (whitespace, punctuation, emoji, quotes) with a single hyphen (`-`).
5. ! **Collapse runs of hyphens** into a single hyphen.
6. ! **Strip leading and trailing hyphens**.
7. ! **Truncate** the slug at a natural hyphen boundary so the final slug is no longer than **80 characters**. Do not cut in the middle of a word when a hyphen boundary is available within the last 20 characters.
8. ~ **Append `-issue-<N>`** (when an origin issue number is provided and the suffix is not already present) so ingested vBRIEFs carry their origin ID in the filename. Skills MAY opt out when the issue number is already captured elsewhere and the slug would otherwise become awkward.
9. ! **Guarantee at least one alphanumeric character** in the output — if the normalized result is empty (e.g. the title was all punctuation), fall back to `scope` (or `scope-<issue-number>` when available).
10. ⊗ Include the `YYYY-MM-DD-` date prefix in `normalize_slug` output — the caller prepends the date.

### Examples

| Input title | Issue | Output slug |
| --- | --- | --- |
| `Fix login bug` | (none) | `fix-login-bug` |
| `"Evolution" client API calls lack pagination` | `#19` | `evolution-client-api-calls-lack-pagination-issue-19` |
| `docs: 12 broken internal links in deft docs surfaced by its own verify:links tool` | `#541` | `docs-12-broken-internal-links-in-deft-docs-surfaced-by-its-own-verify-links-tool-issue-541` |
| `🚨 Pre-Flight requires GitHub PULL_REQUEST_TEMPLATE.md but ...` | `#531` | `pre-flight-requires-github-pull-request-template-md-but-issue-531` |

## Dedup Contract

- ! Consumers (skills + tasks) MUST use the same slug for the same title so that `task issue:ingest` and the deft-directive-refinement skill agree on dedup keys.
- ! Dedup is primarily driven by origin `references.uri` matching; slug agreement is the secondary safeguard.
- ⊗ Invent ad-hoc title → slug transformations inside skills — call `normalize_slug` instead.

## When You Need to Rename

Scope vBRIEF filenames are part of the file's identity. Renames MUST preserve the date prefix and keep the slug stable whenever possible:

- ! When the origin title changes substantially, prefer keeping the original slug rather than churning filenames; update `plan.title` in place and rely on the reference `uri` for traceability.
- ! If a rename is unavoidable, update every `planRef` and `references[].uri` pointing at the old path in the same commit (see `vbrief/vbrief.md` § Status-Driven Moves).

## Anti-Patterns

- ⊗ Use uppercase letters, underscores, or camelCase in the slug
- ⊗ Put the origin issue number in the date segment (`2026-04-22-#541-...`) — the issue number belongs in the suffix (`...-issue-541`) or in `references`
- ⊗ Change the date prefix when a scope moves between lifecycle folders — the date is the creation date, not the current-status date
- ⊗ Coin slugs by hand inside skills; call `scripts/slug_normalize.py` (`normalize_slug`) instead
