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

// Engine / lifecycle dirs that stay at the framework root (NOT relocated by
// #1875). Shippable-content dirs moved under content/ -- see EXPECTED_CONTENT_DIRS.
export const EXPECTED_FRAMEWORK_DIRS = ["tasks", "scripts", "xbrief"] as const;

/** npm consumer deposit after #2022 Phase 3 -- Python scripts/ tree is intentionally absent. */
export const CONSUMER_FRAMEWORK_DIRS = ["tasks", "xbrief"] as const;

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
