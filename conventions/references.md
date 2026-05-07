# vBRIEF References — `x-vbrief/*` Type Registry

Canonical reference for the shape and type registry of `plan.references` entries in vBRIEF files.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [../vbrief/vbrief.md](../vbrief/vbrief.md) | [../vbrief/schemas/vbrief-core.schema.json](../vbrief/schemas/vbrief-core.schema.json) | [../main.md](../main.md)

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
