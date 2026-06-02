## Upgrading from an older version?

If you are on an existing Deft installation and seeing warnings from `task doctor` about skill-path stubs, outdated surfaces, or payload staleness, run the canonical upgrade command:

```bash
deft-install --yes --upgrade --repo-root . --json
```

(Drop `--json` for human-readable output. Download the latest installer from the [latest release](https://github.com/deftai/directive/releases/latest) if needed.)

After upgrading, start a completely new agent session.

Full guidance: https://github.com/deftai/directive/issues/1411
