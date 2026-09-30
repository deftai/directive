# First-ship AGENTS header placeholder gate fixture (#4544)

Prefer-A check surface: product-mutation completion must fail closed while
`AGENTS.md` still equals `CONSUMER_HEADER_PLACEHOLDER_ONELINER`.

- `AGENTS.placeholder.md` + product mutation → refuse
- `AGENTS.custom.md` + product mutation → pass (leave-custom)
- placeholder + no product mutation → pass (Process-only)
