## Upgrading from an older version?

If you are on an existing Deft / Directive installation and seeing doctor warnings about skill-path stubs, outdated wiring, or schema drift, use the OVPR npm path:

```bash
npm i -g @deftai/directive@latest
```

Then from your project root:

- Ordinary upgrade (move pin / migrate data): `directive upgrade` (`update` is an alias)
- Wiring broken; keep the pin: `directive install --repair`
- Not sure: `directive doctor` (read-only)

Supported latest-legacy layouts (exact pre-split `@deftai/directive` pin + copied `.deft/core`) convert with `directive upgrade`. The Go installer (`deft-install`) is deleted — do not download or run it.

After upgrading, start a completely new agent session.

Full guidance: https://github.com/deftai/directive/blob/master/content/UPGRADING.md
