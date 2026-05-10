# Upgrading Deft

Version-by-version upgrade guide. Newest versions are at the top.

> **Agents:** ! If you are reading this because a user updated the framework, have them start a **new agent session** after you finish the upgrade. Your current session may still hold stale AGENTS.md / skill references from the previous version.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

---

<!-- 992-pr3: From deft/ -> .deft/core/ migration BEGIN -->
## From deft/ -> .deft/core/

- **Applies when:** `.deft/core/run gate` reports a non-A install layout state (`B`, `C`, or `D`) -- equivalently, the new `_check_upgrade_gate` install-layout auto-prompt fires `[deft] install layout state: <X> (<description>). Run .deft/core/run relocate to upgrade. (Y/n)` on every CLI invocation. The four states inspected by the detector are: **A** pure `deft/` (legacy install; AGENTS.md + framework agree at the legacy path -- working today, no action required), **B** pure `.deft/core/` (current installer / webinstaller / sync skill / oz output -- AGENTS.md may still say `deft/` and the contract diverges), **C** hybrid (both `deft/` and `.deft/core/` present -- agents follow whichever they read first), **D** AGENTS.md only (managed-section markers present but no framework directory -- partial install). State A is the only non-firing state in v0.27 -- a future cycle decides whether to deprecate the legacy path. (#992)
- **Safe to auto-run:** No -- the relocator is wipe-and-reinstall by design and operator consent is required at every gate-prompt invocation. The cmd_gate auto-prompt is purely informational: it asks `(Y/n)` as a visual consent affordance but the gate itself NEVER invokes `task relocate` automatically and NEVER mutates filesystem state. This mirrors the **#884 ghx-install consent gate** precedent (`task setup` prompts before invoking the upstream installer; the only non-interactive paths are explicit `--yes` or env-var opt-out). The relocator's own `task relocate` surface ALSO prompts `[y/N]` on bare invocation; pass `--confirm` to skip the prompt in scripted use, never as a default. The relocator writes a gzip snapshot tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` BEFORE any wipe so a botched relocate is recoverable.
- **Restart required:** Yes -- the marker v1 -> v2 bump (PR1) intentionally fires `agents-md=stale` on every current install on the first `cmd_gate` invocation post-v0.27. After the relocator completes, AGENTS.md is re-rendered with the v2 managed-section markers; chase with a fresh agent session so the refreshed `AGENTS.md` (Implementation Intent Gate, Branch Policy Disclosure, Multi-agent orchestration discipline, etc.) loads from a clean context. Your current session still holds the pre-relocate `AGENTS.md` in memory; restarting closes that drift.
- **Commands:**
  - `task relocate -- --dry-run` (preview the planned wipe-and-reinstall; never writes; no consent prompt because no mutation)
  - `task relocate` (apply -- prompts `[y/N]` on bare invocation; writes gzip snapshot tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` before any wipe; idempotent across states A/B/C/D/F)
  - `task relocate -- --confirm` (apply non-interactively -- scripted-use ONLY; the consent prompt is the default for a reason)
  - `task relocate -- --rollback` (extract the most recent snapshot back into project root if the relocate landed badly)
  - `task relocate -- --force` (override the pre-flight hard-fails for **customized framework dir** [preserved-files list printed] OR **active swarm** [`vbrief/active/*.vbrief.json` with `plan.status == "running"`]; required when either condition is detected)
  - `uv run python scripts/relocate.py --help` (full flag surface reference)

### Install-layout state classification

The gate-side detector inspects three filesystem facts at the consumer project root: presence of `deft/` (legacy framework dir), presence of `.deft/core/` (canonical framework dir), and presence of managed-section markers in `AGENTS.md`. The four states map onto those facts as follows:

- **State A** -- `deft/` present, `.deft/core/` absent. Legacy install. **No prompt fires.** Working today; relocate is OPTIONAL in v0.27. Operators on state A can keep their legacy install indefinitely or relocate proactively.
- **State B** -- `deft/` absent, `.deft/core/` present. Current installer / webinstaller / sync skill / oz output. **Prompt fires.** AGENTS.md may still reference `deft/` paths (pre-PR1 contract); the relocator re-renders AGENTS.md with the v2 markers and aligns the contract.
- **State C** -- both `deft/` AND `.deft/core/` present. Hybrid. **Prompt fires.** Agents follow whichever path they read first; the relocator wipes both and reinstalls into `.deft/core/` only (single-namespace contract per the v0.27 DesignChoice).
- **State D** -- neither directory present, AGENTS.md with managed markers present. Partial install. **Prompt fires.** Typically a cancelled / interrupted install; the relocator does a fresh canonical install into `.deft/core/`.

### What the relocator does

`task relocate` runs `scripts/relocate.py` (PR2). The implementation is wipe-and-reinstall by design: one idempotent code path across states A/B/C/D/F that enforces the canonical `.deft/core/` namespace contract from #11 (read-only packaged assets), has a trivial test surface (state matrix x relocator -> assert end state), catches stale framework versions for free (state B benefits even though no path move is needed), and aligns with the npm/pip rail packaging semantics that #11 will ship in parallel. Per phase, the relocator:

1. **Pre-flight gates** -- hard-fails without `--force` when the framework dir is git-tracked + customized (preserved-files list printed) OR any `vbrief/active/*.vbrief.json` has `plan.status == "running"` (active swarm).
2. **Snapshot** -- writes a gzip tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` covering `deft/` + `.deft/core/` + `AGENTS.md` so the operation is reversible via `task relocate -- --rollback`.
3. **Wipe** -- removes both `deft/` (if present) and `.deft/core/` (if present) -- the operation is contractually idempotent across source states.
4. **Reinstall** -- copies the framework source into `.deft/core/`. The bootstrap path (`webinstaller/upgrade.sh` / `upgrade.ps1`, in the separate `webinstaller` repo) fetches a fresh framework copy to a temp dir and runs the relocator FROM that copy, so the in-place framework about to be wiped never executes its own wipe (BOOTSTRAP NEVER SELF-DESTRUCTIVE).
5. **AGENTS.md re-render** -- bumps the managed-section bytes to the v2 marker contract using the `_wrap_legacy_in_markers` semantics from `run` (#794) so consumer notes outside the bracketed region survive verbatim.
6. **`.gitignore` update** -- ensures `.deft/core/` is gitignored by default per the #845 / `.deft-cache/` precedent (hidden-namespace contract).
7. **Advisory grep** -- scans consumer files OUTSIDE `.deft/core/` for legacy framework path references and prints findings (CI workflows, external scripts, dotfiles that hardcode the pre-v0.27 path). See `scripts/_relocate_states.py::advise_external_hardcodes()` for the exact search constant + grep semantics. The relocator NEVER auto-rewrites these -- CI / external tooling that hardcodes the legacy path is out of framework's control; the operator decides whether to update each surface.

### Snapshot rollback

A botched relocate is reversible:

```bash
task relocate -- --rollback
```

The rollback extracts the most recent `.deft-cache/relocate-snapshot-*.tar.gz` back into the project root. Snapshots are timestamped (UTC) so multiple back-to-back relocates each leave their own snapshot; the rollback always picks the most recent. If you need to roll back further, extract the older snapshot manually with `tar -xzf .deft-cache/relocate-snapshot-<timestamp>.tar.gz -C <project_root>`.

The rollback restores **byte-equivalent pre-relocate state** for the four tracked paths (`deft/`, `.deft/core/`, `AGENTS.md`, `.gitignore`): captured paths are restored from the tarball; uncaptured tracked paths (relocator-created `.gitignore` when the project had none pre-relocate) are removed so `git status --porcelain` is clean post-rollback. The `.deft-cache/` directory is intentionally outside the byte-equivalent contract because it hosts the snapshot tarball and the relocator's working state -- removing it would break re-rollback against the same snapshot. (F3 #1015)

### Manual edits required after relocate (above-marker prose)

The relocator preserves consumer-authored prose ABOVE the AGENTS.md managed-section markers verbatim per the [#794](https://github.com/deftai/directive/issues/794) `_wrap_legacy_in_markers` contract -- this is by design so hand-rolled notes survive the migration. As a consequence, **legacy `deft/run` references the consumer wrote into their own AGENTS.md (or other consumer-owned files outside `.deft/core/`) survive the relocate verbatim**. The relocator's advisory grep flags these as fix-manually hits at the end of the run; the operator decides whether to update each surface.

The relocator does NOT auto-rewrite consumer-owned files (the canonical reason: external CI workflows, dotfiles, and tooling outside the framework's control may also hardcode the legacy path -- the framework cannot mechanically distinguish a benign reference from a load-bearing one). After the relocate, scan the advisory grep output and update each occurrence by hand:

- `AGENTS.md` head/tail (above and below the managed-section markers) -- replace `deft/run` with `.deft/core/run` and `Full guidelines: deft/main.md` with `Full guidelines: .deft/core/main.md`.
- CI workflow files (`.github/workflows/*.yml`) -- replace any `deft/run <task>` invocations.
- Project scripts (`scripts/`, `Makefile`, `Taskfile.yml`, dotfiles) that hardcode the legacy path.
- README / docs / contributor-onboarding prose that points new contributors at `deft/run` for bootstrap.

The advisory grep output is the operator's worklist; treat it as a finite todo. Once every flagged occurrence is either updated to `.deft/core/run` or explicitly acknowledged as legacy-friendly redirect-stub content (e.g. the `skills/deft-{sync,setup,...}/SKILL.md` redirect stubs that intentionally retain `deft/run` per [#411](https://github.com/deftai/directive/issues/411)), commit the changes alongside the relocate. (F1 #1015)

### What the cmd_gate auto-prompt does NOT do

The gate-side prompt is informational only:

- ⊗ It does NOT invoke `task relocate` automatically; the operator runs the command on consent.
- ⊗ It does NOT mutate any filesystem state during detection or emission.
- ⊗ It does NOT block the CLI invocation it fires alongside; the gate stays exit-0 for layout drift (mirrors the #801 remote-version probe's informational-only contract).
- ⊗ It does NOT call `read_yn` / interactive confirm helpers; the `(Y/n)` suffix is purely a visual consent affordance.

The operator-consent contract is identical to the #884 `task setup` ghx-install consent gate: detection signals that work needs doing; the operator authorizes the work explicitly.

### References

- [#992](https://github.com/deftai/directive/issues/992) -- adopt `.deft/core/` as canonical install layout (parent issue).
- [#11](https://github.com/deftai/directive/issues/11) -- origin of the `.deft/core/` layout choice (read-only packaged assets contract).
- [#768](https://github.com/deftai/directive/issues/768) -- universal upgrade gate + AGENTS.md managed-section markers (PR1 bumps the marker from v1 to v2).
- [#794](https://github.com/deftai/directive/issues/794) -- pre-#768 AGENTS.md legacy migration (`_wrap_legacy_in_markers` reused by the relocator's AGENTS.md re-render path).
- [#884](https://github.com/deftai/directive/issues/884) -- `task setup` ghx-install consent gate (operator-consent precedent).
- [`scripts/relocate.py`](./scripts/relocate.py) -- relocator source (PR2).
- [`scripts/_relocate_states.py`](./scripts/_relocate_states.py) -- state classifier shared with cmd_gate.
- [`tasks/relocate.yml`](./tasks/relocate.yml) -- `task relocate` Taskfile fragment.
- [`tests/cmd_gate/test_state_detection.py`](./tests/cmd_gate/test_state_detection.py) -- gate-side state-detector + auto-prompt regression coverage (PR3).

---
<!-- 992-pr3: From deft/ -> .deft/core/ migration END -->

<!-- 883-story-4: v0.25.x -> v0.26.0 migration BEGIN -->
## From v0.25.x → v0.26.0 (deft-cache unified layer; breaking)

- **Applies when:** any project on deft v0.25.0, v0.25.1, or v0.25.2 that has run `task triage:bootstrap` (i.e. has a populated `.deft-cache/issues/<owner>-<repo>/<N>.{json,md}` flat-sidecar layout). Detection: `Test-Path .deft-cache/issues/` returns `True` AND `Test-Path .deft-cache/github-issue/` returns `False`. Pure-additive opt-out projects (no `.deft-cache/`) skip this section -- they pick up the v0.26.0 surface on first `task triage:bootstrap`.
- **Safe to auto-run:** No. The on-disk layout changed; the legacy `.deft-cache/issues/` tree is NOT migrated in place. Operators MUST delete the legacy tree and re-populate via `task cache:fetch-all` (one-shot; mirrors the v0.25.x bootstrap-populate timing). The audit log at `vbrief/.eval/candidates.jsonl` is preserved verbatim across the migration -- accept/reject/defer history is untouched.
- **Restart required:** Yes. The agent's current session still holds stale skill prose pointing at `task triage:cache` / `task triage:show`. After the cache re-populate completes, start a new agent session so the refreshed `skills/deft-directive-refinement/SKILL.md` Phase 0 (rebound onto `cache:*`) loads from a clean context.
- **Commands:**
  - `Remove-Item -Recurse -Force .deft-cache/issues/` (PowerShell) or `rm -rf .deft-cache/issues/` (bash) -- drop the legacy flat-sidecar layout.
  - `task cache:fetch-all -- --source=github-issue --repo=OWNER/NAME` -- re-populate under the new `.deft-cache/<source>/<key>/{raw.json,content.md,meta.json}` layout (~5 min for a ~200-issue corpus; idempotent on re-run via TTL skip-fresh).
  - `task cache:get -- github-issue <owner>/<repo>/<N>` -- per-issue read replacing the removed `task triage:show <N>` form.
  - `task triage:bootstrap` -- still works; now delegates to `cache:fetch-all` end-to-end.

### Surface changes

- **`task triage:cache` REMOVED.** Replaced by `task cache:fetch-all --source=github-issue --repo=OWNER/NAME`. The unified surface is the canonical entry point for all cache populates (github-issue today; URL / email / file deferred to v2).
- **`task triage:show` REMOVED.** Replaced by `task cache:get github-issue <owner>/<repo>/<N>`. Returns the schema-validated `meta.json` envelope plus the path to `content.md` (or a structured stale-with-flag response when `expires_at` has elapsed; pass `--no-stale` to fail closed instead).
- **On-disk layout changed.** Old: `.deft-cache/issues/<owner>-<repo>/<N>.{json,md}` (flat sidecar). New: `.deft-cache/<source>/<key>/{raw.json,content.md,meta.json}` (per-entry directory; schema-validated meta envelope). `cache:get` validates `meta.json` against `vbrief/schemas/cache-meta.schema.json` on every read so a corrupt or version-incompatible file fails closed.
- **Audit log UNCHANGED.** `vbrief/.eval/candidates.jsonl` preserves accept / reject / defer / needs-ac / mark-duplicate / reset records across the migration. The Story 3 Tier-2 short-circuit (terminal-decision skip on bulk-* re-runs) operates on the same file.
- **All other `triage:*` actions UNCHANGED.** `triage:accept` / `triage:reject` / `triage:defer` / `triage:needs-ac` / `triage:mark-duplicate` / `triage:bulk-accept` / `triage:bulk-reject` / `triage:bulk-defer` / `triage:bulk-needs-ac` / `triage:status` / `triage:reset` / `triage:history` / `triage:refresh-active` keep their v0.25.x surface byte-for-byte (13 aliases). The rebind onto `cache:get` is internal. `triage:bootstrap` keeps its v0.25.x command surface but its on-disk output is the new `.deft-cache/<source>/<key>/` per-entry layout (now delegates to `cache:fetch-all`); see the Commands list above.

### Rollback

The migration is one-way; v0.26.0 ships no shim back to the flat-sidecar layout. To revert to v0.25.2 behaviour, pin `deft/` to the v0.25.2 tag, delete `.deft-cache/`, and re-run `task triage:bootstrap` against the v0.25.2 surface. The audit log at `vbrief/.eval/candidates.jsonl` is forward / backward compatible -- v0.25.x and v0.26.0 read the same JSONL schema.

### References

- [#883](https://github.com/deftai/directive/issues/883) -- deft-cache unified content cache + quarantine epic (this migration is the v1 cutover).
- [`vbrief/schemas/cache-meta.schema.json`](./vbrief/schemas/cache-meta.schema.json) -- frozen JSON Schema 2020-12 contract for `meta.json` (validated on read AND write).
- [`docs/quarantine-spec.md`](./docs/quarantine-spec.md) -- formal spec for the #583 injection-quarantine algorithm consumed by `cache:put`.
- [`docs/privacy-nfr.md`](./docs/privacy-nfr.md) -- privacy contract for `.deft-cache/` (gitignore default; opt-in commit path; private-repo body treatment).

---
<!-- 883-story-4: v0.25.x -> v0.26.0 migration END -->


## Migration to triage v1

- **Applies when:** any project on deft v0.24.0 or later that wants to opt in to the pre-ingest triage workflow (#845). Triage v1 is **purely additive** -- existing skills (`deft-directive-refinement`, `deft-directive-swarm`, `deft-directive-build`, etc.) keep working byte-identically when the triage surfaces are absent. Detection: run `task triage:bootstrap` and observe whether `.deft-cache/` exists at the project root. If not, you have not opted in yet.
- **Safe to auto-run:** Yes. `task triage:bootstrap` is idempotent and reversible -- a second run is a no-op, and the entire opt-in can be undone by deleting `.deft-cache/` and removing the `.deft-cache/` line from `.gitignore`. The bootstrap performs five steps: (1) populate the local issue cache for all open upstream issues; (2) backfill `vbrief/.eval/candidates.jsonl` with `accepted` audit entries for items already in `vbrief/proposed/`, `vbrief/pending/`, or `vbrief/active/` (preserves audit trail; intentionally skips `vbrief/cancelled/` to avoid reanimating rejected items); (3) add `.deft-cache/` to `.gitignore` if absent; (4) install `gitcrawl` if missing (skipped if already on PATH); (5) print a recap of the actions taken.
- **Restart required:** No. Triage v1 is a new opt-in surface; existing agent sessions continue to work without any awareness of the cache. Future sessions will see the new `task triage:*` targets in `task --list` once the parent `Taskfile.yml` `includes:` block resolves the four fragment files.
- **Commands:**
  - `task triage:bootstrap` (one-time install, ~5 min for ~200 open issues -- mostly the cache populate step). The `triage:bootstrap` colon-form is wired as a top-level alias by Story 6 and works immediately after this PR merges.
  - The remaining commands ship as **namespaced** targets via the parent Taskfile `includes:` block. Use the `<namespace>:<task>` form against the include key:
    - `task triage-cache:cache` / `task triage-cache:show <N>` (Story 1)
    - `task triage-actions:accept <N>` / `task triage-actions:reject <N> -- --reason <r>` / `task triage-actions:defer <N>` / `task triage-actions:needs-ac <N>` / `task triage-actions:status <N>` / `task triage-actions:history <N>` (Story 3)
    - `task triage-bulk:bulk-accept` / `task triage-bulk:bulk-reject` / `task triage-bulk:refresh-active` etc. with `--label` / `--author` / `--age-days` filters (Story 4)
  - The shorthand `task triage:cache` / `task triage:accept <N>` / etc. forms are intentionally NOT wired in Story 6 because go-task v3 cannot share an `includes:` namespace key across multiple files; consolidating top-level aliases into a single `triage:*` surface is tracked as a follow-up cleanup PR after the four-fragment cascade has fully landed and the inner task names are stable on master. Use the namespaced forms above until that follow-up ships.

### What changes for consumers

- **Additive nature.** Nothing existing breaks. The refinement skill's Phase 0 (Story 5) auto-skips when the cache is empty, so a consumer who never runs `task triage:bootstrap` sees the same v0.24.0 refinement experience.
- **Opt-in path is fast.** `task triage:bootstrap` finishes in ~5 minutes for a ~200-issue corpus. Larger corpora scale linearly with `gh issue list` throughput. The bootstrap is interruptible -- a Ctrl-C mid-populate leaves `.deft-cache/` in a partial state that the next run completes idempotently.
- **Gitignore default.** `.deft-cache/` is gitignored by default. The bootstrap step (3) ensures the line is present. See [docs/privacy-nfr.md](./docs/privacy-nfr.md) for the privacy contract that motivates the default.
- **Opt-in commit-cache contract.** Consumers who want to commit the cache for shared-cache scenarios MUST manually edit `.gitignore` to comment out the `.deft-cache/` line. Deft tooling will not perform this edit automatically -- the manual step is the deliberate-action gate. See `NFR-2` in [docs/privacy-nfr.md](./docs/privacy-nfr.md).
- **Quarantine on the cache write path.** Cached issue bodies are passed through `quarantine_body` (Story 1) before being written to `.deft-cache/issues/<owner>-<repo>/<N>.md`. Headings whose text matches imperative tokens (`STEP`, `TASK:`, `IMPORTANT:`, etc.) are wrapped in fenced code blocks with the `quarantined` info string so downstream LLM consumers can treat the enclosed bytes as untrusted user input. See [docs/quarantine-spec.md](./docs/quarantine-spec.md) for the full algorithm + escape-hatch overrides.
- **Private-repo body content.** Bodies from private repos are stored verbatim on the local filesystem under `.deft-cache/`. The framework never transmits cache contents externally. Operators in regulated environments should review NFR-3, NFR-4, NFR-5 in `docs/privacy-nfr.md`.

### Rollback

The entire triage v1 opt-in is reversible:

```bash
rm -rf .deft-cache/
# remove the `.deft-cache/` line from .gitignore
rm -rf vbrief/.eval/candidates.jsonl
```

This returns the project to its pre-bootstrap state. Existing scope vBRIEFs in `vbrief/proposed/` / `vbrief/pending/` / `vbrief/active/` are untouched -- the audit log only tracks decisions, not the vBRIEFs themselves.

### References

- [`docs/quarantine-spec.md`](./docs/quarantine-spec.md) -- formal spec for the #583 injection-quarantine algorithm consumed by Story 1's cache writer.
- [`docs/privacy-nfr.md`](./docs/privacy-nfr.md) -- privacy contract for `.deft-cache/` (gitignore default, opt-in commit path, private-repo body treatment).
- [#845](https://github.com/deftai/directive/issues/845) -- pre-ingest triage workflow umbrella.
- [#583](https://github.com/deftai/directive/issues/583) -- original injection-quarantine specification.

---

## From pre-#768 AGENTS.md → managed-section AGENTS.md

- **Applies when:** `./AGENTS.md` exists at your project root AND does **not** contain the `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->` sentinel markers. This is the canonical pre-#768 state -- the file pre-dates the Deft-managed-section contract added in v0.20.0 (#768) -- and is reported as `agents-md=missing` by `.deft/core/run gate`. (Distinct from `agents-md=absent`, which means no `AGENTS.md` exists at all.)
- **Safe to auto-run:** Yes. `.deft/core/run agents:refresh` performs a **one-time legacy migration**: your existing `AGENTS.md` content is preserved verbatim ABOVE the rendered managed-section block (separated by one blank line). The framework only ever owns the bytes between the two sentinel markers; content outside that bracketed region is never modified. Run `.deft/core/run agents:refresh --dry-run` first to preview the planned change, or `.deft/core/run agents:refresh --check` to interrogate the current state without writing.
- **Restart required:** Yes -- after the managed section is appended, the agent's current session still holds the pre-#768 `AGENTS.md` in context. Start a new agent session so the refreshed `AGENTS.md` (Implementation Intent Gate, Branch Policy Disclosure, Pre-Cutover Check, etc.) is loaded from a clean context.
- **Commands:**
  - `python .deft/core/run agents:refresh --dry-run` (preview; never writes)
  - `python .deft/core/run agents:refresh` (apply -- one-time append for state=`missing`, byte-replace for state=`stale`, no-op for state=`current`, fresh write for state=`absent`)
  - `python .deft/core/run upgrade` (records the framework version in `vbrief/.deft-version` AND chains into `agents:refresh` -- equivalent end state to running both above)

### What `agents:refresh` does on a pre-#768 file

The gate (`.deft/core/run gate`) classifies every project's `AGENTS.md` into one of four states; pre-#768 files land in `missing`:

- `current` -- markers present and bracketed bytes match the rendered template. No-op.
- `stale` -- markers present but bracketed bytes have drifted from the rendered template. Byte-replace the bracketed region in place.
- `missing` -- file exists but no markers (pre-#768 legacy file). **One-time append** of the rendered managed section, preserving existing content verbatim above the markers.
- `absent` -- file does not exist. Create from the rendered template.

### Long-term contract: sentinel-only rewrite

After the one-time legacy migration, every subsequent `.deft/core/run agents:refresh` against the same project follows a **sentinel-only-rewrite** contract: the framework reads only the bytes between `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->`, replaces them in place when the rendered template drifts (`stale` state), and never touches content above or below those markers. Hand-authored notes, custom rules, project-specific gates, and any text that lived in your `AGENTS.md` before the one-time append survive every future framework upgrade verbatim.

The contract is byte-stable by construction:

- `agents:refresh --check` exits 0 only when the bracketed bytes match the rendered template byte-for-byte; this is the regression guard against silent drift.
- The bracketed region is the SOLE byte sequence the framework owns. Edits inside the markers are not preserved across upgrades; edit the consumer-section above or below the markers instead.
- The migration is idempotent: re-running `.deft/core/run agents:refresh` against an already-migrated file is a no-op.

### References

- [`templates/agents-entry.md`](./templates/agents-entry.md) -- the canonical rendered managed-section template; this is the source of the bytes that `.deft/core/run agents:refresh` writes between the sentinel markers.
- [`QUICK-START.md`](./QUICK-START.md) Case G -- agent-prescriptive coverage of the same scenario for agents that read `QUICK-START.md` (rather than invoking `.deft/core/run agents:refresh` directly).
- [#768](https://github.com/deftai/directive/issues/768) -- the universal upgrade gate that introduced the managed-section markers and the `agents:refresh` reference implementation.

---

## From any pre-v0.20 version → v0.20.0

- **Applies when:** `.deft/core/run gate` reports `precutover=SPECIFICATION.md,PROJECT.md` (or any subset thereof) AND/OR `agents-md=missing`. The presence of legacy `SPECIFICATION.md` / `PROJECT.md` without the `<!-- deft:deprecated-redirect -->` sentinel is the canonical pre-cutover signal.
- **Safe to auto-run:** No -- `task migrate:vbrief` rewrites `SPECIFICATION.md` and `PROJECT.md` into deprecation-redirect stubs and creates lifecycle folders; the operator must review the dry-run output and acknowledge the rewrite. `--dry-run` is recommended on any non-trivial project before the live run.
- **Restart required:** Yes -- the agent's current session still holds stale rules from the previous `AGENTS.md`. After cleanup commands complete, stop the session and start a fresh one so the rewritten `AGENTS.md` and v0.20 skills are loaded from a clean context.
- **Commands:**
  - `task migrate:vbrief --dry-run` (preview)
  - `task migrate:vbrief` (apply)
  - `.deft/core/run upgrade` (writes `vbrief/.deft-version` AND now refreshes the AGENTS.md managed section in one step per #768)
  - `.deft/core/run agents:refresh` (idempotent; runs implicitly via `.deft/core/run upgrade` -- only invoke directly if you skipped that step)
  - `task roadmap:render` / `task project:render` / `task prd:render -- --force` (regenerate exports)
  - `task check` (verify)

### Remote probe (#801)

- **Applies when:** the periodic remote-version probe (added in this section's source release) prints a `⚠ Upstream directive v<N> is available (you are on v<M>)` warn line below the existing recorded-vs-current banner, OR `task framework:check-updates` exits non-zero (status `BEHIND`).
- **Safe to auto-run:** Yes for the probe itself (read-only `git ls-remote --tags --refs <upstream>`, never mutates project state, throttled 24h per tag, opt-out via `DEFT_NO_NETWORK=1`). The remediation -- pulling the upstream submodule -- is NOT auto-run; the operator decides when to update.
- **Restart required:** No for the probe. Once you actually update the framework (refresh the `./deft` submodule), the standard "start a new agent session" rule from the recorded-vs-current upgrade flow applies.
- **Commands:**
  - `task framework:check-updates` (synchronous probe, exit 1 on BEHIND; pass `-- --force` to bypass the 24h throttle and `-- --json` for machine-parseable output)
  - `git submodule update --remote --merge deft && git add deft && git commit -m "chore(deft): bump submodule"` (canonical update path -- mirrors `skills/deft-directive-sync/SKILL.md` Phase 2)
  - `.deft/core/run upgrade` (after the bump, to record the new framework version in `vbrief/.deft-version` and refresh the AGENTS.md managed section)
  - `DEFT_NO_NETWORK=1 task <anything>` (CI / air-gapped opt-out: probe short-circuits before any subprocess call)

**What changed:** Deft moved from a flat document model (`SPECIFICATION.md`, `PROJECT.md`, `ROADMAP.md` as authoritative) to a **vBRIEF-centric model** with lifecycle folders. All skills were renamed from `deft-*` to `deft-directive-*`.

### One-paragraph summary

After you update `deft/` to v0.20.0, `vbrief/*.vbrief.json` files are the source of truth; the familiar `PRD.md`, `SPECIFICATION.md`, and `ROADMAP.md` are **rendered views** generated by `task *:render`. Scope vBRIEFs live in lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`). Every legacy skill path (`skills/deft-sync/`, `skills/deft-setup/`, …) now contains a small redirect stub pointing at `deft/QUICK-START.md`, which rewrites your stale `AGENTS.md` and runs migration. The deft framework itself detects the state and tells your agent what to do.

### Upgrade steps

1. **Update the framework.** Pick whichever matches how you installed deft:
   - **Submodule:** `cd deft && git fetch && git checkout v0.20.0 && cd ..` then `git add deft && git commit -m "chore(deft): bump to v0.20.0"`.
   - **Installer binary:** run the new installer against your existing project directory; it updates the clone and appends any new skill thin pointers idempotently.
   - **Direct clone:** `cd deft && git pull --rebase && git checkout v0.20.0`.
2. **Have your agent read `deft/QUICK-START.md` and follow it.** Example prompt: *"Read `deft/QUICK-START.md` and follow it."* QUICK-START detects your project state and refreshes `AGENTS.md` idempotently; if it needs to rewrite the Deft-managed section or run migration, it tells you and instructs your next step.
3. **Run migration** (if QUICK-START asks for it): `task migrate:vbrief`. See [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for a detailed walkthrough of what migration does and how to preserve existing content.
4. **Regenerate rendered exports.** v0.20.0's `task migrate:vbrief` does not yet auto-invoke the renderers at the end (tracked: [#630](https://github.com/deftai/directive/issues/630), slated for v0.21). Run them manually once after migration so `ROADMAP.md` and any pre-existing `PRD.md` reflect the migrated `vbrief/` source of truth:
   ```bash
   task roadmap:render
   task project:render        # refresh PROJECT-DEFINITION items registry
   task prd:render -- --force # only if you previously maintained a PRD.md
   # task spec:render         # optional; re-emits SPECIFICATION.md from narratives
   ```
   The `deft-directive-pre-pr` skill auto-renders `PRD.md` / `SPECIFICATION.md` at Phase 3b on every PR, so you only need to run these explicitly once post-migration. `ROADMAP.md` is not covered by Phase 3b auto-render.
5. **Record the framework version** so the CLI upgrade gate stops warning on every invocation: `.deft/core/run upgrade` writes `vbrief/.deft-version`.
6. **Start a new agent session.** Your current session still holds stale rules from the previous `AGENTS.md`. Close the tab / session and open a new one; the agent will read the refreshed `AGENTS.md` and v0.20 skills on its own.
7. **Verify.** Run `task check` -- the full pre-commit pipeline (fmt + lint + typecheck + tests + vbrief validation + link check) must be green. If `task vbrief:validate` warns about `SPECIFICATION.md` or `PROJECT.md`, the deprecation redirect stubs were not written correctly; re-run `task migrate:vbrief` or patch the stubs to include the `<!-- deft:deprecated-redirect -->` line on the first line.

### Upgrade safety

~ When running `task migrate:vbrief` against a non-trivial project for the first time, test it on a fork or a clean working copy before applying it to your primary checkout. The migration is designed to be idempotent and preserves existing narratives, but real-world repos vary -- exercising the migration once against a disposable copy lets you review the redirect stubs, lifecycle folder contents, and `task check` output before accepting the changes.

### What to expect

- Your `SPECIFICATION.md` and `PROJECT.md` are replaced with short redirect stubs containing `<!-- deft:deprecated-redirect -->` on the first line. Existing content is migrated into `vbrief/specification.vbrief.json` narratives + `vbrief/pending/` scope vBRIEFs + `vbrief/PROJECT-DEFINITION.vbrief.json` narratives. `ROADMAP.md` remains an **actively rendered view** (not a deprecation redirect) -- it is backed up to `ROADMAP.premigrate.md` and is regenerated by `task roadmap:render` from the migrated scope vBRIEFs in `vbrief/pending/` and `vbrief/completed/`.
- `.md` files continue to exist as **rendered views**, generated on demand via `task spec:render`, `task prd:render`, `task roadmap:render`. ⊗ Edit them directly — your changes are overwritten on the next render; edit the underlying `.vbrief.json` instead.
- Skills live under new `deft-directive-*` directory names. Legacy `skills/deft-*/SKILL.md` files contain small redirect stubs that point agents at `deft/QUICK-START.md`; they exist for one release cycle so v0.19 `AGENTS.md` files that still reference old paths keep working until you re-run QUICK-START.
- The CLI (`.deft/core/run`) now has a **non-fatal upgrade gate** (issue #410). After updating, the gate warns once per invocation until you run `.deft/core/run upgrade` or `task migrate:vbrief`. Interactive sessions get a `Continue anyway? [y/N]` prompt; non-interactive sessions (CI, cloud agents) warn and continue.
- **New `task issue:ingest`** (#454) -- materialise GitHub issues as scope vBRIEFs in `vbrief/proposed/` (single-issue mode `task issue:ingest -- <N>` or bulk `task issue:ingest -- --all [--label L] [--status S] [--dry-run]`). Deduplicates against existing origin-provenance references so the `task reconcile:issues` unlinked section stops growing monotonically post-GA.

### Troubleshooting

- **Agent says it can't find `deft/skills/deft-sync/SKILL.md`:** that is a stale v0.19 `AGENTS.md` path. Tell your agent: *"Read `deft/QUICK-START.md` and follow it."* If the dummy redirect stub is read, it also points at QUICK-START.md.
- **`task check` fails on `task vbrief:validate`:** typical causes are filename convention (must be `YYYY-MM-DD-<lowercase-slug>.vbrief.json`), folder/status mismatch (use `task scope:activate|complete|cancel|restore|block|unblock` to move files), or missing `overview` / `tech stack` narrative keys on `PROJECT-DEFINITION.vbrief.json`.
- **CLI keeps warning about version drift:** run `.deft/core/run upgrade` to record the current framework version in `vbrief/.deft-version`.
- **"My existing `AGENTS.md` additions got wiped":** QUICK-START refreshes only the Deft-managed section (bounded by the `deft/main.md` sentinel region). If you saw content outside that region change, please file an issue with `discovered-during-402` so we can tighten the detection.

### References

- [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) — detailed brownfield adoption / migration walkthrough.
- [QUICK-START.md](./QUICK-START.md) — agent-facing bootstrap + upgrade detection.
- [vbrief/vbrief.md](./vbrief/vbrief.md) — canonical vBRIEF file taxonomy.
- [glossary.md](./glossary.md) — canonical v0.20 vocabulary (Scope vBRIEF, lifecycle folder, canonical narrative keys, rendered export, source of truth, ...).
- [CHANGELOG.md](./CHANGELOG.md) — full v0.20.0 change list.

---

Future upgrade sections will be prepended here as new releases ship. Each section starts with `## From <prev> → <new>` and follows the same shape: summary, steps, expectations, troubleshooting, references.
