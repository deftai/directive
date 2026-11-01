/**
 * Child-only environment for `gh` / `ghx` captures whose stdout is parsed as JSON (#6023).
 *
 * gh documents `CLICOLOR_FORCE` (any value but `0`) as keeping ANSI color even
 * when stdout is piped (cli.github.com/manual/gh_help_environment), and it wins
 * over `NO_COLOR` (cli/cli#13335; also seen in the #6023 reproduction), so an
 * inherited agent-host or CI env can break every engine `JSON.parse` of gh
 * output. `FORCE_COLOR` is not a documented gh variable; dropping it is
 * defensive. Callers pass this env to the child only; `process.env` is never
 * mutated.
 *
 * Keys are matched case-insensitively because Windows env names are.
 */
const COLOR_KEYS = new Set(["CLICOLOR_FORCE", "FORCE_COLOR", "NO_COLOR"]);

export function plainGhEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!COLOR_KEYS.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  env.NO_COLOR = "1";
  return env;
}
