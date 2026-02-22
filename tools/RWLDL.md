# Ralph Wiggum's Loop-de-Loop (RWLDL)

Iterative code refinement by alternating micro (detailed) and macro (high-level) improvements.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [taskfile.md](./taskfile.md) | [../coding/coding.md](../coding/coding.md) | [../coding/testing.md](../coding/testing.md)

## Overview

- ! Perform up to **N** full Loop-de-Loops (LDLs); N is configurable (default: 5)
- ! Stop early if no meaningful improvements (>5% impact on perf, coverage, or complexity) are found in two consecutive evaluation steps (1 or 3)
- ! Stop early if all verification criteria are met
- ! Track state in `ldl-progress.md`

## Loop-de-Loop Steps

### Step 1 — Micro Review (Close-Up Scrutiny)

- ! Read current state: `ldl-progress.md`, recent git commits, test results, logs
- ! Examine code granularly for:
  - Comments and readability
  - Code quality (naming, style)
  - DRY violations
  - Micro-performance (e.g., loop optimizations)
  - Testing gaps
- ~ Quantify with tools (lint scores, complexity metrics)
- ! List 2–5 prioritized fixes, each atomic (<100 LOC change)
- ? If none found, note and proceed to Step 5 (verification)

### Step 2 — Micro Implement & Test

- ! For each fix from Step 1, implement in small steps
- ! Self-critique: list 3 downsides; mitigate top 2
- ! Run before committing:
  - Unit and integration tests
  - Fuzzing / property-based tests
  - Lint and type checks
  - Performance profiles
- ! Fix all failures before committing
- ! Git commit with descriptive message
- ! Update `ldl-progress.md` with summary, metrics deltas, and completed checkboxes

### Step 3 — Macro Review (5,000-Foot View)

- ! Reset perspective — ignore micro details
- ! Evaluate holistically for:
  - Speed and scalability (Big O, parallelism)
  - Modularity (SOLID, separation of concerns)
  - Broader DRY and reliability (error handling, redundancy)
  - Security and performance at scale
- ~ Check externalities: dependencies, docs, APIs
- ! List 1–3 high-impact changes; quantify potential gains
- ? If none found, note and proceed to Step 5 (verification)

### Step 4 — Macro Implement & Test

- ! Same process as Step 2, but for Step 3 changes
- ! Additionally include:
  - Security scans (e.g., SAST)
  - End-to-end tests
- ! Commit and update `ldl-progress.md`

### Step 5 — Loop or Verify

- If improvements were made → return to Step 1 for next LDL
- Otherwise, verify:
  - ! All tests pass (coverage ≥95%)
  - ! No lint or security issues
  - ! Benchmarks stable
  - ! README and docs current
- If verified → output **COMPLETE**
- Else → **CONTINUE** to next LDL

## Progress Tracking

- ! After each LDL, append to `ldl-progress.md`:
  - LDL count
  - Key metrics (coverage, complexity, perf)
  - Rationale for continuing or stopping
