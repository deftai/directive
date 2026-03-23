# Deft Directive — Research: Roadmap & Open Issues

Informed by `ROADMAP.md` and GitHub issues. Feeds into spec generation.

---

## Don't Hand-Roll

| Problem | Use This | Don't Hand-Roll Because |
|---------|----------|------------------------|
| Spec source-of-truth JSON format | vBRIEF schema (`vbrief.org`) | #72: agents already generating invalid custom JSON — the schema violations were immediate without a reference standard |
| Strategy logic shared between `interview.md` and `yolo.md` | Extract shared phases from `interview.md`, reference them in `yolo.md` | #23: yolo.md duplicates ~80% of interview.md — two diverging copies guarantee drift; shared reference stays canonical |
| Version as a single source | Single `VERSION` constant in `Taskfile.yml`, injected via ldflags/pyproject.toml | Currently three independent versions (`0.5.2`, `0.5.0`, `0.4.2`) drift silently; no enforcement catches them |
| CI for linting + tests | GitHub Actions (`actions/checkout`, `actions/setup-go`, `actions/setup-python`) | #57 open: zero CI currently — every PR is untested in automation |
| `history/changes/` directory convention | Create the directory; document the structure in `commands.md` | #59: `commands.md` already describes a directory that doesn't exist — references that can't be followed are worse than no references |
| Agent skill auto-discovery | `.agents/skills/` thin pointer files (already implemented, #94 closed) | Symlinks and copies both have platform failure modes; the thin pointer pattern proved sufficient |

---

## Common Pitfalls

**Pitfall: vBRIEF schema mismatches**
- What happens: Agents generate spec JSON that fails validation — wrong field names (`title` instead of `plan`), wrong status values (`pending` instead of `todo`), missing required fields
- Why it happens: `vbrief/vbrief.md` documents the schema but agents don't read it unless explicitly directed; no validation gate before generating output
- Avoid: Add `task spec:validate` to the pre-spec workflow gate; reference the vBRIEF schema from both `strategies/interview.md` and `deft-setup` Phase 3
- Warning signs: #72 reproducer — `"status": "approved"` at the root level instead of per-task; `"title"` key instead of `"plan"`; `"status": "pending"` in tasks instead of `"todo"`

**Pitfall: Agents silently skipping testing protocols**
- What happens: Agent builds and commits code; tests never run; CI fails; coverage drops; user discovers it post-commit
- Why it happens: #68/#94 confirmed root cause — without auto-discovery (Gap 1) and a mandatory workflow gate (Gap 2), testing is treated as optional cleanup rather than a pre-commit gate
- Avoid: `task check` MUST be stated as a blocking gate in every spec; the `! Before implementing any planned change that touches 3+ files...` rule in `main.md` enforces the `/deft:change` lifecycle
- Warning signs: No `task check` or `task test` in recent terminal history; commits without test changes; commit message says "implement X" without "passing tests"

**Pitfall: Phase 2 inference reading `./deft/` internals**
- What happens: When a project has no build files at root, deft-setup finds `go.mod`/`pyproject.toml` inside `./deft/` and concludes the project is named "deft" with the deft framework's tech stack
- Why it happens: #79 — the `⊗` guard in `deft-setup/SKILL.md` Phase 2 only covers `PROJECT.md`, not build file scanning or `git` introspection
- Avoid: SPEC must explicitly codify the inference boundary: only inspect project root and non-`deft` subdirectories; never run `git` commands inside `./deft/`
- Warning signs: PROJECT.md says "Tech Stack: Go + Python" for a JavaScript project; project name inferred as "deft"

**Pitfall: Coverage threshold stated vs. enforced gap**
- What happens: `main.md` and PROJECT.md say ≥85%, but `pyproject.toml` enforces `fail_under = 75`; `run` is excluded from measurement entirely
- Why it happens: Coverage was lowered for pragmatic reasons but the stated standard wasn't updated; the exclusion makes the most important file invisible
- Avoid: SPEC must resolve this discrepancy — either raise enforcement to 85% or officially document 75% as the project's standard; `run` must be included in measurement or explicitly carved out with rationale
- Warning signs: `task test:coverage` passes but agents claim "85% met"

**Pitfall: Specification debt blocking quality improvements**
- What happens: #68 agents skip testing; #72 agents produce invalid vBRIEF; #84 teaching behavior undefined — all compound because there is no authoritative spec for what deft should do, so agents fill gaps with guesses
- Why it happens: #67 open since 5 days — deft has no SPECIFICATION.md for itself. Dogfooding failure: a spec-driven framework without its own spec
- Avoid: SPECIFICATION.md is the primary deliverable of this session. It must cover: CLI behavior contract, installer contract, agent behavior contract, test infrastructure expectations
- Warning signs: Multiple issues describe the same agent misbehavior from different angles — agents aren't defective, the specification is absent

**Pitfall: Identity ambiguity blocking content work**
- What happens: #89 blocks Phase 2 README reframe, `meta/philosophy.md`, and interview strategy updates — any content that touches "what Deft is" is frozen
- Why it happens: Three competing framings (SDD, Contract Engineering, CDE) unresolved; Scott's latest analysis leans toward Option D hybrid: "Spec-driven. Contract-first. Code is output."
- Avoid: SPEC should not depend on #89 resolution. Frame the spec around what Deft does mechanically (layered rules, interview → spec → implementation), not what it calls itself. Leave branding as a placeholder
- Warning signs: Writing README language or philosophy content in the spec — that's #89 territory, not spec territory

**Pitfall: Strategy file proliferation without deduplication**
- What happens: `yolo.md` diverges from `interview.md`; `default.md` duplicates `interview.md` (#31, #50); adding new content to one doesn't update the other
- Why it happens: Files were created as standalone documents with copied content rather than shared references
- Avoid: New strategy content should reference `interview.md` for shared phases (sizing gate, chaining gate, acceptance gate) rather than duplicating them; SPEC should note this as a maintenance constraint
- Warning signs: A fix to the sizing gate logic requires edits to 3+ strategy files

---

## Key Observations for Spec Generation

1. **#67 is this session's deliverable** — the SPEC must explicitly close that issue
2. **Phase 1 bugs (12 open)** are adoption blockers — SPEC should include task stubs for the highest priority ones: #79, #80, #107, #72, #91/#92, #31, #50
3. **#89 (identity) is unblocked for mechanical spec work** — frame around behavior, not branding
4. **Coverage standard must be resolved in SPEC** — pick 75% or 85%, enforce it, document `run` exclusion explicitly
5. **Node.js 24 Actions upgrade has hard deadline: June 2, 2026** — must appear as a timed task in the spec
