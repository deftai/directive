# Rapid Strategy

Quick prototyping workflow -- SPECIFICATION-only output with minimal gates and fast iteration.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/yolo.md](./yolo.md) | [strategies/README.md](./README.md)

> Ship a throwaway prototype fast. Skip the PRD, skip approval gates, produce a
> SPECIFICATION.md and start building. Suited for spikes, proof-of-concepts, and
> disposable experiments where learning speed matters more than long-term quality.

---

## When to Use

- ~ Throwaway prototypes, spikes, and proof-of-concept experiments
- ~ Validating a technical approach before committing to a full spec cycle
- ~ Solo explorations where the cost of rework is low
- ? Time-boxed experiments (e.g. "spend 2 hours proving this works")
- ⊗ Production features, shared libraries, or anything with downstream consumers

---

## Workflow

### Step 1: State the Goal

! Describe the prototype goal in one sentence: what are you trying to learn or prove?

- ! Record the goal at the top of the SPECIFICATION.md
- ~ Include a time-box if applicable (e.g. "4-hour spike")
- ⊗ Skip this step -- even throwaway work needs a clear objective

### Step 2: Minimal Interview

! Ask only the questions needed to unblock implementation. Skip sizing gate, skip PRD.

- ! Identify: target platform, primary language, key dependency or API
- ~ 3-5 questions maximum -- bias toward defaults and moving fast
- ⊗ Run the full interview questionnaire -- that defeats the purpose of rapid

### Step 3: Generate SPECIFICATION.md (Forced-Light Path)

! Produce a SPECIFICATION.md directly -- no PRD, no approval gate.

- ! Use the Light path from [interview.md](./interview.md) unconditionally
- ! Mark the spec status as `draft` (not `approved`) to signal prototype quality
- ~ Keep tasks coarse-grained -- 3-5 tasks is typical for a spike
- ⊗ Generate a PRD or require approval -- rapid skips both

### Step 4: Build

! Implement against the spec. Quality gates are relaxed but not absent.

- ! Tests are still required, but coverage gate is relaxed to ≥50%
- ~ Favour working code over clean code -- refactor later if the prototype graduates
- ! `task check` must still pass (lint + fmt + tests)
- ⊗ Skip `task check` entirely -- even prototypes must compile and pass basic checks

### Step 5: Evaluate

! At the end of the time-box (or when the prototype is done), decide next steps.

- ! Record findings: what worked, what didn't, what surprised you
- ~ Options: discard, iterate, or graduate to a full spec cycle via [interview.md](./interview.md)
- ! If graduating: start a fresh interview -- do not carry forward the rapid spec as-is

---

## Output Artifacts

- `SPECIFICATION.md` -- lightweight spec with `draft` status
- Prototype code (may be discarded)
- Findings summary (inline in spec or as a separate note)

---

## Fits into Chaining Gate

Rapid is a **spec-generating** strategy. Selecting it at the chaining gate produces a SPECIFICATION.md and moves directly to implementation. There is no chaining back to preparatory strategies.

---

## Anti-Patterns

- ⊗ Using rapid for production features -- rapid output is explicitly throwaway
- ⊗ Graduating a rapid prototype without a fresh spec cycle -- the shortcuts compound
- ⊗ Running the full interview or PRD path -- that's interview strategy, not rapid
- ⊗ Skipping `task check` -- even prototypes must pass basic quality checks
- ⊗ Omitting the goal statement -- undirected spikes waste time
