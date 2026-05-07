# Versioning
Canonical reference for the version sources Deft uses across runtime, release tooling, and Python packaging surfaces. Established in #771 to close the gap between the release-tag truth and the (previously stale) ``pyproject.toml`` ``[project].version``.
**See also**: [scm/changelog.md](../scm/changelog.md), [scm/github.md](../scm/github.md), [skills/deft-directive-release/SKILL.md](../skills/deft-directive-release/SKILL.md).
## TL;DR
- The annotated git tag (``vX.Y.Z``) is the **single source of truth** for what version Deft is at.
- Three surfaces read from that one source via deterministic helpers; none of them edit the value by hand.
- Disposable tags (``v0.0.0-test.N``) are explicitly classified non-publishable and never propagate to PyPI / package metadata.
## Three canonical surfaces
Deft has three places where a version string is observed:
### 1. CLI / runtime version
- **Read by**: ``run``, ``run --version``, ``deft --help``, anything reporting "what version is the user running?"
- **Source of truth**: ``scripts/resolve_version.resolve_version()`` (Python) and the inline POSIX ``sh:`` block in ``Taskfile.yml`` ``vars: VERSION`` (go-task) — kept in lockstep by convention.
- **Resolution priority** (first match wins; documented in ``scripts/resolve_version.py``):
  1. ``$DEFT_RELEASE_VERSION`` env override (set by ``scripts/release.py::run_build`` so the in-flight version pins the build).
  2. ``git describe --tags --abbrev=0`` (latest annotated tag, leading ``v`` stripped).
  3. ``0.0.0-dev`` literal fallback (fresh checkout / no tags / git unavailable).
- **Format**: bare semver-shaped ``X.Y.Z`` (or pre-release form ``X.Y.Z-rc.N`` etc.). NOT PEP 440 — the CLI is not a Python distribution.
- **Authoritative for**: human-readable runtime reporting, build artifact filenames (``dist/deft-X.Y.Z.zip``).
### 2. Release-tag version
- **Read by**: ``scripts/release.py``, ``task release -- X.Y.Z``, ``gh release create``, the GitHub release page.
- **Source of truth**: the operator-supplied positional argument to ``task release -- X.Y.Z`` validated against ``scripts/release._VERSION_RE`` (strict ``X.Y.Z`` -- no leading ``v``, no pre-release suffix on the public path).
- **Format**: strict ``X.Y.Z`` for production releases. The annotated git tag is created as ``vX.Y.Z``.
- **Pre-release path**: pre-release tags (``vX.Y.Z-rc.N`` / ``-beta.N`` / ``-alpha.N``) are accepted at the resolver level and supported through to the PEP 440 helper, but the production ``task release`` path validates strict ``X.Y.Z``. Pre-release flows are programmatic (e.g. an upcoming ``task release:rc -- X.Y.Z-rc.N`` pathway).
- **Authoritative for**: GitHub release record, downloads, CHANGELOG ``## [X.Y.Z]`` heading, ROADMAP "## Completed" section.
### 3. Python-package version (PEP 440)
- **Read by**: ``pyproject.toml`` ``[project].version`` and any future PyPI metadata produced from it (per #11).
- **Source of truth**: derived from the release-tag version via ``scripts/resolve_version.to_pep440()`` -- the **single canonical normalization helper** for the whole codebase. Synced by ``scripts/release.py`` Step 5 on every ``task release`` cut and guarded by ``tests/content/test_pyproject_version_freshness.py``.
- **Format**: PEP 440 (``X.Y.Z`` or ``X.Y.Z{a,b,rc}N``). Examples:
  - ``v0.22.0`` -> ``0.22.0``
  - ``v0.20.0-rc.3`` -> ``0.20.0rc3``
  - ``v0.20.0-beta.2`` -> ``0.20.0b2``
  - ``v0.20.0-alpha.1`` -> ``0.20.0a1``
  - ``v0.0.0-test.1`` -> raises ``NonPublishableVersionError`` (sync skipped)
- **Authoritative for**: pip / PyPI / Python-package metadata.
## Authority matrix
- CLI / runtime version: authoritative source is the latest annotated git tag (resolved at runtime via ``resolve_version``).
- Release-tag version: authoritative source is the operator's ``task release -- X.Y.Z`` invocation; the resulting tag is the durable record.
- Python-package version: authoritative source is the latest annotated git tag, normalized through ``to_pep440``. The committed ``pyproject.toml`` ``[project].version`` is a **derived artifact**, not an authoritative source. Manual edits drift from the truth and are caught by the freshness test.
**Direction of derivation**: tag -> pyproject (one-way). The pipeline never reads pyproject as a source of truth for the in-flight cut version.
## Why three surfaces?
Each surface answers a different question:
- *"What is the user running right now?"* -- CLI version (resolved at runtime; can be a dev fallback).
- *"What did we publish?"* -- release-tag version (durable git tag + GitHub release).
- *"What does ``pip install deft-directive`` mean?"* -- PEP 440 version (normalized for Python packaging).
Conflating them creates the v0.21.0-era drift bug where ``pyproject.toml`` reported ``0.5.0`` long after ``v0.22.0`` had shipped (#771 root cause).
## Non-publishable tags
``test.N`` pre-release tags (and any other classification added to ``_NON_PUBLISHABLE_KINDS`` in ``scripts/resolve_version.py``) are explicitly **not eligible** for PyPI publication:
- ``to_pep440`` raises ``NonPublishableVersionError``;
- ``is_publishable`` returns False;
- ``scripts/release.py`` Step 5 catches ``NonPublishableVersionError`` and skips the pyproject sync (operator-readable: ``"non-publishable tag (...); skipping pyproject sync"``);
- the freshness test (``test_pyproject_version_freshness``) skips the assertion when the latest tag is non-publishable -- pyproject is intentionally allowed to lag behind disposable tags.
The intended use is the ``task release:e2e`` rehearsal harness, which creates throwaway tags like ``v0.0.0-test.<timestamp>`` against an auto-deleted temp repository (#716). Without the non-publishable classification these tags would propagate into pyproject and pollute Python-packaging metadata on the rare occasion that the rehearsal pollutes the working tree.
## Phase C extension hook (#11 future packaging)
The vBRIEF for #771 explicitly leaves a hook: any future pip-packaging path (root-repo distribution, dedicated wrapper package per #11, or alternate channel) MUST consume ``scripts.resolve_version.to_pep440`` rather than reimplementing the rule. This guarantees exactly **one** normalization rule across release-tag / CLI / PyPI surfaces.
The contract is documented in:
- ``scripts/resolve_version.py`` module docstring (Phase C section);
- the ``TestPep440PhaseCExtensionHook`` regression test in ``tests/cli/test_resolve_version.py``.
If you are adding a packaging surface and find yourself writing a regex to map ``rc.N`` -> ``rcN``, stop and call ``to_pep440`` instead.
## Quick reference: when to edit what
- Cutting a normal release: ``task release -- X.Y.Z`` does everything (tag, CHANGELOG promote, pyproject sync, GitHub release). No manual ``pyproject.toml`` edit.
- Bumping ``pyproject.toml`` outside a release: don't. The freshness test will fail. If you need to override (e.g. recovering from a broken state), apply ``to_pep440`` of the latest tag and let the next release re-sync.
- Adding a new pre-release token (e.g. ``-dev.N``): extend ``_PEP440_TAG_RE`` and ``_PRE_KIND_MAP`` in ``scripts/resolve_version.py`` AND add the canonical mapping case to ``TestPep440PhaseCExtensionHook``.
- Cutting a disposable rehearsal tag (``v0.0.0-test.N``): no action. The pipeline classifies it non-publishable; pyproject is unchanged; the freshness test skips.
