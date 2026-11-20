section: Fixed
- `pre-pr:run --complete` now runs `verify:ac` itself and refuses when it fails, so a pre-PR pass can no longer outlive a failed acceptance check: a failed retry also revokes an earlier pass for the same HEAD. Operator acceptance-disposition grants still apply and `--verify-ac-disposition` is optional (#6888).
