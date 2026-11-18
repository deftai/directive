section: Fixed
- `directive upgrade` now finishes moving leftover `vbrief/` files into `xbrief/` and removes `vbrief/`, so the upgrade commit passes the pre-commit drift check. Existing `xbrief/` files are never overwritten, and images, PDFs and other binary files are copied unchanged (#6571).
