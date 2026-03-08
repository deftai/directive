# Integration Checking

Verify that features work together as a system, not just individually.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [verification/verification.md](./verification.md) | [contracts/boundary-maps.md](../contracts/boundary-maps.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) integration-checker model.

---

## Core Principle

Individual features can pass verification while the system is broken. A component can exist without being imported. An API can exist without being called. **Existence ≠ integration.**

---

## When to Check

- ! After completing 2+ features that should connect
- ! Before marking a release as done
- ~ After any feature that produces exports consumed by other features
- ? After single isolated features with no upstream/downstream

## 4 Integration Checks

### 1. Export → Import

- ! For each feature's declared **produces** (from boundary maps), verify downstream features import them
- ! Imports must be **used**, not just declared — an unused import is not integration
- ~ Use `rg` or `ast-grep` to verify import + usage

```bash
# Check if feature 1's export is used by feature 2
rg "import.*generateToken" src/ --type ts
rg "generateToken" src/ --type ts | rg -v "import|export"
```

### 2. API → Consumer

- ! Every API route has at least one consumer (UI component, CLI command, test, or external client)
- ! Verify the consumer actually calls the route (fetch, axios, curl — not just a comment)
- ⊗ Orphaned API routes — routes that exist but nothing calls them

### 3. Auth Protection

- ! Pages/routes requiring auth actually check auth (middleware, hooks, guards)
- ! Protected API endpoints verify tokens/sessions before processing
- ~ Check for redirect-on-no-auth behavior in protected UI routes

### 4. E2E Flow Tracing

- ~ For each user-observable flow (from demo sentences), trace the full path:
  - UI action → API call → data operation → response → UI update
- ! Each link in the chain must be real code, not a stub
- ! Use verification ladder Tier 3 (behavioral) when possible

---

## Integration Report

Record per-release in vBRIEF or `docs/integration/`:

- **Connected**: export + consumer confirmed
- **Orphaned**: export exists, no consumer found
- **Broken**: consumer references export that doesn't exist

---

## Anti-Patterns

- ⊗ Declaring integration complete because all features individually pass
- ⊗ Skipping integration checks on "simple" multi-feature releases
- ⊗ Orphaned routes/components left in codebase after feature changes
- ⊗ Trusting boundary maps without verifying actual code
