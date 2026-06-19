export const UV_INSTALL_URL = "https://docs.astral.sh/uv/";

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

export const EXPECTED_FRAMEWORK_DIRS = [
  "languages",
  "strategies",
  "skills",
  "templates",
  "tasks",
  "scripts",
  "vbrief",
] as const;

export const DEFT_REPO_POSITIVE_MARKERS = [
  "templates/agents-entry.md",
  "skills/deft-directive-build/SKILL.md",
] as const;

export const CANONICAL_UPGRADE_COMMAND = "deft-install --yes --upgrade --repo-root . --json";

export const CLEAN_WINDOW_HOURS = 24;
export const DIRTY_WINDOW_HOURS = 4;
export const ENV_STATE_PATH = "DEFT_DOCTOR_STATE_PATH";
