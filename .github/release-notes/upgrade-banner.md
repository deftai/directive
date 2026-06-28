## Upgrading from an older version?

If you are on an existing Deft installation and seeing warnings from `deft doctor` about skill-path stubs, outdated surfaces, or payload staleness, run the canonical npm upgrade path:

```bash
npm i -g @deftai/directive@latest
```

Then from your project root: `deft update`, `deft migrate` (one-time, idempotent), and `deft doctor`.

After upgrading, start a completely new agent session.

Full guidance: https://github.com/deftai/directive/blob/master/content/UPGRADING.md
