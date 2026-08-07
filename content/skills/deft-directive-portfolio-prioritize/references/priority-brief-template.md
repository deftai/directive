# Priority brief template (#3198)

Copy structure into the operator-facing brief (issue comment, decision-log draft, or chat). Replace placeholders. **Propose-not-apply** — this artifact is not a decision record until the operator dispose checklist is completed.

```markdown
## Priority brief — <scope label> (propose-not-apply)

**Issue / tracker:** #<N or parent>  
**Generated:** <ISO-8601>  
**Stance:** propose-not-apply (#3179) — **no SCM label writes**, no scope lifecycle, no `triage:accept`  
**Epistemic method:** local `.deft-cache/github-issue/` (+ optional classify dry-run filter); live `gh api` or fresh-cache verify for every shortlist/park citation

### Dispose path (required close)

This brief is **not** a decision record. Operator dispose:

1. **#1396**-shaped decision log (or interim comment on the parent tracker until #1396 ships), and/or  
2. **`task plan-sequence:*`** entries for promote candidates  

Without dispose → re-litigation forever (#2741 class).

---

## Scope of this pass

| Filter | Result |
|--------|--------|
| <cache filter: labels / title family / open> | **N** |
| Of those, classify partition (e.g. `no_match`) | **M** |
| Of those, already planned (defer/escalate/…) | **K** |

**Not in this pass:** <explicit exclusions>

### Label / theme clusters

| Cluster | ~Count |
|---------|-------:|
| … | … |

### Title / RFC families

| Family | ~Count |
|--------|-------:|
| … | … |

---

## Interrupt / non-portfolio (do not rank here)

A-side or already dispositioned items — keep off the deep-dive shortlist:

| # | Verified state | Role |
|--:|----------------|------|
| **#…** | open/closed | escalate / defer / safety interrupt |

---

## Conflict / supersession matrix

### F1 — <family name>

| # | State | Title (verified) | Body claim (cache + read) |
|--:|-------|------------------|---------------------------|
| **#…** | open | … | … |

**Conflict/overlap:** …  
**Recommendation:** shortlist as pack / park as atoms / ordered children …

(repeat F2…)

- ! Supersession claims require body or comment proof — never title-only.
- ! State open/closed accurately after live or fresh-cache verify.

---

## Shortlist (deep dive / promote candidates)

Ordered for **maintainer capacity** — **proposal only**:

| Priority | # | Why |
|--------:|--:|-----|
| P1 | **#…** | … |
| P2 | **#…** | … |

Live-verified open: #…, #….

---

## Park list (do not deep-dive as roots now)

| Class | Examples (verified state) | Park reason |
|-------|---------------------------|-------------|
| … | #… | … |

---

## Epistemic limits

- Cache may lag live labels; call out lag risk.
- Theme-park ≠ formal supersession without comment/body proof.
- List probes still needed before dispose.

---

## Operator dispose checklist

- [ ] Accept / edit shortlist order  
- [ ] Accept park classes  
- [ ] Record dispose on #1396 decision log (or parent tracker interim)  
- [ ] Optional: plan-sequence entries for P1 only  
- [ ] Do **not** treat this brief as mirror apply / label plan  
```

## Citation verify checklist (per cited #)

1. Issue exists (`gh api repos/<o>/<r>/issues/<N>` or cache hit with known freshness).  
2. `state` is accurate (open/closed).  
3. Title matches live/cache (no renumber confusion).  
4. Body read when claiming scope, dependency, or pack membership.  
5. Comments read when claiming decided / deferred / superseded / closed-as-dup.  
6. No title-only supersession language.
