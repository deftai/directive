import {
  ENGINE_PACKAGE,
  type PackageManager,
  renderGlobalInstall,
} from "../resolution/package-manager.js";

export const UV_INSTALL_URL = "https://docs.astral.sh/uv/";

// Stable, version-neutral upgrade signposts (#1912). Core principle: never bake
// the upgrade command/version into the artifact being upgraded -- bake in a
// stable pointer resolved fresh. These URLs carry NO Go-installer version and
// NO literal upgrade command; they point at the canonical docs + the frozen
// final Go bridge release so the npm CLI / doctor can signpost the
// legacy -> bridge -> npm recovery without going stale.
export const UPGRADING_DOC_URL =
  "https://github.com/deftai/directive/blob/master/content/UPGRADING.md";
export const GO_BRIDGE_RELEASES_URL = "https://github.com/deftai/directive/releases";

/** One recovery ladder for doctor FAIL suggested_fix (#4090). One spelling per rung. */
export const RECOVERY_LADDER_AGENTS_REFRESH = "deft agents:refresh";
export const RECOVERY_LADDER_UPDATE = "deft update";
export const RECOVERY_LADDER_NPX_PREFIX = "npx @deftai/directive";
export const RECOVERY_LADDER_NPM_GLOBAL = "npm i -g @deftai/directive";

export type RecoveryLadderPrimary = "agents-refresh" | "update";

export interface RecoveryLadderFields {
  readonly suggested_fix: string;
  readonly suggested_fix_alt: string;
  readonly suggested_fix_npx: string;
  readonly suggested_fix_npm_global: string;
  readonly go_bridge_releases_url: string;
  readonly upgrading_doc_url: string;
}

export function recoveryLadderFields(primary: RecoveryLadderPrimary): RecoveryLadderFields {
  const refresh = RECOVERY_LADDER_AGENTS_REFRESH;
  const update = RECOVERY_LADDER_UPDATE;
  const verb = primary === "agents-refresh" ? "agents:refresh" : "update";
  return {
    suggested_fix: primary === "agents-refresh" ? refresh : update,
    suggested_fix_alt: primary === "agents-refresh" ? update : refresh,
    suggested_fix_npx: `${RECOVERY_LADDER_NPX_PREFIX} ${verb}`,
    suggested_fix_npm_global: RECOVERY_LADDER_NPM_GLOBAL,
    go_bridge_releases_url: GO_BRIDGE_RELEASES_URL,
    upgrading_doc_url: UPGRADING_DOC_URL,
  };
}

export function recoveryLadderProse(primary: RecoveryLadderPrimary): string {
  const f = recoveryLadderFields(primary);
  return (
    `Run \`${f.suggested_fix}\`. Payload missing or version drift: \`${RECOVERY_LADDER_UPDATE}\` ` +
    `(task upgrade is the documented alias). CLI not on PATH: \`${f.suggested_fix_npx}\` or ` +
    `\`${f.suggested_fix_npm_global}\`, then the same verbs. Pre-canonical layout: frozen Go bridge ` +
    `at ${f.go_bridge_releases_url} (see ${f.upgrading_doc_url}).`
  );
}

/** Doctor remediation when the classifier refuses to write (#4090 P1). */
export const RECOVERY_LADDER_UNREADABLE_TRUNCATED =
  "Restore a matching <!-- /deft:managed-section --> close in AGENTS.md; deft agents:refresh refuses this unreadable state and will not write";
export const RECOVERY_LADDER_UNREADABLE_TRUNCATED_OPEN =
  "Complete the managed-section opener through --> in AGENTS.md (example: <!-- deft:managed-section v3 -->), then restore a matching close; deft agents:refresh refuses this unreadable state and will not write";

export function unreadableAgentsRecovery(reason: string): {
  readonly message: string;
  readonly suggested_fix: string;
} {
  if (reason === "unsupported-future") {
    return {
      message:
        `AGENTS.md managed section is unreadable (${reason}) -- refuse to write. ` +
        `Upgrade the CLI/payload (\`${RECOVERY_LADDER_UPDATE}\` or \`${RECOVERY_LADDER_NPM_GLOBAL}\`), then re-run doctor. ` +
        `\`${RECOVERY_LADDER_AGENTS_REFRESH}\` will not write this state.`,
      suggested_fix: RECOVERY_LADDER_UPDATE,
    };
  }
  if (reason === "truncated-open") {
    return {
      message:
        `AGENTS.md managed section is unreadable (${reason}) -- refuse to write. ` +
        `Complete the opener through \`-->\` (example: \`<!-- deft:managed-section v3 -->\`) and restore a matching close. ` +
        `\`${RECOVERY_LADDER_AGENTS_REFRESH}\` will not write this state.`,
      suggested_fix: RECOVERY_LADDER_UNREADABLE_TRUNCATED_OPEN,
    };
  }
  return {
    message:
      `AGENTS.md managed section is unreadable (${reason}) -- refuse to write. ` +
      `Restore a matching close marker \`<!-- /deft:managed-section -->\` in AGENTS.md. ` +
      `\`${RECOVERY_LADDER_AGENTS_REFRESH}\` will not write this state.`,
    suggested_fix: RECOVERY_LADDER_UNREADABLE_TRUNCATED,
  };
}

export const AGENTS_MANAGED_CLOSE = "<!-- /deft:managed-section -->";

export const DEPRECATED_REDIRECT_SENTINEL = "<!-- deft:deprecated-redirect -->";
export const DEPRECATED_SKILL_REDIRECT_SENTINEL = "<!-- deft:deprecated-skill-redirect -->";
export const REDIRECT_STUB_HEADER_LINES = 8;

export const TASKFILE_INCLUDE_SNIPPET =
  "version: '3'\n\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";

export const DOCTOR_ALLOWED_FLAGS = [
  "--session",
  "--fix",
  "--repair",
  "--repair-taskfile",
  "--json",
  "--quiet",
  "--full",
  "--network",
  "--project-root",
  "--force",
  "--openclaw-all-agents",
  "-h",
  "--help",
] as const;

/** npm consumer deposit after #2022 Phase 3 -- Python scripts/ tree is intentionally absent. */
export const NPM_PACKAGE_NAME = "@deftai/directive";
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
export const NPM_REGISTRY_MIRROR_DOC_URL = `${UPGRADING_DOC_URL}#corporate-or-mirrored-npm-registry`;

// #2182: payload-staleness is the only doctor check that can reach a network
// endpoint (git ls-remote verifies the pinned ref and `npm view` compares a
// release-tag install with the latest stable package). The #2808 baseline
// registry-routing check uses only offline `npm config get` reads.
// Payload-staleness is OFF by default (offline tier) and requires the explicit
// `--network` flag; this line discloses exactly which tool + registry class it
// may contact BEFORE the check runs, and the skip line tells an offline run how
// to opt in.
export const NETWORK_DISCLOSURE_LINE =
  "[deft doctor] --network: this run may contact your git remote (framework " +
  "repo host) and the npm registry (registry.npmjs.org) to " +
  `look up the latest ${NPM_PACKAGE_NAME} version.`;

export const PAYLOAD_STALENESS_OFFLINE_SKIP_MESSAGE =
  "skip -- offline tier (default). Run `deft doctor --network` to check " +
  "framework currency against your git remote and the npm registry " +
  "(discloses tool + registry before contacting either).";

// Engine dirs that stay at the framework/deposit root (#4162). Project
// lifecycle is project-root xbrief/; schema pack is contentRoot vbrief/schemas.
// Do not list xbrief here — that was the false-name that warned consumers.
export const EXPECTED_FRAMEWORK_DIRS = ["tasks", "scripts"] as const;

/** npm consumer deposit after #2022 Phase 3 -- Python scripts/ tree is intentionally absent. */
export const CONSUMER_FRAMEWORK_DIRS = ["tasks"] as const;

/** Tree identity for Doctor layout rows and JSON findings (#4162). */
export const LAYOUT_TREE = {
  PROJECT_LIFECYCLE: "project-lifecycle",
  FRAMEWORK_CONTENT: "framework-content",
  ENGINE_DEPOSIT: "engine/deposit",
} as const;

export type LayoutTree = (typeof LAYOUT_TREE)[keyof typeof LAYOUT_TREE];

/** Shipped schema pack relative to contentRoot() (source: content/vbrief/schemas). */
export const FRAMEWORK_SCHEMA_PACK_DIR = "vbrief/schemas" as const;

// Post-#1875 content/ move: these framework-internal markers now live under
// content/ in the SOURCE repo. They identify a deft source checkout (a consumer
// would never reproduce them); the C1 flatten means a consumer deposit has no
// content/ dir, so the absence of content/ here is consistent with the
// "not a source checkout" branch.
export const DEFT_REPO_POSITIVE_MARKERS = [
  "content/templates/agents-entry.md",
  "content/skills/deft-directive-build/SKILL.md",
] as const;

// Shippable-content framework dirs relocated under content/ by #1875. The
// framework-layout doctor check resolves these via content-root probing so the
// same check works for a source checkout (content/<dir>) and a flattened
// consumer deposit (<dir>).
export const EXPECTED_CONTENT_DIRS = ["languages", "strategies", "skills", "templates"] as const;

/** Post-freeze canonical upgrade path (#1997 / #2003 / #1912). */
export const CANONICAL_UPGRADE_COMMAND = "npm i -g @deftai/directive@latest";

/**
 * Render the canonical upgrade one-liner for the active package manager (#2197).
 * Defaults to npm (`CANONICAL_UPGRADE_COMMAND`) so existing callers are
 * unchanged; pass `pnpm` to emit the pnpm form
 * (`pnpm add -g @deftai/directive@latest`). Consumed by the doctor
 * payload-staleness recommendation (`payload-staleness.ts`).
 */
export function upgradeCommandFor(pm: PackageManager = "npm"): string {
  return renderGlobalInstall(pm, `${ENGINE_PACKAGE}@latest`);
}

/** Vendored npm-managed deposit: global bump plus in-place `.deft/core/` refresh (#2115). */
export const VENDORED_NPM_DEPOSIT_UPGRADE_COMMAND = `${CANONICAL_UPGRADE_COMMAND} && deft update`;

export const CLEAN_WINDOW_HOURS = 24;
export const DIRTY_WINDOW_HOURS = 4;
export const ENV_STATE_PATH = "DEFT_DOCTOR_STATE_PATH";
