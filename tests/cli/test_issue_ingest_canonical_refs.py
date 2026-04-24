"""test_issue_ingest_canonical_refs.py -- Schema-conformance regression for issue_ingest.

Covers issue #639: ``scripts/issue_ingest.py`` must emit canonical vBRIEF v0.6
scope vBRIEFs with the ``VBriefReference`` shape ``{uri, type: "x-vbrief/github-issue",
title}`` documented in ``conventions/references.md``.

The legacy bare ``{type: "github-issue", id: "#N", url}`` shape MUST NOT appear
on any freshly-ingested output. ``vBRIEFInfo.version`` MUST be ``"0.6"``
(the const pinned by ``vbrief/schemas/vbrief-core.schema.json``).

Covers BOTH ingest paths end-to-end:

- Single-issue (``ingest_one``)
- Batch (``ingest_bulk``)

Every emitted reference is validated against the ``VBriefReference`` rules
extracted from the vendored v0.6 schema (same inline-validation pattern as
``tests/cli/test_migrate_vbrief_canonical_refs.py`` -- keeps the test
dependency surface minimal while tying the assertion to the schema file).
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
SCHEMA_PATH = REPO_ROOT / "vbrief" / "schemas" / "vbrief-core.schema.json"
LEGACY_ORIGIN_TYPE_RE = re.compile(r'"type"\s*:\s*"github-issue"')


def _load_issue_ingest():
    """Load scripts/issue_ingest.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_ingest_canonical_refs",
        scripts_dir / "issue_ingest.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_ingest = _load_issue_ingest()


# ---------------------------------------------------------------------------
# Schema helpers (inline VBriefReference validation)
# ---------------------------------------------------------------------------


def _load_vbrief_reference_rules() -> tuple[list[str], list[str], re.Pattern[str]]:
    """Return (uri_required_keys, vbrief_required_keys, type_pattern).

    Mirrors ``tests/cli/test_migrate_vbrief_canonical_refs.py::
    _load_vbrief_reference_rules`` -- reads the vendored v0.6 schema and
    extracts the structural rules the ``VBriefReference`` definition
    enforces on a single reference object. Keeps the test dependency
    surface minimal (no ``jsonschema``) while tying the assertion to the
    schema file so a future schema edit surfaces immediately.
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
    """Validate a single reference dict against the VBriefReference rules."""
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


def _load_emitted_version() -> str:
    """Read the ``const`` pinned on ``vBRIEFInfo.version`` from the schema."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return schema["$defs"]["vBRIEFInfo"]["properties"]["version"]["const"]


def _assert_schema_conformant(vbrief: dict, filename: str) -> None:
    """Common assertions applied to every freshly-ingested scope vBRIEF."""
    expected_version = _load_emitted_version()
    assert vbrief["vBRIEFInfo"]["version"] == expected_version, (
        f"{filename}: vBRIEFInfo.version must match schema const "
        f"{expected_version!r}; got {vbrief['vBRIEFInfo']['version']!r}"
    )
    plan = vbrief["plan"]
    # Plan MUST carry the three schema-required keys.
    assert plan.get("title"), f"{filename}: plan.title must be non-empty"
    assert plan.get("status"), f"{filename}: plan.status must be set"
    assert "items" in plan, f"{filename}: plan.items must be present"
    # Every reference MUST pass the VBriefReference rules.
    for ref in plan.get("references", []):
        _validate_reference(ref)
        # Explicit guard against legacy fields leaking into canonical output.
        assert "id" not in ref, f"{filename}: legacy 'id' leaked into reference"
        assert "url" not in ref, f"{filename}: legacy 'url' leaked into reference"


def _issue_payload(
    number: int, title: str, labels: list[str] | None = None
) -> dict:
    return {
        "number": number,
        "title": title,
        "url": f"https://github.com/owner/repo/issues/{number}",
        "labels": [{"name": name} for name in (labels or [])],
    }


# ---------------------------------------------------------------------------
# Single-issue ingest (ingest_one)
# ---------------------------------------------------------------------------


class TestSingleIssueCanonicalShape:
    """``ingest_one`` writes a scope vBRIEF that is schema-conformant v0.6."""

    def test_single_issue_output_is_v06_with_canonical_reference(
        self, tmp_path
    ):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        issue = _issue_payload(639, "Canonical v0.6 refs", labels=["bug"])

        result, path, _msg = issue_ingest.ingest_one(
            issue,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert result == "created"
        assert path is not None
        data = json.loads(path.read_text(encoding="utf-8"))

        # #639 acceptance: envelope is v0.6; reference is canonical.
        _assert_schema_conformant(data, path.name)
        refs = data["plan"]["references"]
        assert len(refs) == 1
        ref = refs[0]
        assert ref["uri"] == "https://github.com/owner/repo/issues/639"
        assert ref["type"] == "x-vbrief/github-issue"
        assert ref["title"] == "Issue #639: Canonical v0.6 refs"

    def test_single_issue_output_contains_no_legacy_reference_type(
        self, tmp_path
    ):
        """Evidence metric: freshly-written vBRIEF bytes contain NO legacy shape."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        issue = _issue_payload(42, "Fix login bug")

        result, path, _ = issue_ingest.ingest_one(
            issue,
            vbrief_dir=vbrief_dir,
            status="active",
            repo_url="https://github.com/owner/repo",
        )
        assert result == "created"
        blob = path.read_text(encoding="utf-8")

        # No bare ``"type": "github-issue"`` string anywhere on disk.
        assert not LEGACY_ORIGIN_TYPE_RE.search(blob), (
            f"legacy reference type leaked into {path.name}: {blob}"
        )
        # Legacy bare ``id`` field must not appear either.
        assert '"id": "#42"' not in blob
        # Nor the legacy bare ``url`` key inside the references array.
        data = json.loads(blob)
        for ref in data["plan"].get("references", []):
            assert "url" not in ref
            assert "id" not in ref

    def test_single_issue_reference_validates_against_schema(self, tmp_path):
        """Every emitted reference must pass the VBriefReference rules."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result, path, _ = issue_ingest.ingest_one(
            _issue_payload(100, "Schema check"),
            vbrief_dir=vbrief_dir,
            status="pending",
            repo_url="https://github.com/owner/repo",
        )
        assert result == "created"
        data = json.loads(path.read_text(encoding="utf-8"))
        refs = data["plan"].get("references", [])
        assert refs, "single-issue ingest must emit an origin reference"
        for ref in refs:
            _validate_reference(ref)


# ---------------------------------------------------------------------------
# Batch ingest (ingest_bulk)
# ---------------------------------------------------------------------------


class TestBatchIngestCanonicalShape:
    """``ingest_bulk`` writes schema-conformant output for every created scope."""

    def test_every_batch_scope_is_v06_with_canonical_reference(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        issues = [
            _issue_payload(201, "Alpha"),
            _issue_payload(202, "Beta", labels=["enhancement"]),
            _issue_payload(203, "Gamma"),
        ]
        summary = issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert summary["total"] == 3
        assert len(summary["created"]) == 3

        emitted_numbers: set[int] = set()
        for f in sorted(vbrief_dir.rglob("*.vbrief.json")):
            data = json.loads(f.read_text(encoding="utf-8"))
            _assert_schema_conformant(data, f.name)
            refs = data["plan"].get("references", [])
            assert len(refs) == 1, (
                f"{f.name}: batch scope must carry exactly one ref; got {refs}"
            )
            ref = refs[0]
            assert ref["type"] == "x-vbrief/github-issue"
            number = int(ref["uri"].rsplit("/", 1)[-1])
            emitted_numbers.add(number)
            assert ref["title"].startswith(f"Issue #{number}:")

        assert emitted_numbers == {201, 202, 203}

    def test_batch_output_contains_no_legacy_fields(self, tmp_path):
        """Bulk-emitted bytes must not mention the legacy reference shape."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        issues = [
            _issue_payload(301, "One"),
            _issue_payload(302, "Two"),
        ]
        issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        for f in vbrief_dir.rglob("*.vbrief.json"):
            blob = f.read_text(encoding="utf-8")
            assert not LEGACY_ORIGIN_TYPE_RE.search(blob), (
                f"legacy reference type leaked into {f.name}"
            )
            for legacy_id in ('"id": "#301"', '"id": "#302"'):
                assert legacy_id not in blob, (
                    f"legacy bare id leaked into {f.name}"
                )

    def test_batch_preserves_dedup_with_legacy_fixture(self, tmp_path):
        """Dedup must still catch a pre-existing legacy-shape vBRIEF.

        Downstream readers (``reconcile_issues.scan_vbrief_dir``) already
        accept both the legacy bare ``github-issue`` and the canonical
        ``x-vbrief/github-issue`` types. This guard proves that the
        canonical-shape emitter does not regress dedup for projects that
        still carry unmigrated legacy vBRIEFs on disk.
        """
        vbrief_dir = tmp_path / "vbrief"
        (vbrief_dir / "pending").mkdir(parents=True)
        # Pre-seed issue #401 in legacy shape (simulates a partially-migrated
        # tree).
        (vbrief_dir / "pending" / "2026-04-01-401-legacy.vbrief.json").write_text(
            json.dumps({
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Legacy",
                    "status": "pending",
                    "items": [],
                    "references": [{
                        "type": "github-issue",
                        "id": "#401",
                        "url": "https://github.com/owner/repo/issues/401",
                    }],
                },
            }),
            encoding="utf-8",
        )

        issues = [
            _issue_payload(401, "Dup of legacy"),
            _issue_payload(402, "New"),
        ]
        summary = issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/owner/repo",
        )
        assert summary["total"] == 2
        assert len(summary["created"]) == 1  # only #402 is created
        assert len(summary["duplicate"]) == 1  # #401 deduped against legacy

        # The freshly-created file is schema-conformant.
        created_files = list((vbrief_dir / "proposed").glob("*.vbrief.json"))
        assert len(created_files) == 1
        data = json.loads(created_files[0].read_text(encoding="utf-8"))
        _assert_schema_conformant(data, created_files[0].name)
        ref = data["plan"]["references"][0]
        assert ref["type"] == "x-vbrief/github-issue"
        assert ref["uri"] == "https://github.com/owner/repo/issues/402"
