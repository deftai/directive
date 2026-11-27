section: Fixed
- fix(install): `directive install` and `upgrade` now deposit the agy hooks (the `zzzz-directive` entry in `.agents/hooks.json` plus its outer) and Claude's `SessionEnd` hook; ownership, uninstall, doctor and the launcher cover agy, and `.agents/hooks.json` stays entry-owned, so foreign hooks and skills are kept (#7438).
