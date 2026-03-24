# Deft Directive — Phases 1–3 SPECIFICATION

Deft Directive is a Markdown framework for AI agents to use when generating software. It defines layered behavioral rules, workflow strategies, and quality gates across four components: (1) the Markdown framework (primary product — .md files consumed by agents at runtime), (2) the Python CLI (`run` — terminal setup and spec generation), (3) the Go installer (`cmd/deft-install/` — standalone binary for end-user install), and (4) the test suite (`tests/` — CLI and content validation). This specification covers Phase 1 (bug fixes and adoption blockers), Phase 2 (content fixes), and Phase 3 (CI). Phases 4–5 are deferred; see PRD.md and #67 for scope boundaries. References: PRD.md, .planning/codebase/ARCHITECTURE.md, docs/research/deft-directive-research.md.

## t1.1.1: Add inference boundary guards to deft-setup SKILL.md Phase 2 (FR-1, FR-2)  `[pending]`

Add ⊗ rules to the Inference section of Phase 2 in skills/deft-setup/SKILL.md: never scan ./deft/ for build files; never run git commands inside ./deft/. Only inspect project root and non-deft subdirectories. Closes #79.

- SKILL.md Phase 2 Inference section contains ⊗ rule: MUST NOT scan ./deft/ for go.mod, package.json, pyproject.toml, Cargo.toml, *.csproj
- SKILL.md Phase 2 Inference section contains ⊗ rule: MUST NOT run git commands inside ./deft/
- tests/content/test_skills.py passes

## t1.1.2: Add project name fallback prompt when no build files detected (FR-3)  `[pending]`

**Depends on**: t1.1.1

Update deft-setup SKILL.md Phase 2 to prompt the user for a project name when codebase inference finds no build files at the project root. Currently falls through to deft internals. Closes #80.

- Phase 2 Question Sequence includes explicit fallback: if no build files found at project root, ask user to provide project name
- Fallback prompt appears in Track 1, Track 2, and Track 3 paths
- tests/cli/test_project.py covers no-build-files scenario

## t1.1.3: Remove Primary Languages from USER.md template and Phase 1 interview (FR-4)  `[pending]`

Language is a project-level concern determined per-project via codebase inference, not a user preference. Remove from USER.md template, Phase 1 Track 1 Step 2, Track 2 Step 2. Update Phase 2 Step 3 to always infer first. Closes #107.

- USER.md template in SKILL.md no longer includes **Primary Languages** field
- Phase 1 Track 1 has no Step 2 asking about languages
- Phase 1 Track 2 has no language step
- Phase 2 Step 3 infers from codebase; falls back to open ask (no USER.md default pre-fill)
- tests/cli/test_bootstrap.py updated; no language question in happy path

## t1.1.4: Add deployment platform question before language in deft-setup Phase 2 (FR-5)  `[pending]`

**Depends on**: t1.1.3

Ask deployment platform (web, mobile, desktop, embedded, CLI, cloud service, other) before asking about language. Platform context narrows language shortlist. Track 1 only. Closes #108.

- Phase 2 Track 1 Question Sequence: deployment platform question precedes language question
- Platform answer informs language shortlist shown in next question
- Track 2 and Track 3 unaffected (simplified paths)

## t1.2.1: Audit and fix vBRIEF generation in cmd_spec (FR-6)  `[pending]`

The run script's cmd_spec generates specification.vbrief.json. Audit the output format against spec_validate.py and vbrief/vbrief.md. Ensure: flat structure with top-level key 'plan' (not 'title') holding the spec name; task status values from valid enum (pending/running/completed/blocked/cancelled); top-level status 'approved' on render. The legacy 'todo'/'doing'/'done' values from old vBRIEF must not be used. Closes #72 (CLI path).

- task spec:validate passes on all cmd_spec output
- task spec:render succeeds on approved spec
- tests/cli/test_spec.py covers vBRIEF output format

## t1.2.2: Audit and fix vBRIEF generation in deft-setup Phase 3 (FR-6)  `[pending]`

**Depends on**: t1.2.1

The deft-setup skill Phase 3 also generates specification.vbrief.json. Same audit as t1.2.1 for the agent-skill path. Update skills/deft-setup/SKILL.md Output sections to reference the correct schema. Closes #72 (agent skill path).

- SKILL.md Phase 3 Output sections reference correct vBRIEF field names (plan not title as top-level key; pending/running/completed/blocked/cancelled for task status, not legacy todo/doing/done)
- tests/content/test_vbrief_schema.py assertions strengthened to catch field name violations

## t1.3.1: Fix run bootstrap infinite loop when strategies/ is empty (FR-7)  `[pending]`

cmd_bootstrap enters an infinite loop when get_available_strategies() returns an empty list or the strategies/ directory is unresolvable. Add a guard: if no strategies found, default to 'interview' and warn rather than looping. Closes #91, #92.

- cmd_bootstrap completes without looping when strategies/ is empty
- Fallback to 'interview' strategy is logged as a warning
- tests/cli/test_bootstrap.py covers empty-strategies-dir scenario

## t1.3.3: Fix cmd_project command-chaining loop after cmd_install (FR-7b)  `[pending]`

cmd_project calls cmd_install(["."]) without return when ./deft/ is missing. After cmd_install chains → cmd_project → cmd_spec and unwinds, the original cmd_project falls through and re-runs the entire questionnaire, overwriting completed work. Fix: return cmd_install(["."]).  Closes #117.

- cmd_project returns cleanly after cmd_install chains through the full workflow
- No duplicate PROJECT.md questionnaire after run spec completes
- tests/cli/test_project.py covers install-chain-through scenario

## t1.3.2: Add version display to all run CLI commands on startup (FR-10)  `[pending]`

All cmd_* functions should print the VERSION on entry (e.g. 'Deft CLI v0.4.2'). Note: VERSION in run is currently 0.4.2; this value is provisional and will display behind the framework's 0.5.2 until version unification is addressed (see PRD Open Question 1). Closes #49.

- All cmd_* functions print version string on startup
- Version string format: 'Deft CLI v{VERSION}'
- tests/cli/test_import_smoke.py or per-command tests assert version output

## t1.4.1: Merge strategies/default.md into strategies/interview.md and remove default.md (FR-8)  `[pending]`

default.md is a duplicate of interview.md. Merge any unique content into interview.md, then delete default.md. Update any references to default.md. Closes #31.

- strategies/default.md no longer exists
- strategies/interview.md contains all content from former default.md (or supersedes it)
- No .md file in the repo references strategies/default.md
- tests/content/test_structure.py updated to not assert default.md exists; test passes

## t1.4.2: Update strategies/brownfield.md to redirect to strategies/map.md (FR-9)  `[pending]`

brownfield.md is a legacy alias for map.md. Replace content with a short redirect note pointing to map.md. Do not delete (backward compatibility for any existing references). Closes #50 (brownfield portion).

- strategies/brownfield.md contains only a redirect to strategies/map.md
- strategies/map.md is the canonical document
- tests/content/test_standards.py passes

## t1.5.1: Write coding/build-output.md — build output validation directive (FR-11)  `[pending]`

New file documenting rules for validating build output (dist/, bin/, artifacts). Agents must: verify expected artifacts exist post-build, check artifact sizes are non-zero, fail loudly on silent build failures. Closes #105.

- coding/build-output.md exists with RFC2119 legend
- Contains ! rules for: verifying artifact existence, checking non-zero size, failing on missing expected outputs
- Referenced from coding/coding.md

## t1.5.2: Document toolchain validation gate in framework (FR-12)  `[pending]`

Create a new coding/toolchain.md requiring agents to verify required tools are installed before beginning implementation. Reference it from coding/coding.md. Closes #106.

- Framework contains ! rule: before implementation begins, verify all required tools are available (e.g. go version, uv --version, task --version)
- Rule lives in a new coding/toolchain.md, referenced (linked) from coding/coding.md

## t2.1.1: Update all stale core/user.md and core/project.md references to canonical paths (FR-13)  `[pending]`

Find all .md references to core/user.md and core/project.md legacy paths. Replace with canonical paths: ~/.config/deft/USER.md (or %APPDATA%\deft\USER.md on Windows) and ./PROJECT.md respectively. Closes #58.

- grep for 'core/user.md' returns zero matches in non-history .md files (except legacy fallback note in SKILL.md)
- grep for 'core/project.md' returns zero matches in non-history .md files (except legacy fallback note in SKILL.md)
- tests/content/test_contracts.py passes

## t2.1.2: Create history/changes/ directory with README.md (FR-14)  `[pending]`

commands.md references history/changes/<name>/ but the directory doesn't exist. Create it with a README.md documenting the change lifecycle artifact structure. Closes #59.

- history/changes/ directory exists
- history/changes/README.md documents: what /deft:change creates, directory structure per change, lifecycle from proposal to archive
- tests/content/test_structure.py passes

## t2.1.3: Refactor strategies/yolo.md to reference interview.md shared phases (FR-15)  `[pending]`

yolo.md duplicates ~80% of interview.md. Replace duplicated sections (sizing gate, chaining gate, acceptance gate, SPECIFICATION structure) with references to interview.md. Keep only yolo-specific content (Johnbot persona, auto-pick rules). Closes #23.

- yolo.md references interview.md for: Sizing Gate, Chaining Gate, Acceptance Gate, SPECIFICATION structure
- yolo.md is ≤60% of its current line count
- Functional behavior unchanged (yolo still selects recommended options)

## t2.1.4: Add See also banner to strategies/speckit.md (FR-16)  `[pending]`

speckit.md is missing the standard **⚠️ See also** cross-reference banner at the top. Add it with links to interview.md and relevant strategy files. Closes #24.

- speckit.md line 3-4 contains **⚠️ See also**: [...] banner
- Banner links to at minimum: interview.md, discuss.md

## t2.1.5: Fix commands.md vBRIEF example vocabulary (FR-17)  `[pending]`

commands.md vBRIEF examples use status vocabulary that diverges from vbrief/vbrief.md. Update to use the canonical status enum. Closes #25.

- commands.md vBRIEF file-level status examples use: draft | proposed | approved
- commands.md vBRIEF task-level status examples use: pending | running | completed | blocked | cancelled
- No use of 'todo', 'doing', 'done' in commands.md examples; no use of 'approved' as a task-level status

## t2.1.6: Clean core/project.md — remove Voxio Bot private content (FR-18)  `[pending]`

core/project.md contains private project config (Voxio Bot). Replace with a generic template showing example project config, or note it as a legacy location with a pointer to PROJECT.md.

- core/project.md contains no reference to 'Voxio' or any private project
- Content is either a generic template or a redirect to ./PROJECT.md
- tests/content/test_standards.py Voxio xfail flips to passing

## t2.2.1: Create contracts/hierarchy.md — dual-hierarchy framework (FR-19)  `[pending]`

Document the two hierarchy lenses from #84/#89 debate: (1) durability axis (Standards > APIs > Specs > Code — what to invest in maintaining); (2) generative axis (Spec → Contracts → Code — what to write first). Explain when each applies. Closes #84 Phase 1 (hierarchy doc portion).

- contracts/hierarchy.md exists with RFC2119 legend
- Both axes documented with examples
- File referenced from main.md or contracts/ README

## t2.2.2: Add adaptive teaching behavior to main.md (FR-20)  `[pending]`

Add to Agent Behavior section of main.md: ~ When a recommendation is accepted without question, be concise. ! When a recommendation is questioned or overridden, explain the reasoning. ⊗ Lecture unprompted on every decision. Closes #84 Phase 1 (adaptive teaching portion).

- main.md Agent Behavior section contains the three adaptive teaching rules
- Rules use RFC2119 symbols correctly

## t2.2.3: Add State WHY rule to strategies/interview.md (FR-21)  `[pending]`

Add ! rule to interview.md Interview Rules section: when making an opinionated recommendation, state the underlying principle in one sentence. Closes #84 Phase 1 (State WHY portion).

- interview.md Interview Rules contains: ! When making an opinionated recommendation, state the principle (1 sentence)
- Rule positioned near existing RECOMMENDED marker rule

## t2.3.1: Write CONTRIBUTING.md with full contributor bootstrap (FR-22, NFR-5)  `[pending]`

Create CONTRIBUTING.md at repo root. Must cover: prerequisites (Go 1.22+, Python 3.11+, uv, task), dev environment setup, running tests (task test, task check), running CLI locally (python run or uv run python run), building the Go installer (go build ./cmd/deft-install/). Closes #67 AC item 3.

- CONTRIBUTING.md exists at repo root
- Contains sections: Prerequisites, Dev Environment Setup, Running Tests, Running CLI Locally, Building the Installer
- All commands listed are accurate and runnable
- CONTRIBUTING.md documents `task check` as the authoritative pre-commit gate; explicitly states that a passing `task check` is the definition of ready-to-commit

## t2.4.1: Reframe README.md — remove Warping references (FR-23, depends on #89)  `[blocked]`

Remove 'Warping Process', 'What is Warping?', 'Contributing to Warping' from README.md. Update tagline per #89 resolution. Cannot proceed until #89 decides the framework's positioning and tagline. Closes part of #84 Phase 2.

- README.md contains no reference to 'Warping'
- Tagline reflects #89 resolution
- tests/content/test_standards.py Warping xfail flips to passing

## t2.4.2: Create meta/philosophy.md (FR-24, depends on #89)  `[blocked]`

Create meta/philosophy.md with full contract hierarchy narrative per #84 Phase 2. Framing depends on #89 resolution (SDD vs. CDE vs. hybrid tagline).

- meta/philosophy.md exists with RFC2119 legend
- Covers: spec as primary IP, contracts as derived artifacts, code as renewable output
- Consistent with #89 resolved framing

## t3.1.1: Write .github/workflows/ci.yml — lint + test on PRs and master pushes (FR-25, FR-26)  `[pending]`

GitHub Actions CI workflow triggering on pull_request and push to master. Jobs: (1) Python: ruff check, mypy tests/ (the shim run.py cannot be typed directly - exclude run and run.py from mypy per pyproject.toml, type-check the test suite instead), pytest tests/ with coverage. (2) Go: go test ./cmd/deft-install/ + go build ./cmd/deft-install/ for each platform matrix (linux/amd64, darwin/arm64, windows/amd64). main_test.go already exists so go test is zero-cost. Use current action versions. Closes #57.

- .github/workflows/ci.yml exists and is valid YAML
- Python job runs: ruff, mypy tests/ (run and run.py excluded via pyproject.toml), pytest with coverage
- Go job runs go test and builds installer for linux/amd64, darwin/arm64, and windows/amd64 (per NFR-3)
- Workflow triggers on pull_request and push to master
- CI passes on a clean branch

## t3.1.2: Open GitHub issue for run CLI coverage tracking (NFR-2)  `[pending]`

Open a new GitHub issue titled 'Bring run CLI into test coverage measurement' in the Phase 4/5 backlog. Reference the exclusion in pyproject.toml. Include the rationale: run is terminal-only, excluded for now, refactor needed before coverage is meaningful.

- GitHub issue exists with title containing 'run CLI' and 'coverage'
- Issue is assigned to Phase 4 or Phase 5 milestone/label

## t3.1.3: Raise pyproject.toml coverage threshold to 85% and document run exclusion (NFR-1, NFR-2, FR-27)  `[pending]`

**Depends on**: t3.1.1, t3.1.2

Update pyproject.toml: fail_under = 85. Add comment in [tool.coverage.run] omit section explaining why run and run.py are excluded (terminal-only CLI path; pending dedicated refactor issue). Resolves stated-vs-enforced coverage gap.

- pyproject.toml fail_under = 85
- omit entries for run and run.py include inline comment: '# terminal-only CLI; excluded pending #<issue>'
- task test:coverage passes at >=85% threshold on the current test suite
