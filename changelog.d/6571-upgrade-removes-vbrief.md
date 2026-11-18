section: Fixed
- `directive upgrade` now finishes moving leftover `vbrief/` files into `xbrief/` and removes `vbrief/`, so the upgrade commit passes the pre-commit drift check. Existing `xbrief/` files are never overwritten (#6571).
