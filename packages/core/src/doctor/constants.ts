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
  "--project-root",
  "-h",
  "--help",
] as const;

// Engine / lifecycle dirs that stay at the framework root (NOT relocated by
// #1875). Shippable-content dirs moved under content/ -- see EXPECTED_CONTENT_DIRS.
export const EXPECTED_FRAMEWORK_DIRS = ["tasks", "scripts", "vbrief"] as const;

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

export const NPM_PACKAGE_NAME = "@deftai/directive";

export const CLEAN_WINDOW_HOURS = 24;
export const DIRTY_WINDOW_HOURS = 4;
export const ENV_STATE_PATH = "DEFT_DOCTOR_STATE_PATH";
