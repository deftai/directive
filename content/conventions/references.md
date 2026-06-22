# vBRIEF References — `x-vbrief/*` Type Registry

Canonical reference for the shape and type registry of `plan.references` entries in vBRIEF files.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [../vbrief/vbrief.md](../vbrief/vbrief.md) | [../vbrief/schemas/vbrief-core.schema.json](../vbrief/schemas/vbrief-core.schema.json) | [../main.md](../../main.md)

---

## Schema-Conformant Reference Shape

Every entry in `plan.references` is a `VBriefReference`, which extends the
schema's `URI` object and adds a `type` field that MUST match the pattern
`^x-vbrief/` (per the canonical v0.6 schema and directive's vendored copy).

```json
"references": [
  {
    "uri": "https://github.com/{owner}/{repo}/issues/{N}",
    "type": "x-vbrief/github-issue",
    "title": "Issue #{N}: {issue title}"
  }
]
```

Required fields:

- ! `uri` — the canonical URL or relative path (required by the `URI` base type; not `url`)
- ! `type` — MUST begin with `x-vbrief/` (see registry below)

Optional (schema-defined) fields:

- ? `title` — a short human label (use `#{N}: {issue title}` for GitHub issues)
- ? `description` — longer free-form context
- ? `tags` — array of strings for categorization

- ⊗ Use `url` as the field name — the schema requires `uri`
- ⊗ Use `type` values outside `x-vbrief/*` (e.g. `"github-issue"` with no prefix) — strict validators will reject them
- ⊗ Rely on `id` to convey issue numbers — that field is not schema-defined; put the issue number in `title` instead

## `x-vbrief/*` Type Registry

The following `type` values are recognized by deft's tooling and skills. Any
`x-vbrief/*` value is schema-valid, but the types below carry documented
semantics.

- `x-vbrief/plan` — reference to another vBRIEF plan (epic→story or story→epic links, also the canonical v0.5 enum value)
- `x-vbrief/github-issue` — a GitHub issue (the origin of an ingested scope vBRIEF, or a related issue)
- `x-vbrief/github-pr` — a GitHub pull request (implementing PR, related PR, or superseded PR)
- `x-vbrief/jira-ticket` — a Jira ticket (origin provenance for Jira-backed projects)
- `x-vbrief/user-request` — a direct user request captured verbatim (no external tracker ID)
- `x-vbrief/spec-section` — a pointer into `specification.vbrief.json` by item id or narrative key (traceability link for FR/NFR requirements)

Consumer projects ? MAY extend the registry with additional `x-vbrief/*` values. When you do, document them in a project-local conventions file and cite them from `PROJECT-DEFINITION.vbrief.json`.

### Additive sibling fields

`References` entries MAY carry additional sibling fields alongside the schema-defined `uri` / `type` / `title` / `description` / `tags`. The following extension is recognised by deft tooling:

- `TrustLevel` (`verified` | `internal` | `external`) -- source-trust classification, sourced from the AI Agent Traps paper's Cognitive State / Latent Memory Poisoning trap class. Canonical field shape, value enum, and rule body live in [`../vbrief/vbrief.md`](../vbrief/vbrief.md) `### TrustLevel (#480)`. The safe default for a missing field is `external` (#480).

## Origin Provenance (D11)

Scope vBRIEFs in `vbrief/pending/` and `vbrief/active/` SHOULD carry at least
one reference whose `type` matches `^x-vbrief/`. `scripts/vbrief_validate.py`
treats any `x-vbrief/*`-typed reference as an origin for the D11 check by
default (schema-trusting behavior).

Run the validator with `--strict-origin-types` to instead require an exact
match against the registry above (allow-list behavior). Teams that want to
enforce the allow-list in CI can opt in via the same flag.

- ! Every ingested scope vBRIEF MUST carry at least one `references` entry linking to its origin
- ~ Prefer registry types over ad-hoc `x-vbrief/*` values when a registry type fits

### `Origin` narrative -- canonical provenance signal (#1096)

For scope vBRIEFs ingested from a GitHub issue, the canonical provenance
signal is the `plan.narratives.Origin` text emitted by
`scripts/issue_ingest.py::_build_issue_vbrief`:

- ! `Origin` MUST take one of these two forms:
  - `Ingested from https://github.com/{owner}/{repo}/issues/{N}` (browser URL resolves)
  - `Ingested from issue #{N}` (no-URL fallback)
- `vBRIEFInfo.description` SHOULD mirror this as `Scope vBRIEF ingested from GitHub issue #{N}` (the secondary signal used by the dedup pass when `Origin` is absent).

The dedup pass in `task issue:ingest -- <N>` differentiates *provenance*
from *informational* references using this narrative:

- A pre-existing vBRIEF blocks ingest of `#N` only when BOTH conditions hold:
  1. The vBRIEF carries an `x-vbrief/github-issue` reference whose `uri`
     points at `#N`.
  2. The vBRIEF's `plan.narratives.Origin` (or `vBRIEFInfo.description`)
     identifies the SAME `#N` as its provenance.
- A vBRIEF with `Origin` pointing at `#X` and a companion `x-vbrief/github-issue` reference to `#Y` (`X != Y`) is the *provenance owner of #X only*. The reference to `#Y` is informational and MUST NOT block `task issue:ingest -- Y`.
- Legacy v0.5-shape vBRIEFs that predate the `Origin` convention fall back
  to a position-aware heuristic: the FIRST `x-vbrief/github-issue` reference
  in `plan.references` is the implied provenance. This preserves dedup for
  unmigrated trees and is bounded -- the canonical Origin signal is
  authoritative whenever it is present.

- ⊗ Treat every `x-vbrief/github-issue` reference as dedup-blocking provenance regardless of `Origin` -- that was the #1096 false-positive surface
- ⊗ Mutate a `completed/` vBRIEF to remove a companion / sibling reference solely because `task issue:ingest` false-positives on it (rewriting completed history is an anti-pattern per `skills/deft-directive-refinement/SKILL.md`)
- ~ When adding a companion / sibling / related-plan reference to an ingested vBRIEF, keep `Origin` pointing at the original ingest source so the dedup pass continues to recognise the vBRIEF as the canonical owner of that issue

## Schema Version: v0.6 (Canonical, Strict)

- ! All vBRIEFs MUST emit `"vBRIEFInfo": { "version": "0.6" }`
- ! `scripts/vbrief_validate.py` accepts ONLY `"0.6"`; any other version (including legacy `"0.5"`) is a hard validation error
- ! The vendored schema at `../vbrief/schemas/vbrief-core.schema.json` is the canonical v0.6 copy from [`deftai/vBRIEF`](https://github.com/deftai/vBRIEF/blob/master/schemas/vbrief-core-0.6.schema.json) and pins `vBRIEFInfo.version` to `const: "0.6"`
- ! `scripts/migrate_vbrief.py` emits `"0.6"`; pre-existing v0.5 vBRIEFs are swept to `"0.6"` as part of the migrator flip PR

## Anti-Patterns

- ⊗ Write references with a bare `"type": "github-issue"` — the schema requires `^x-vbrief/`
- ⊗ Write references with `"url"` instead of `"uri"`
- ⊗ Rely on a custom `"id"` field for issue numbers — encode it in `title` (or `description`) instead
- ⊗ Invent new non-prefixed type vocabularies — use `x-vbrief/*` everywhere
- ⊗ Leave scope vBRIEFs in `pending/` / `active/` without any `x-vbrief/*` origin reference
