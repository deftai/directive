"""_content_root.py -- resolve the shippable-content root across both contexts (#1875).

The #1875 "content/ move" relocated every shippable framework asset under a
single ``content/`` root in the SOURCE repository. The C1 flatten deposit
(``build_dist.py``) strips that prefix when packaging, so a CONSUMER install
sees the same ``.deft/core/<x>`` layout it always has -- there is no
``content/`` directory in a deposited framework.

Engine scripts that read shippable content by repo-root path therefore live in
two worlds:

* SOURCE checkout: content lives at ``<framework-root>/content/<x>``.
* CONSUMER deposit: content lives at ``<framework-root>/<x>`` (flattened).

``content_root(framework_root)`` resolves the difference by probing for the
``content/`` directory: it returns ``<framework-root>/content`` when that
directory exists (source) and ``<framework-root>`` otherwise (consumer). Build
paths off the returned root so the same script resolves correctly in both
contexts without a code change.

Refs #1875 (content/ move), #1669 (Wave-1 LockedDecisions C1 flatten).
"""

from __future__ import annotations

from pathlib import Path

CONTENT_DIRNAME = "content"


def content_root(framework_root: Path | str) -> Path:
    """Return the directory that holds flattened shippable content.

    ``framework_root`` is the directory that owns ``scripts/`` (i.e. two
    parents up from a ``scripts/<x>.py`` module). In a source checkout the
    shippable content lives under ``<framework_root>/content``; in a consumer
    deposit the C1 flatten removed the prefix, so it lives directly under
    ``<framework_root>``.
    """
    root = Path(framework_root)
    candidate = root / CONTENT_DIRNAME
    return candidate if candidate.is_dir() else root
