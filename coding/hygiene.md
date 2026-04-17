# Codebase Hygiene

Rules for ongoing codebase health — keeping existing code clean, not just writing new code well.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**:
- [coding.md](coding.md) — Code design principles
- [verification/verification.md](../verification/verification.md) — Stub and legacy detection
- [coding/testing.md](testing.md) — Test coverage requirements

---

## Dead Code Removal

Dead code accumulates silently and degrades readability and maintainability.

- ! Before marking any refactor or cleanup task done, verify no unreferenced code was left behind
- ⊗ Commented-out code blocks committed to version control — delete, don't comment out
- ⊗ Functions, classes, or variables that are defined but never called/imported anywhere
- ⊗ Unused imports, dependencies, or exports
- ~ Use language-specific dead code tools as part of periodic hygiene passes:
  - Python: `vulture` — detects unused functions, classes, variables
  - Go: `deadcode` (golang.org/x/tools/cmd/deadcode) or `staticcheck` unused analysis
  - TypeScript/JS: `knip` — detects unused exports, files, and dependencies
- ~ Run dead code tools before major releases or after significant refactors
- ? Add dead code tool as a Taskfile target (e.g. `task hygiene`) for periodic use

---

## Circular Dependencies

Circular imports create tight coupling, prevent modular testing, and indicate architectural problems.

- ⊗ Circular imports between modules/packages — detect and eliminate
- ! When circular dependency exists, resolve by extracting shared types/interfaces to a lower-level module, not by restructuring import order
- ~ Enforce layered architecture: high-level modules depend on low-level ones, never the reverse
- ! Use dependency inversion (interfaces/protocols) to break necessary coupling across layers
- ~ Use language-specific tools to detect cycles:
  - Python: `pydeps` or `importlab` for full cycle detection
  - Go: the compiler rejects import cycles — trust the error; fix by extracting shared packages
  - TypeScript/JS: `madge` — visualises and detects circular dependencies
- ~ For large codebases, add `madge --circular` (or equivalent) as a CI check

---

## Error Handling: No Hiding

Try/catch and equivalent constructs serve a legitimate purpose at **API/input boundaries** — sanitizing unknown or untrusted input. Everywhere else, they should propagate errors explicitly.

**Legitimate uses:**
- Parsing external input (JSON, user input, file content)
- Third-party SDK calls that may throw undocumented errors
- Top-level process handlers (recover from unexpected crashes with logging)

**Illegitimate uses (remove these):**

- ⊗ Empty catch/except/recover blocks that swallow errors silently
- ⊗ `except Exception: pass` or equivalent — log at minimum, re-raise if appropriate
- ⊗ Returning neutral/zero values (None, {}, [], 0, false, "") to mask an error — propagate explicitly
- ⊗ Log-and-continue: catching an error, logging it, and proceeding as if nothing happened — unless the error is provably non-fatal AND that decision is documented in a comment
- ⊗ Fallback patterns that hide failures from callers (e.g. "if this fails, return cached/stale data" without surfacing the error)
- ! When removing a try/catch, confirm the error propagates to a caller that can handle it — do not simply delete

---

## Legacy and Deprecated Code

Legacy accumulation makes codebases fragile and hard to reason about. Code should have one active path, not a graveyard of old approaches alongside new ones.

- ⊗ Parallel implementations: old approach and new approach coexisting without a migration path
- ⊗ Feature flags or toggle branches where the flag is always-on or always-off — collapse to the live path
- ⊗ Compatibility shims maintained beyond their stated removal date
- ! When replacing an implementation: delete the old one in the same commit, not "after testing"
- ~ Scan for these markers as legacy indicators:
  - Comments: `# deprecated`, `// TODO: remove`, `LEGACY`, `COMPAT`, `OLD_`, `# old way`
  - Python decorators: `@deprecated`
  - Go: `// Deprecated:` godoc marker (legitimate when part of a public API — remove the symbol if internal)
- ~ When encountering legacy code during unrelated work, file a hygiene task rather than ignoring it
- ⊗ Comments describing in-flight replacement work ("this used to be X, now it's Y") — remove once the migration is complete; they are noise for future readers

---

## DRY: Don't Repeat Yourself

Duplication is the root cause of inconsistent behaviour and maintenance burden.

- ~ Extract shared abstractions when logic is duplicated across 2+ call sites
- ⊗ Copy-paste logic with minor variations — parameterise instead
- ! When deduplicating, verify the abstraction is actually shared behaviour, not coincidental similarity
- ≉ Premature abstraction — only extract when the duplication is real and the shared contract is clear

---

## Comments: Signal vs. Noise

Comments should explain **why**, not **what**. Remove noise; keep signal.

- ⊗ Comments describing what the code does (the code itself shows this)
- ⊗ In-motion commentary: "replaced X with Y", "temporarily disabled", "new approach below"
- ⊗ Commented-out code — delete it; version control preserves history
- ⊗ Section dividers and banners that add no information (e.g. `# --- helpers ---`)
- ! When editing a file, remove stale comments as you go — do not leave them for later
- ~ When a comment is needed, be concise: one line explaining the non-obvious reason, not a paragraph
