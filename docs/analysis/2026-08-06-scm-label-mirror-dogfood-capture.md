## Capture (2026-08-06) — SCM label mirror dogfood + #3124 discovery notes

**Status:** experimental / learning pass. **No `--apply` yet.** Policy + this capture land on branch `chore/scm-label-mirror-dogfood-actionlabels` for PR babysit; not mass-applied to SCM labels.

**Operator:** Scott + Grok (this session).  
**Parallel work:** through-merge cohort (Grok monitor) owns #2442, #3143–#3147 — this session lifecycle hands-off for those IDs.

---

### Goals of this pass

1. Run / prepare **Tier-1 SCM bulk mirror** on `deftai/directive` (#1423 Waves 1–2 already shipped).
2. Strengthen **#3124** so discovery teaches that board usability is **greatly decreased** without `actionLabels`.
3. Design **directive dogfood** `actionLabels` + escalate/defer rules that fit **real open-label stats**.
4. Lock **consumer recommended** baseline for kits/discovery (best guidelines, not optional polish).

---

### Product truths locked

| Topic | Decision |
|-------|----------|
| `triaged` alone | Machine **idempotency / control stamp** — not a disposition board |
| Without `actionLabels` | Every match looks like `+triaged` only → **human SCM usability near floor** |
| Configure before first meaningful `--apply` | Stamping `triaged` first skips re-enrichment on re-run (already-triaged skip) |
| Machine set only | `triage:deferred`, `triage:archived`, `triage:lifecycle-linked`, `triage:needs-human` — do not overload human labels (`hold`, `rfc`, …) |
| xBRIEF canonical | Scope lifecycle is **xBRIEF**; rule id still `universal:vbrief-referenced` (naming debt). Chip stays `triage:lifecycle-linked` (not rename to xbrief-linked) |
| Mirror never | `triage:accept` / `proposed/` xBRIEFs / scope lifecycle |

---

### #3124 updates already on GitHub

Issue body amended (2026-08-06):

- Problem + MUST list + AC: board usability **greatly decreased** without `actionLabels`
- Amendment section with directive dry-run evidence (~111 planned → only `+triaged` before actionLabels)
- Teach: control stamp vs disposition; configure action chips before apply; closed machine set; labels must exist on repo

**Still open on #3124:** implement discovery tips (ritual/welcome/doctor) — not done this session.

---

### Consumer recommended set (best guidelines)

**Baseline (recommend for any consumer enabling mirror):**

```json
"triageLabelMirror": {
  "enabled": true,
  "idempotencyLabel": "triaged",
  "alwaysLabels": ["triaged"],
  "actionLabels": {
    "defer": ["triage:deferred"],
    "archive": ["triage:archived"]
  }
}
```

GitHub labels to create: `triaged`, `triage:deferred`, `triage:archived`.  
Paired minimal rules: `wontfix` → defer; `duplicate` → archive.

**Add when ready (same vocabulary):**

| When | Map |
|------|-----|
| Any scopes in `xbrief/` | `accept` → `triage:lifecycle-linked` |
| Explicit “human must look” rules | `escalate` → `triage:needs-human` |

Kit/#3124 should **not** teach “omit `actionLabels` if you only want triaged” as the happy path.

---

### Directive dogfood set (maintainer experimental)

Full machine map (labels **already exist** on `deftai/directive`):

```json
"triageLabelMirror": {
  "enabled": true,
  "idempotencyLabel": "triaged",
  "alwaysLabels": ["triaged"],
  "actionLabels": {
    "defer": ["triage:deferred"],
    "archive": ["triage:archived"],
    "accept": ["triage:lifecycle-linked"],
    "escalate": ["triage:needs-human"]
  }
}
```

#### Escalate rules (repo-shaped — do **not** escalate bare `security`)

Open-label research (~483 open in cache):

| Signal | Open ~ | Choice |
|--------|-------:|--------|
| bare `security` | 28 | **No** — mostly enhancement/design/rfc facet |
| `security` + `bug` | 1 | **Yes** (all-of) |
| `agent-safety` | 5 | **Yes** |
| `urgent` | 2 | **Yes** |
| adoption / Upgrade Blocker / blocks-merge / blocks-release-tag | 0 | **Yes** (ready when used) |

#### Full experimental `triageAutoClassify` order (after 4 universal rules)

1. escalate — `agent-safety`
2. escalate — `urgent`
3. escalate — `security` **and** `bug`
4. escalate — `adoption-blocker` \| `Upgrade Blocker` \| `blocks-merge` \| `blocks-release-tag`
5. defer — `status:superseded-pending` (prior)
6. defer — `rfc` \| `type:research` (prior)
7. defer — `wontfix` (prior)
8. archive — `duplicate` (prior)
9. defer — `fixed-pending-merge` + resume-on (prior)
10. defer — `hold` label (**new**)
11. defer — `status:blocked` (**new**)

**Local SoT for this experiment:** uncommitted `xbrief/PROJECT-DEFINITION.xbrief.json` (`plan["x-directive/policy"]`).

---

### Dry-run results (after experimental PD)

Command: `task triage:classify -- --mirror` (open-only, dry-run).  
Validate: `OK: … (15 rules, 4 hold markers)`.

| Metric | Before actionLabels | After experimental PD |
|--------|--------------------:|----------------------:|
| scanned | 1123 | 1123 |
| planned | 111 | **115** |
| no_match | 372 | **368** |
| closed_skipped | 640 | 640 |
| accept | 5 | **5** |
| defer | 106 | **107** |
| escalate | 0 | **3** |

#### Planned by rule (after)

| Action | Rule | n | Chips |
|--------|------|--:|-------|
| defer | `universal:hold-marker` | 69 | `triaged` + `triage:deferred` |
| defer | consumer rfc/research | 37 | same |
| defer | consumer `hold` label | 1 (#3007) | same |
| accept | `universal:vbrief-referenced` | 5 | `triaged` + `triage:lifecycle-linked` |
| escalate | consumer `agent-safety` | 3 (#1535, #1617, #3086) | `triaged` + `triage:needs-human` |

**Not unique-firing yet:** `urgent`, security+bug, release gates, most `status:blocked` (subsumed by hold-marker / rfc earlier). Keep for revisit.

#### Cohort impact if `--apply` (label only; no scope)

| Issue | Planned action | Labels to add |
|------:|----------------|---------------|
| #2442, #3144, #3145, #3146, #3147 | accept (xBRIEF-referenced) | `triaged`, `triage:lifecycle-linked` |
| #3143 | defer (hold marker in body) | `triaged`, `triage:deferred` |

---

### Explicit non-actions this session

- No `triage:classify -- --mirror --apply`
- No `scope:promote|activate|demote|complete|cancel` on cohort IDs
- No rewrite/cleanup of `xbrief/active/` for #2442 / #3143–#3147
- No #3124 product implementation (tips only issue-body amended)
- No commit / PR of PD change

---

### Next (when resuming)

1. Revisit rules with dry-run evidence (drop dead rules? tighten escalate?).
2. Decide apply timing vs through-merge cohort completion.
3. Commit/PR experimental PD only if dogfood should stick on master (or branch).
4. Implement #3124 discovery packaging using the product truths above.
5. Optional code debt: rename `universal:vbrief-referenced` reason → xBRIEF (compat alias).

---

### Related

- #1423 (mirror parent), #3125/#3126 (Wave 2), #3124 (discovery), #2609/#2611 (taxonomy + consumer kit), #886 (triage umbrella)
- Maintainer machine labels: `.github/ISSUE_LABELS.md`
- Consumer kit: `content/docs/consumer-issue-label-kit.md`
