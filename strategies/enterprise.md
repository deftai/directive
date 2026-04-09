# Enterprise Strategy

Compliance-heavy workflow -- PRD → ADR → SPECIFICATION with explicit approval gates at each stage.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/speckit.md](./speckit.md) | [strategies/README.md](./README.md)

> When every decision must be auditable and every artifact must survive a compliance
> review, enterprise strategy adds explicit approval gates between stages. Suited for
> regulated industries, high-accountability environments, and projects where the cost
> of rework far exceeds the cost of upfront process.

---

## When to Use

- ~ Regulated or compliance-heavy environments (SOC 2, HIPAA, ISO 27001, FedRAMP)
- ~ Projects requiring formal Architecture Decision Records (ADRs)
- ~ Multi-team efforts where approval chains cross organisational boundaries
- ~ Environments where audit trail and traceability are non-negotiable
- ? Large internal projects with formal change advisory boards
- ⊗ Solo prototyping, spikes, or throwaway experiments -- use [rapid.md](./rapid.md) instead

---

## Workflow

### Stage 1: PRD (Forced-Full Path)

! Run the Full interview path from [interview.md](./interview.md) unconditionally -- produce a PRD.

- ! Use the Full path regardless of project size -- enterprise always requires a PRD
- ! PRD must include: problem statement, goals, non-goals, user stories, functional requirements, non-functional requirements, success metrics
- ! Record the PRD approver(s) in the document header

### Gate 1: PRD Approval

! The PRD requires explicit written approval before proceeding.

- ! Approval must come from the designated approver(s) -- not the author
- ! Record approval: approver name, date, and any conditions
- ⊗ Proceed to Stage 2 without documented PRD approval
- ~ If approval is conditional, resolve conditions and re-approve before proceeding

### Stage 2: Architecture Decision Records (ADRs)

! For each significant technical decision in the PRD, create an ADR.

- ! ADR format: Title, Status, Context, Decision, Consequences (see [languages/markdown.md](../languages/markdown.md) ADR section)
- ! Store ADRs in `docs/adr/` or `docs/decisions/`
- ! Each ADR traces back to the PRD requirement(s) it addresses
- ~ Minimum ADRs: data storage, authentication, API contracts, deployment model
- ⊗ Skip ADRs for decisions with compliance, security, or data-residency implications

### Gate 2: ADR Approval

! ADRs require review and approval before specification begins.

- ! Technical lead or architect must approve each ADR
- ! Record approval alongside the ADR (status field: Proposed → Accepted)
- ⊗ Begin specification with Proposed ADRs -- all must be Accepted

### Stage 3: Generate SPECIFICATION.md

! Derive SPECIFICATION.md from the approved PRD and accepted ADRs.

- ! Every spec task must trace to a PRD requirement and, where applicable, an ADR
- ! Use the Light or Full path from [interview.md](./interview.md) for SPECIFICATION generation
- ! Include traceability matrix: spec task → PRD requirement → ADR (where applicable)

### Gate 3: Specification Approval

! The SPECIFICATION.md requires explicit approval before implementation begins.

- ! Approval scope: completeness (all PRD requirements covered), feasibility, traceability
- ! Record approval in the spec header or via a signed-off PR review
- ⊗ Begin implementation without documented spec approval

### Stage 4: Build

! Implement against the approved specification. All standard quality gates apply.

- ! Full quality gates: `task check`, ≥85% coverage, conventional commits
- ! Each PR must reference the spec task(s) it implements
- ! Use `/deft:change` for all changes (mandatory in enterprise -- not optional like in other strategies)

---

## Output Artifacts

- `PRD.md` -- approved product requirements document
- `docs/adr/adr-NNN-*.md` -- accepted Architecture Decision Records
- `SPECIFICATION.md` -- approved specification with traceability matrix
- Traceability matrix (inline in spec or as a separate `docs/traceability.md`)

---

## Fits into Chaining Gate

Enterprise is a **spec-generating** strategy. It uses the Forced-Full path and adds ADR and approval gates before specification. Preparatory strategies (research, discuss, map, bdd) can run before enterprise begins.

---

## Anti-Patterns

- ⊗ Skipping any approval gate -- every gate is mandatory in enterprise strategy
- ⊗ Starting implementation before all three approval gates are passed
- ⊗ Using enterprise for throwaway prototypes -- the overhead is not justified
- ⊗ Omitting ADRs for compliance-relevant decisions
- ⊗ Proceeding with Proposed (unapproved) ADRs
- ⊗ Losing traceability between PRD → ADR → spec → implementation
