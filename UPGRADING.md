# Upgrading Deft

Version-by-version upgrade guide. Newest versions are at the top.

> **Agents:** ! If you are reading this because a user updated the framework, have them start a **new agent session** after you finish the upgrade. Your current session may still hold stale AGENTS.md / skill references from the previous version.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

---

## From pre-#768 AGENTS.md → managed-section AGENTS.md

- **Applies when:** `./AGENTS.md` exists at your project root AND does **not** contain the `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->` sentinel markers. This is the canonical pre-#768 state -- the file pre-dates the Deft-managed-section contract added in v0.20.0 (#768) -- and is reported as `agents-md=missing` by `deft/run gate`. (Distinct from `agents-md=absent`, which means no `AGENTS.md` exists at all.)
- **Safe to auto-run:** Yes. `deft/run agents:refresh` performs a **one-time legacy migration**: your existing `AGENTS.md` content is preserved verbatim ABOVE the rendered managed-section block (separated by one blank line). The framework only ever owns the bytes between the two sentinel markers; content outside that bracketed region is never modified. Run `deft/run agents:refresh --dry-run` first to preview the planned change, or `deft/run agents:refresh --check` to interrogate the current state without writing.
- **Restart required:** Yes -- after the managed section is appended, the agent's current session still holds the pre-#768 `AGENTS.md` in context. Start a new agent session so the refreshed `AGENTS.md` (Implementation Intent Gate, Branch Policy Disclosure, Pre-Cutover Check, etc.) is loaded from a clean context.
- **Commands:**
  - `python deft/run agents:refresh --dry-run` (preview; never writes)
  - `python deft/run agents:refresh` (apply -- one-time append for state=`missing`, byte-replace for state=`stale`, no-op for state=`current`, fresh write for state=`absent`)
  - `python deft/run upgrade` (records the framework version in `vbrief/.deft-version` AND chains into `agents:refresh` -- equivalent end state to running both above)

### What `agents:refresh` does on a pre-#768 file

The gate (`deft/run gate`) classifies every project's `AGENTS.md` into one of four states; pre-#768 files land in `missing`:

- `current` -- markers present and bracketed bytes match the rendered template. No-op.
- `stale` -- markers present but bracketed bytes have drifted from the rendered template. Byte-replace the bracketed region in place.
- `missing` -- file exists but no markers (pre-#768 legacy file). **One-time append** of the rendered managed section, preserving existing content verbatim above the markers.
- `absent` -- file does not exist. Create from the rendered template.

### Long-term contract: sentinel-only rewrite

After the one-time legacy migration, every subsequent `deft/run agents:refresh` against the same project follows a **sentinel-only-rewrite** contract: the framework reads only the bytes between `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->`, replaces them in place when the rendered template drifts (`stale` state), and never touches content above or below those markers. Hand-authored notes, custom rules, project-specific gates, and any text that lived in your `AGENTS.md` before the one-time append survive every future framework upgrade verbatim.

The contract is byte-stable by construction:

- `agents:refresh --check` exits 0 only when the bracketed bytes match the rendered template byte-for-byte; this is the regression guard against silent drift.
- The bracketed region is the SOLE byte sequence the framework owns. Edits inside the markers are not preserved across upgrades; edit the consumer-section above or below the markers instead.
- The migration is idempotent: re-running `deft/run agents:refresh` against an already-migrated file is a no-op.

### References

- [`templates/agents-entry.md`](./templates/agents-entry.md) -- the canonical rendered managed-section template; this is the source of the bytes that `deft/run agents:refresh` writes between the sentinel markers.
- [`QUICK-START.md`](./QUICK-START.md) Case G -- agent-prescriptive coverage of the same scenario for agents that read `QUICK-START.md` (rather than invoking `deft/run agents:refresh` directly).
- [#768](https://github.com/deftai/directive/issues/768) -- the universal upgrade gate that introduced the managed-section markers and the `agents:refresh` reference implementation.

---

## From any pre-v0.20 version → v0.20.0

- **Applies when:** `deft/run gate` reports `precutover=SPECIFICATION.md,PROJECT.md` (or any subset thereof) AND/OR `agents-md=missing`. The presence of legacy `SPECIFICATION.md` / `PROJECT.md` without the `<!-- deft:deprecated-redirect -->` sentinel is the canonical pre-cutover signal.
- **Safe to auto-run:** No -- `task migrate:vbrief` rewrites `SPECIFICATION.md` and `PROJECT.md` into deprecation-redirect stubs and creates lifecycle folders; the operator must review the dry-run output and acknowledge the rewrite. `--dry-run` is recommended on any non-trivial project before the live run.
- **Restart required:** Yes -- the agent's current session still holds stale rules from the previous `AGENTS.md`. After cleanup commands complete, stop the session and start a fresh one so the rewritten `AGENTS.md` and v0.20 skills are loaded from a clean context.
- **Commands:**
  - `task migrate:vbrief --dry-run` (preview)
  - `task migrate:vbrief` (apply)
  - `deft/run upgrade` (writes `vbrief/.deft-version` AND now refreshes the AGENTS.md managed section in one step per #768)
  - `deft/run agents:refresh` (idempotent; runs implicitly via `deft/run upgrade` -- only invoke directly if you skipped that step)
  - `task roadmap:render` / `task project:render` / `task prd:render -- --force` (regenerate exports)
  - `task check` (verify)

### Remote probe (#801)

- **Applies when:** the periodic remote-version probe (added in this section's source release) prints a `⚠ Upstream directive v<N> is available (you are on v<M>)` warn line below the existing recorded-vs-current banner, OR `task framework:check-updates` exits non-zero (status `BEHIND`).
- **Safe to auto-run:** Yes for the probe itself (read-only `git ls-remote --tags --refs <upstream>`, never mutates project state, throttled 24h per tag, opt-out via `DEFT_NO_NETWORK=1`). The remediation -- pulling the upstream submodule -- is NOT auto-run; the operator decides when to update.
- **Restart required:** No for the probe. Once you actually update the framework (refresh the `./deft` submodule), the standard "start a new agent session" rule from the recorded-vs-current upgrade flow applies.
- **Commands:**
  - `task framework:check-updates` (synchronous probe, exit 1 on BEHIND; pass `-- --force` to bypass the 24h throttle and `-- --json` for machine-parseable output)
  - `git submodule update --remote --merge deft && git add deft && git commit -m "chore(deft): bump submodule"` (canonical update path -- mirrors `skills/deft-directive-sync/SKILL.md` Phase 2)
  - `deft/run upgrade` (after the bump, to record the new framework version in `vbrief/.deft-version` and refresh the AGENTS.md managed section)
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
5. **Record the framework version** so the CLI upgrade gate stops warning on every invocation: `deft/run upgrade` writes `vbrief/.deft-version`.
6. **Start a new agent session.** Your current session still holds stale rules from the previous `AGENTS.md`. Close the tab / session and open a new one; the agent will read the refreshed `AGENTS.md` and v0.20 skills on its own.
7. **Verify.** Run `task check` -- the full pre-commit pipeline (fmt + lint + typecheck + tests + vbrief validation + link check) must be green. If `task vbrief:validate` warns about `SPECIFICATION.md` or `PROJECT.md`, the deprecation redirect stubs were not written correctly; re-run `task migrate:vbrief` or patch the stubs to include the `<!-- deft:deprecated-redirect -->` line on the first line.

### Upgrade safety

~ When running `task migrate:vbrief` against a non-trivial project for the first time, test it on a fork or a clean working copy before applying it to your primary checkout. The migration is designed to be idempotent and preserves existing narratives, but real-world repos vary -- exercising the migration once against a disposable copy lets you review the redirect stubs, lifecycle folder contents, and `task check` output before accepting the changes.

### What to expect

- Your `SPECIFICATION.md` and `PROJECT.md` are replaced with short redirect stubs containing `<!-- deft:deprecated-redirect -->` on the first line. Existing content is migrated into `vbrief/specification.vbrief.json` narratives + `vbrief/pending/` scope vBRIEFs + `vbrief/PROJECT-DEFINITION.vbrief.json` narratives. `ROADMAP.md` remains an **actively rendered view** (not a deprecation redirect) -- it is backed up to `ROADMAP.premigrate.md` and is regenerated by `task roadmap:render` from the migrated scope vBRIEFs in `vbrief/pending/` and `vbrief/completed/`.
- `.md` files continue to exist as **rendered views**, generated on demand via `task spec:render`, `task prd:render`, `task roadmap:render`. ⊗ Edit them directly — your changes are overwritten on the next render; edit the underlying `.vbrief.json` instead.
- Skills live under new `deft-directive-*` directory names. Legacy `skills/deft-*/SKILL.md` files contain small redirect stubs that point agents at `deft/QUICK-START.md`; they exist for one release cycle so v0.19 `AGENTS.md` files that still reference old paths keep working until you re-run QUICK-START.
- The CLI (`deft/run`) now has a **non-fatal upgrade gate** (issue #410). After updating, the gate warns once per invocation until you run `deft/run upgrade` or `task migrate:vbrief`. Interactive sessions get a `Continue anyway? [y/N]` prompt; non-interactive sessions (CI, cloud agents) warn and continue.
- **New `task issue:ingest`** (#454) -- materialise GitHub issues as scope vBRIEFs in `vbrief/proposed/` (single-issue mode `task issue:ingest -- <N>` or bulk `task issue:ingest -- --all [--label L] [--status S] [--dry-run]`). Deduplicates against existing origin-provenance references so the `task reconcile:issues` unlinked section stops growing monotonically post-GA.

### Troubleshooting

- **Agent says it can't find `deft/skills/deft-sync/SKILL.md`:** that is a stale v0.19 `AGENTS.md` path. Tell your agent: *"Read `deft/QUICK-START.md` and follow it."* If the dummy redirect stub is read, it also points at QUICK-START.md.
- **`task check` fails on `task vbrief:validate`:** typical causes are filename convention (must be `YYYY-MM-DD-<lowercase-slug>.vbrief.json`), folder/status mismatch (use `task scope:activate|complete|cancel|restore|block|unblock` to move files), or missing `overview` / `tech stack` narrative keys on `PROJECT-DEFINITION.vbrief.json`.
- **CLI keeps warning about version drift:** run `deft/run upgrade` to record the current framework version in `vbrief/.deft-version`.
- **"My existing `AGENTS.md` additions got wiped":** QUICK-START refreshes only the Deft-managed section (bounded by the `deft/main.md` sentinel region). If you saw content outside that region change, please file an issue with `discovered-during-402` so we can tighten the detection.

### References

- [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) — detailed brownfield adoption / migration walkthrough.
- [QUICK-START.md](./QUICK-START.md) — agent-facing bootstrap + upgrade detection.
- [vbrief/vbrief.md](./vbrief/vbrief.md) — canonical vBRIEF file taxonomy.
- [glossary.md](./glossary.md) — canonical v0.20 vocabulary (Scope vBRIEF, lifecycle folder, canonical narrative keys, rendered export, source of truth, ...).
- [CHANGELOG.md](./CHANGELOG.md) — full v0.20.0 change list.

---

Future upgrade sections will be prepended here as new releases ship. Each section starts with `## From <prev> → <new>` and follows the same shape: summary, steps, expectations, troubleshooting, references.
