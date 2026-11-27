/**
 * AC8.10 completeness inventory: current installer outputs → OVPR package-relative
 * targets (or N/A with UNIFIED-aligned justification). Evidence for feature
 * preservation — not a generic installer registry.
 */
export type InventoryDisposition = "retained" | "rewired" | "conditional" | "na-retired-copy-model";

export interface InstallerOutputInventoryEntry {
  /** Stable id for tests / smokes. */
  readonly id: string;
  /** Prior-installer surfaces (examples; not exhaustive permission to omit). */
  readonly legacyOutputs: readonly string[];
  /** OVPR target or rationale when N/A. */
  readonly ovprTarget: string;
  readonly disposition: InventoryDisposition;
  /** UNIFIED-aligned justification when deferred/N/A or conditional. */
  readonly justification: string;
  /** Setup activator that deposits/rewrites this surface (when retained/rewired/conditional). */
  readonly setupActivator?: string;
}

/**
 * AC8.10 inventory of useful feature points vs retired copy-model scaffolding.
 * MUST-retainals are activated from runSetup; N/A entries are documented, not silent omissions.
 */
export const INSTALLER_OUTPUT_INVENTORY: readonly InstallerOutputInventoryEntry[] = [
  {
    id: "agents-managed-section",
    legacyOutputs: ["AGENTS.md managed section from templates/agents-entry.md"],
    ovprTarget: "AGENTS.md ← templates/agents-entry.md (package-relative paths)",
    disposition: "rewired",
    justification: "AC9.6 / AC9.7 / Wave 2c — full agents-entry template, not a stub.",
    setupActivator: "ensureAgentsManagedSection",
  },
  {
    id: "skill-pointers",
    legacyOutputs: [
      ".agents/skills/**/SKILL.md",
      ".claude/skills/**",
      ".cursor/skills/**",
      ".codex/skills/**",
      ".github/skills/**",
    ],
    ovprTarget: "node_modules/@deftai/directive-runtime/skills/<name>/SKILL.md (AC9.6)",
    disposition: "rewired",
    justification: "AC9.6 / AC8.1 — thin pointers including always-pins pre-pr + review-cycle.",
    setupActivator: "ensureSkillPointers",
  },
  {
    id: "copilot-skill-discovery",
    legacyOutputs: [".github/skills/** (GitHub Copilot skill discovery)"],
    ovprTarget: ".github/skills/<name>/SKILL.md → runtime skills/ (via skill host roots)",
    disposition: "retained",
    justification: "AC8.1 Copilot example — covered by SKILL_HOST_ROOTS including .github/skills.",
    setupActivator: "ensureSkillPointers",
  },
  {
    id: "host-hooks",
    legacyOutputs: [
      ".claude/settings.json hooks",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
      ".agents/hooks.json (zzzz-directive entry)",
    ],
    ovprTarget: "node …/dist/hook-bin.js --host <host> --event <event> (AC9.1)",
    disposition: "rewired",
    justification: "AC9.1 / AC9.2 package-relative hook-bin; bare deft-hook rewritten.",
    setupActivator: "ensureHostHooks",
  },
  {
    id: "git-hooks",
    legacyOutputs: [".githooks/pre-commit", ".githooks/pre-push", ".githooks/_directive-run.sh"],
    ovprTarget: ".githooks/* → node_modules/@deftai/directive-runtime/dist/bin.js (AC9.9)",
    disposition: "rewired",
    justification: "AC9.9 path-resolved git hooks; hooksPath=.githooks when eligible.",
    setupActivator: "ensureGitHooks",
  },
  {
    id: "taskfile-include",
    legacyOutputs: ["Taskfile.yml includes.deft"],
    ovprTarget: "taskfile: ./node_modules/@deftai/directive-runtime/Taskfile.yml",
    disposition: "rewired",
    justification: "AC9.9 Taskfile include package-relative.",
    setupActivator: "ensureTaskfileInclude",
  },
  {
    id: "slash-commands",
    legacyOutputs: [
      ".claude/commands/*.md",
      ".cursor/commands/*.md",
      ".grok/commands/*.md",
      ".codex/prompts/*.md",
    ],
    ovprTarget:
      "Host command/prompt thin wrappers → node_modules/@deftai/directive-runtime/<dispatchPath>",
    disposition: "rewired",
    justification:
      "AC8.1 / AC8.10 — retain slash/prompt deposits; rewrite off .deft/core teaching.",
    setupActivator: "ensureSlashCommands",
  },
  {
    id: "openclaw-integrations",
    legacyOutputs: ["OpenClaw L2 product-command skills", "OpenClaw soft AGENTS re-bind skill"],
    ovprTarget: "OpenClaw workspace skills dirs when OC signals present (conditional)",
    disposition: "conditional",
    justification:
      "AC8.1 conditional OpenClaw — deposit adapters no-op unless OpenClaw is detected; fail-closed otherwise.",
    setupActivator: "ensureOpenClawIntegrations",
  },
  {
    id: "gitattributes-core-markers",
    legacyOutputs: [".gitattributes .deft/core/** text=auto/generated/vendored"],
    ovprTarget: "N/A — no .deft/core content copy under OVPR (AC13.1)",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10: scaffolding solely served the retired copied-content model; no package-relative substitute required. Setup removes the exact lines it wrote (#5961).",
  },
  {
    id: "gitattributes-managed-wiring-lf",
    legacyOutputs: [".gitattributes # Deft managed wiring: LF lines (#5995)"],
    ovprTarget:
      ".gitattributes managed block: LF for host commands, skills, .githooks, AGENTS.md and the deft-hook-*.mjs outers",
    disposition: "retained",
    justification:
      "AC8.10 / AC9.1: Windows autocrlf checkouts keep Directive's committed files LF (#5995 / #6167).",
    setupActivator: "ensureManagedPathGitattributes",
  },
  {
    id: "prettierignore-core-exclusion",
    legacyOutputs: [".prettierignore .deft/core/"],
    ovprTarget: "N/A — no vendored .deft/core tree to exclude",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10: the Prettier exclusion existed only for copied .deft/core; setup removes the exact line it wrote (#5961).",
  },
  {
    id: "prettierignore-hook-files",
    legacyOutputs: [],
    ovprTarget: ".prettierignore **/deft-hook-*.mjs, only when the file already exists",
    disposition: "conditional",
    justification:
      "AC13.3: one managed line keeps the committed hook files out of the project's formatter check (#6167).",
    setupActivator: "ensurePrettierIgnoreHookLine",
  },
  {
    id: "codeql-core-exclusion",
    legacyOutputs: [".github/codeql/codeql-config.yml paths-ignore .deft/core/**"],
    ovprTarget: "N/A — no vendored .deft/core tree to exclude",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10: CodeQL exclusion existed only for copied .deft/core; runtime stays in node_modules. Setup removes the exact item and comments it wrote; the file stays (#5961).",
  },
  {
    id: "core-guard-workflow",
    legacyOutputs: [".github/workflows/deft-core-guard.yml"],
    ovprTarget: "N/A — guarded mixed .deft/core + app commits under copy model",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10 / AC13.1: core-guard workflow solely enforced the retired .deft/core deposit layout. " +
      "Its emitter is removed (#5835); upgrade and convert delete a leftover Directive-written copy " +
      "via removal step removeRetiredCoreGuardWorkflow and keep a user-edited file.",
  },
  {
    id: "greptile-core-ignore",
    legacyOutputs: ["greptile.json ignorePatterns .deft/core/**"],
    ovprTarget: "N/A — no .deft/core tree",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10: greptile ignore of .deft/core solely served the copy model. Setup removes the exact pattern; the file stays (#5961).",
  },
  {
    id: "bare-version-marker",
    legacyOutputs: ["xbrief/.deft-version", ".deft-version", "vbrief/.deft-version"],
    ovprTarget: "N/A — the package.json runtime pin is the only version statement (AC1.6)",
    disposition: "na-retired-copy-model",
    justification:
      "AC8.10 / AC1.6 / AC10.5: the bare version marker solely served the copy model; upgrade removes version-only markers (D-022, #6001).",
  },
  {
    id: "generation-ownership",
    legacyOutputs: [".deft/GENERATION.json ownership[]"],
    ovprTarget: ".deft/GENERATION.json ownership including wholly owned skill pointers (AC11.10)",
    disposition: "rewired",
    justification: "AC8.1 / AC11.10 — setup maintains persistent ownership/removal record.",
    setupActivator: "buildOwnershipArtifacts",
  },
] as const;

/** Ids that must have a setup activator (not silent omissions). */
export const MUST_ACTIVATE_INVENTORY_IDS: readonly string[] = INSTALLER_OUTPUT_INVENTORY.filter(
  (e) =>
    e.disposition === "retained" || e.disposition === "rewired" || e.disposition === "conditional",
).map((e) => e.id);

export function inventoryEntry(id: string): InstallerOutputInventoryEntry | undefined {
  return INSTALLER_OUTPUT_INVENTORY.find((e) => e.id === id);
}

export function assertInventoryCompleteness(): void {
  const ids = new Set(INSTALLER_OUTPUT_INVENTORY.map((e) => e.id));
  for (const required of [
    "agents-managed-section",
    "skill-pointers",
    "slash-commands",
    "openclaw-integrations",
    "copilot-skill-discovery",
    "gitattributes-core-markers",
    "gitattributes-managed-wiring-lf",
    "prettierignore-core-exclusion",
    "prettierignore-hook-files",
    "codeql-core-exclusion",
    "core-guard-workflow",
    "bare-version-marker",
  ] as const) {
    if (!ids.has(required)) {
      throw new Error(`AC8.10 inventory missing required entry: ${required}`);
    }
  }
  for (const e of INSTALLER_OUTPUT_INVENTORY) {
    if (
      (e.disposition === "retained" ||
        e.disposition === "rewired" ||
        e.disposition === "conditional") &&
      !e.setupActivator
    ) {
      throw new Error(`AC8.10 inventory entry ${e.id} lacks setupActivator`);
    }
    if (e.disposition === "na-retired-copy-model" && !e.justification.includes("AC8.10")) {
      throw new Error(`AC8.10 N/A entry ${e.id} must cite AC8.10 in justification`);
    }
  }
}
