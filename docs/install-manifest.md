# Install manifest -- `<install>/VERSION` (canonical) and `.deft-version` (derivative)

**Issue:** [#1046](https://github.com/deftai/directive/issues/1046) PR-B AC-4 (canonical install manifest).
**Status:** active from v0.28; back-compatible with v0.27.x consumers via the bare `.deft-version` regeneration path.

## Why the framework records its install provenance

Every deft install (`run install`, `task upgrade`, `oz-agent-upgrade`, the
webinstaller's `upgrade.sh` / `upgrade.ps1` rail) needs to record **what
the framework currently believes about itself on disk** so the upgrade
gate, the framework doctor, and downstream sync skills can detect drift.
Pre-v0.28 the only artifact on disk was a bare `.deft-version` file
containing a single version string (e.g. `0.27.1`). That file is not
enough for the #1046 install/refresh-contract self-healing path:

- The bare string carries no upstream-ref or commit-sha provenance, so a
  consumer that pinned to `main` instead of a tagged release has no way
  to reconcile "I am on framework SHA X" against "the upstream just
  cut Y".
- The bare string lives at the **project root** (`./.deft-version`) but
  the framework itself can live anywhere on disk (`./deft/`,
  `./.deft/core/`). Drift between the two paths is the #1046 finding #4
  root cause -- the doctor's `manifest-agreement` check exists to catch
  exactly this case.
- `oz-agent-upgrade`, the webinstaller, and any future package-manager
  rail already produce richer provenance (ref / sha / tag / fetched_at /
  fetched_by). The framework needs a canonical place to store it.

The v0.28 contract: the **canonical** install manifest lives at
`<install>/VERSION` as a YAML provenance file; the bare
`.deft-version` becomes a **derivative** regenerated from the manifest
on every install.

## File layout

```yaml
ref: 'v0.27.1'
sha: 'af829f4ec5bbe6ef562722d76080bb94ba893f8e'
tag: 'v0.27.1'
install_root: '.deft/core'
fetched_at: '2026-05-11T15:30:52Z'
fetched_by: 'oz-agent-upgrade'
```

| Field          | Required                       | Description                                                                                                  |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ref`          | yes                            | Upstream ref the framework was fetched from. Usually a tag (`v0.27.1`) but may be a branch (`main`) for HEAD installs.    |
| `sha`          | yes                            | Full 40-char commit SHA of the framework HEAD at fetch time. Lets the doctor reconcile against `git rev-parse HEAD`.       |
| `tag`          | yes                            | The tag-reference version (`v0.27.1`) -- mirrors `oz-agent-upgrade` shape. The leading `v` is stripped when regenerating the bare `.deft-version` derivative (`0.27.1`).|
| `install_root` | required (added in v0.29.0)    | The relative POSIX-style path from the consumer project root to the framework deposit (e.g. `.deft/core` for canonical installs, `deft` for legacy state-A). This is the single source of truth for the install-layout contract (#1062): every writer rail (`run install`, `run upgrade`, `deft-install`, `oz-agent-upgrade`, webinstaller) records it at deposit time, and downstream consumers -- starting with the framework doctor's `install-path-consistency` check -- read this field instead of re-parsing AGENTS.md prose. Pre-v0.29 manifests that omit the field still parse; consumers fall back to the legacy AGENTS.md parse and surface a doctor INFO note when the fallback is taken. |
| `fetched_at`   | yes                            | ISO-8601 UTC timestamp of the install. Used by the doctor to flag stale installs against an `--age-days` threshold. |
| `fetched_by`   | yes                            | Identifier for the rail that produced the manifest (`oz-agent-upgrade`, `run-install`, `run-upgrade`, `deft-install`, `webinstaller`, ...). |

The file format is intentionally minimal YAML so the framework's pure-stdlib
parser in `run::_parse_install_manifest` does not need PyYAML at install
time. Values are single-quoted to disambiguate strings that happen to look
like YAML scalars (`true`, `null`, etc.).

## Install-root resolution

The manifest is anchored at the **install root** -- the directory the
framework was unpacked into. The framework supports two layouts on disk
(see `UPGRADING.md` "From deft/ -> .deft/core/"):

- `<project_root>/.deft/core/VERSION` -- canonical install layout
  (current installer / webinstaller / sync skill / oz output).
- `<project_root>/deft/VERSION` -- legacy install layout
  (state A in the #992 detector; still supported in v0.28 for
  back-compat).

The framework doctor's `install-path-consistency` check resolves the
install root from the AGENTS.md `Full guidelines: <root>/main.md`
declaration and verifies the manifest lives at the declared root.

## `.deft-version` is now a derivative

After v0.28, `.deft-version` is regenerated on every install / upgrade
from the manifest's `tag` field (with the leading `v` stripped, matching
the v0.27 bare-file format). A drift between the manifest's `tag` and
the bare `.deft-version` is reported by the framework doctor as a
`manifest-agreement` check failure.

Operators should NOT hand-edit `.deft-version` -- update the canonical
manifest and re-run `task upgrade` to regenerate the derivative.

## Writers

The following surfaces write the canonical manifest:

| Writer                | When                                                | `fetched_by` value     |
| --------------------- | --------------------------------------------------- | ---------------------- |
| `run install`         | Fresh install / reinstall in a project directory    | `run-install`          |
| `run upgrade`         | Marker-bump alongside `.deft-version` regeneration  | `run-upgrade`          |
| `task upgrade`        | Wraps `run upgrade`; same writer                    | `run-upgrade`          |
| `oz-agent-upgrade`    | Cloud agent install pipeline                        | `oz-agent-upgrade`     |
| `webinstaller`        | `upgrade.sh` / `upgrade.ps1` rail (#992 PR2 successors) | `webinstaller`     |

All writers go through a single helper (`run::_write_install_manifest`)
so the on-disk shape stays consistent. The helper is best-effort: a
read-only filesystem (CI cache layer, container image at runtime) silently
degrades to no-op rather than crashing the install.

## Readers and drift reconciliation

- `scripts/framework_doctor.py` (`task framework:doctor`) -- four-check
  probe; the `manifest-agreement` check reads the manifest, compares
  the `tag` field against the framework's resolved VERSION, and reports
  drift. Three-state exit (0 clean / 1 drift / 2 config error).
- `run::_check_upgrade_gate` -- informational advisory only; emits a
  one-line warn when the doctor reports drift but never blocks the
  gate (mirrors the #801 remote-version probe contract).
- The agentic refresh path (`skills/deft-directive-sync/SKILL.md`) reads
  the manifest to decide whether a sync is needed; a manifest pointing
  at a stale `tag` triggers the Phase 2 framework-update flow.

On drift between the manifest's `tag` and the bare `.deft-version`,
**prefer the YAML manifest** -- it is the canonical source. The bare
file is regenerated to match on the next `task upgrade`.

## Back-compat for v0.27.x consumers

Projects upgrading from v0.27.x that have an existing
`./.deft-version` file but no `<install>/VERSION` manifest see the
following sequence on first `task upgrade`:

1. The upgrade gate detects the missing manifest and emits a one-line
   advisory pointing at `task framework:doctor`.
2. `task upgrade` writes the canonical manifest at the install root
   with the current framework VERSION as `tag`, the resolved git SHA
   as `sha`, `fetched_by: run-upgrade`, and `fetched_at` set to the
   UTC time of the write.
3. The bare `.deft-version` is updated to match the manifest's `tag`.
4. The doctor's `manifest-agreement` check transitions from FAIL to
   PASS on the next run.

No manual operator action is required -- the transition is automatic on
the first `task upgrade` invocation.

## References

- [#1046](https://github.com/deftai/directive/issues/1046) -- install / refresh contract umbrella.
- [#992](https://github.com/deftai/directive/issues/992) -- adopt `.deft/core/` as canonical install layout (defines the install-root contract this manifest is anchored to).
- [#410](https://github.com/deftai/directive/issues/410) -- original upgrade gate + `.deft-version` marker (predecessor surface this manifest extends).
- [`scripts/framework_doctor.py`](../scripts/framework_doctor.py) -- doctor probe (`manifest-agreement` check).
- [`run::_write_install_manifest`](../run) / [`run::_read_install_manifest`](../run) -- canonical writer / reader.
- [`tasks/framework.yml`](../tasks/framework.yml) -- `task framework:doctor` task surface.
