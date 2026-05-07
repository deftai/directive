"""End-to-end regressions for migrator canonical references + narrative clamp.

Covers:

* Issue #613 -- ``task migrate:vbrief`` emits ``references[]`` entries in the
  canonical v0.6 ``{uri, type: "x-vbrief/github-issue", title}`` shape. Legacy
  ``{type: "github-issue", id, url}`` stubs must not appear on any migrator
  output. ROADMAP rows without an issue number MUST NOT produce a stub
  reference.
* Issue #616 (option A, scope-clamped) + Fix A -- per-issue scope vBRIEFs
  ship with ``plan.narratives`` containing ONLY ``SourceSection`` (the
  named exception added by #593 for audit-trail purposes). Reconciliation
  provenance (SourceConflict, Description_source, Status_source,
  Title_source, SpecPhase, RoadmapSummary, Description) is relocated to
  ``plan.metadata['x-migrator']``; those invented keys do not leak back
  into narratives.
* Spec-level ingest path (``specification.vbrief.json``) continues to emit
  canonical v0.6 narrative keys -- the per-issue clamp does not touch it.

These tests exercise ``scripts/migrate_vbrief.py`` end-to-end (fixture on
disk -> migrator -> assertions) and validate at least one emitted scope
reference against the ``VBriefReference`` definition in
``vbrief/schemas/vbrief-core.schema.json``.

Bundle: PR-beta (#613 + #616). Companion file to the broader regression
suite in ``tests/cli/test_migrate_vbrief.py``; kept separate so the
canonical-shape assertions live in one focused, <500-line file.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from migrate_vbrief import migrate  # noqa: E402

SCHEMA_PATH = REPO_ROOT / "vbrief" / "schemas" / "vbrief-core.schema.json"
LEGACY_ORIGIN_TYPE_RE = re.compile(r'"type"\s*:\s*"github-issue"')

# A ``spec_vbrief.repository`` hint is the simplest way to let the migrator
# resolve ``repo_url`` during tests (pytest's ``tmp_path`` is deliberately
# outside any git worktree, so the ``git remote get-url origin`` fallback
# would otherwise return empty). Using a synthetic ``owner/repo`` keeps the
# fixtures isolated from whichever repo the test runner happens to sit under.
REPO_SLUG = "owner/repo"
REPO_URL = f"https://github.com/{REPO_SLUG}"


def _make_project(
    tmp_path: Path, roadmap_md: str, spec_vbrief: dict | None = None
) -> Path:
    """Minimal pre-cutover project with a ROADMAP and (optional) spec vBRIEF."""
    vbrief_dir = tmp_path / "vbrief"
    vbrief_dir.mkdir(exist_ok=True)
    if spec_vbrief is not None:
        (vbrief_dir / "specification.vbrief.json").write_text(
            json.dumps(spec_vbrief, indent=2), encoding="utf-8"
        )
    (tmp_path / "ROADMAP.md").write_text(roadmap_md, encoding="utf-8")
    return tmp_path


def _spec_with_repo(items: list[dict] | None = None) -> dict:
    return {
        "vBRIEFInfo": {
            "version": "0.5",
            "description": "Test spec",
            "repository": REPO_SLUG,
        },
        "plan": {
            "title": "Test",
            "status": "approved",
            "narratives": {
                "Overview": "Synthetic project for migrator regression tests.",
                "Goals": "Validate canonical references and narrative clamp.",
                "ProblemStatement": "Legacy refs break Phase 6 auto-close.",
            },
            "items": items or [],
        },
    }


def _all_scope_vbriefs(project: Path) -> list[Path]:
    results: list[Path] = []
    for folder in ("proposed", "pending", "active", "completed", "cancelled"):
        results.extend((project / "vbrief" / folder).glob("*.vbrief.json"))
    return results


def _load_vbrief_reference_rules() -> tuple[list[str], list[str], re.Pattern[str]]:
    """Return (uri_required_keys, vbrief_required_keys, type_pattern).

    Reads the vendored v0.6 schema and extracts the structural rules the
    ``VBriefReference`` definition enforces on a single reference object.
    Keeps the test dependency surface minimal -- no jsonschema required --
    while still tying the assertion to the schema file so a future schema
    edit that loosens or tightens these rules surfaces immediately.
    """
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    uri_def = schema["$defs"]["URI"]
    vbrief_ref = schema["$defs"]["VBriefReference"]
    uri_required = list(uri_def.get("required", []))
    vbrief_required: list[str] = []
    type_pattern: str = "^x-vbrief/"
    for piece in vbrief_ref.get("allOf", []):
        if not isinstance(piece, dict):
            continue
        vbrief_required.extend(piece.get("required", []))
        type_spec = piece.get("properties", {}).get("type", {})
        if isinstance(type_spec, dict) and type_spec.get("pattern"):
            type_pattern = type_spec["pattern"]
    return uri_required, vbrief_required, re.compile(type_pattern)


def _validate_reference(ref: dict) -> None:
    """Validate a single reference dict against the VBriefReference rules.

    The vendored v0.6 schema defines ``VBriefReference`` as ``URI`` + an
    extra block that requires ``uri`` + ``type`` and constrains ``type``
    to the ``^x-vbrief/`` pattern. Rather than pull in ``jsonschema`` as
    a dev dependency for a single assertion, we enforce the same rules
    inline, sourcing them from the schema file itself.
    """
    uri_required, vbrief_required, type_pattern = _load_vbrief_reference_rules()
    for key in uri_required + vbrief_required:
        assert key in ref, (
            f"VBriefReference schema requires {key!r}; got keys {sorted(ref)}"
        )
    assert isinstance(ref["uri"], str) and ref["uri"], (
        f"VBriefReference.uri must be a non-empty string; got {ref['uri']!r}"
    )
    assert isinstance(ref["type"], str) and type_pattern.match(ref["type"]), (
        f"VBriefReference.type must match {type_pattern.pattern!r}; "
        f"got {ref['type']!r}"
    )


# ---------------------------------------------------------------------------
# #613 -- canonical reference shape
# ---------------------------------------------------------------------------


class TestCanonicalReferenceShape:
    """#613: every ROADMAP row with an issue number yields a canonical ref."""

    def test_every_issue_scope_carries_canonical_reference(self, tmp_path):
        roadmap = (
            "# Roadmap\n\n"
            "## Phase 1 -- Foundation\n\n"
            "- **#100** -- Add widget support\n"
            "- **#101** -- Fix login bug\n\n"
            "## Phase 2 -- Features\n\n"
            "- **#200** -- Dashboard redesign\n\n"
            "## Completed\n\n"
            "- ~~#50 -- Initial setup~~\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, actions = migrate(project)
        assert ok, actions

        seen: set[str] = set()
        for fpath in _all_scope_vbriefs(project):
            data = json.loads(fpath.read_text(encoding="utf-8"))
            refs = data["plan"].get("references", [])
            # Every scope in this fixture traces back to a GitHub issue,
            # so every vBRIEF must carry exactly one canonical reference.
            assert len(refs) == 1, (
                f"{fpath.name} expected exactly one reference; got {refs}"
            )
            ref = refs[0]
            assert ref["type"] == "x-vbrief/github-issue"
            assert ref["uri"].startswith(f"{REPO_URL}/issues/")
            assert ref["title"].startswith("Issue #")
            # Legacy fields MUST NOT leak into canonical output.
            assert "id" not in ref, f"legacy 'id' leaked into {fpath.name}"
            assert "url" not in ref, f"legacy 'url' leaked into {fpath.name}"
            seen.add(ref["uri"])

        # All four issue numbers from the fixture surface exactly once.
        assert seen == {
            f"{REPO_URL}/issues/{n}" for n in ("50", "100", "101", "200")
        }

    def test_legacy_reference_shape_absent_from_migrator_output(self, tmp_path):
        """#613 evidence metric: dogfood passes should produce 0 legacy refs."""
        roadmap = (
            "# Roadmap\n\n## Phase 1\n\n"
            "- **#89** -- Deft identity and positioning\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        for fpath in _all_scope_vbriefs(project):
            blob = fpath.read_text(encoding="utf-8")
            assert not LEGACY_ORIGIN_TYPE_RE.search(blob), (
                f"legacy reference type leaked into {fpath.name}: {blob}"
            )
            assert '"id": "#89"' not in blob, (
                f"legacy bare id leaked into {fpath.name}"
            )

    def test_bare_text_roadmap_row_emits_no_reference(self, tmp_path):
        """Task A acceptance: bare ROADMAP rows with no issue number MUST NOT
        produce a legacy-shape stub reference. The canonical VBriefReference
        schema requires ``uri`` and we cannot honestly build one from a
        ``completed:Convert to TDD mode``-style entry.
        """
        roadmap = (
            "# Roadmap\n\n## Phase 3\n\n"
            "- Convert to TDD mode\n"
            "- Code signing\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        for fpath in _all_scope_vbriefs(project):
            data = json.loads(fpath.read_text(encoding="utf-8"))
            refs = data["plan"].get("references")
            # Either the key is absent entirely or it is an empty list --
            # both are honest signals that the row has no GitHub-issue origin.
            assert refs in (None, []), (
                f"{fpath.name} emitted a bogus reference for a bare row: "
                f"{refs}"
            )

    def test_reference_validates_against_vbriefreference_schema(self, tmp_path):
        roadmap = "# Roadmap\n\n## Phase 1\n\n- **#613** -- Canonical refs\n"
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        scopes = _all_scope_vbriefs(project)
        assert scopes, "fixture must produce at least one scope vBRIEF"
        for fpath in scopes:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            for ref in data["plan"].get("references", []):
                _validate_reference(ref)

    def test_project_definition_references_are_canonical(self, tmp_path):
        """PROJECT-DEFINITION.plan.items[*].references match the scope vBRIEF
        canonical shape so the registry row and the scope file agree on
        origin provenance (#613).
        """
        roadmap = "# Roadmap\n\n## Phase 1\n\n- **#613** -- Canonical refs\n"
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        pd = json.loads(
            (project / "vbrief" / "PROJECT-DEFINITION.vbrief.json").read_text(
                encoding="utf-8"
            )
        )
        items = pd["plan"]["items"]
        assert len(items) == 1
        refs = items[0].get("references", [])
        assert len(refs) == 1
        assert refs[0]["type"] == "x-vbrief/github-issue"
        assert refs[0]["uri"] == f"{REPO_URL}/issues/613"
        assert refs[0]["title"].startswith("Issue #613:")
        assert "id" not in refs[0]
        assert "url" not in refs[0]


# ---------------------------------------------------------------------------
# #616 -- narrative clamp
# ---------------------------------------------------------------------------


class TestNarrativeClamp:
    """#616 (option A) + Fix A: per-issue scope vBRIEFs carry ONLY the
    ``SourceSection`` narrative (the named #593 audit-trail exception);
    no other invented keys may appear.
    """

    def test_every_per_issue_scope_narratives_only_source_section(
        self, tmp_path,
    ):
        roadmap = (
            "# Roadmap\n\n## Phase 1 -- Foundation\n\n"
            "Description of phase 1 for the migrator.\n\n"
            "- **#103** -- Standalone brownfield map\n"
            "- **#112** -- External deft directive PDF is premature\n"
            "- **#114** -- Document all global Warp rules\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        scopes = _all_scope_vbriefs(project)
        assert scopes, "fixture must produce at least one scope vBRIEF"
        for fpath in scopes:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            narratives = data["plan"].get("narratives", {})
            # Exactly zero or one key allowed, and only SourceSection.
            assert set(narratives).issubset({"SourceSection"}), (
                f"{fpath.name}: unexpected narrative keys {sorted(narratives)}"
            )

    def test_invented_keys_never_appear_in_narratives(self, tmp_path):
        """Regression guard against any of the #616 invented keys leaking
        back into ``plan.narratives``. Covers every key the issue body
        enumerated plus the reconciler-specific fields routed through
        ``build_scope_vbrief_from_reconciled``.
        """
        roadmap = (
            "# Roadmap\n\n## Phase 1\n\n"
            "### Tier 1 -- Core\n\n"
            "- **#616** -- Narrative clamp\n\n"
            "## Completed\n\n"
            "- ~~#615 -- Shipped feature~~\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        # Fix A note: SourceSection is deliberately NOT in this set --
        # it is the named exception that lives in plan.narratives by
        # design (#593 audit-trail contract).
        invented_keys = {
            "Description",
            "Description_source",
            "Status_source",
            "Title_source",
            "SourceConflict",
            "Phase",
            "Tier",
            "PhaseDescription",
            "SpecPhase",
            "RoadmapSummary",
        }
        for fpath in _all_scope_vbriefs(project):
            data = json.loads(fpath.read_text(encoding="utf-8"))
            narratives = data["plan"].get("narratives", {})
            leaked = invented_keys & set(narratives)
            assert not leaked, (
                f"{fpath.name}: invented key(s) leaked into narratives: "
                f"{sorted(leaked)}"
            )

    def test_provenance_relocated_to_plan_metadata(self, tmp_path):
        """#616 option A still preserves reconciler-internal provenance
        (Phase, Tier, PhaseDescription, etc.) under
        ``plan.metadata['x-migrator']`` rather than ``plan.narratives``
        so downstream tooling (roadmap_render / reconcile_issues) can
        still find it. SourceSection is the named exception that lives
        in narratives (#593 audit trail) -- Fix A.
        """
        roadmap = (
            "# Roadmap\n\n## Phase 2 -- Integration\n\n"
            "### Tier 1 -- Core\n\n"
            "- **#617** -- Scope with phase and tier\n"
        )
        project = _make_project(tmp_path, roadmap, _spec_with_repo())
        ok, _ = migrate(project)
        assert ok
        scopes = _all_scope_vbriefs(project)
        assert scopes
        data = json.loads(scopes[0].read_text(encoding="utf-8"))
        migrator_meta = (
            data["plan"].get("metadata", {}).get("x-migrator", {})
        )
        assert migrator_meta.get("Phase") == "Phase 2 -- Integration"
        assert migrator_meta.get("Tier") == "Tier 1 -- Core"
        # SourceSection is not in metadata -- it lives in narratives
        # per the #593 audit-trail exception.
        assert "SourceSection" not in migrator_meta
        assert data["plan"]["narratives"].get("SourceSection") == (
            "ROADMAP active phase"
        )

    def test_reference_less_files_deduped_by_filename_stem(self, tmp_path):
        """Greptile P1 regression: when ``repo_url`` is unresolvable at
        migration time, scope vBRIEFs carry empty ``plan.references``
        (the canonical ``VBriefReference`` schema requires ``uri``).
        The migrator's duplicate-suppression path must still detect
        these files on re-run via the filename-stem fallback
        (``YYYY-MM-DD-{N}-``), otherwise cross-day re-migrations
        silently produce duplicates.
        """
        import sys as _sys

        # Ensure scripts/ is importable for this focused unit test.
        _sys.path.insert(0, str(REPO_ROOT / "scripts"))
        from migrate_vbrief import _find_existing_scope_vbrief

        vbrief_dir = tmp_path / "vbrief"
        completed = vbrief_dir / "completed"
        completed.mkdir(parents=True)
        reference_less_file = completed / (
            "2026-04-23-101-foundation-scaffolding.vbrief.json"
        )
        reference_less_file.write_text(
            json.dumps(
                {
                    "vBRIEFInfo": {"version": "0.6"},
                    "plan": {
                        "title": "Foundation scaffolding",
                        "status": "completed",
                        "references": [],
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        # Primary assertion: the fallback finds the reference-less file
        # by filename stem even though tiers 1 and 2 (reference scan)
        # miss.
        match = _find_existing_scope_vbrief(vbrief_dir, "101")
        assert match == reference_less_file, (
            "filename-stem fallback must find reference-less scope vBRIEFs"
        )

        # Boundary: "10" must NOT match "101-" (word-boundary check).
        assert _find_existing_scope_vbrief(vbrief_dir, "10") is None
        # And a totally unrelated number returns None.
        assert _find_existing_scope_vbrief(vbrief_dir, "999") is None

    def test_spec_level_narratives_unchanged(self, tmp_path):
        """The spec-level ingest path still emits canonical v0.6 narrative
        keys. The per-issue narrative clamp is strictly scoped to scope
        vBRIEFs; ``specification.vbrief.json`` continues to carry whatever
        narratives the ingest path provides.
        """
        roadmap = "# Roadmap\n\n## Phase 1\n\n- **#103** -- Scope item\n"
        spec = _spec_with_repo()
        project = _make_project(tmp_path, roadmap, spec)
        ok, _ = migrate(project)
        assert ok
        spec_path = project / "vbrief" / "specification.vbrief.json"
        spec_data = json.loads(spec_path.read_text(encoding="utf-8"))
        spec_narratives = spec_data["plan"]["narratives"]
        for canonical in ("Overview", "Goals", "ProblemStatement"):
            assert spec_narratives.get(canonical), (
                f"spec-level narrative {canonical!r} missing -- the #616 "
                f"clamp must not touch the spec ingest path"
            )
