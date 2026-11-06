// Stub `gh` for #6023 / #6032 tests. Run as `node color-gh-stub.mjs <gh argv...>`.
// Handles:
// - `api repos/<o>/<r>/issues/<n>` (issue object)
// - `issue view <n> ... --json labels` (labels object)
// - `release view <tag> ... --json …` (release draft object; #6032)
// - `api [--paginate] repos/<o>/<r>/releases…` (releases list; #6032)
// Real gh keeps ANSI color on a pipe when CLICOLOR_FORCE is set to anything
// but 0 (cli.github.com/manual/gh_help_environment). The stub does the same.
// It ALSO colors on FORCE_COLOR, which gh does not document: that branch only
// backs the defensive FORCE_COLOR test rows, not a real gh behaviour.
const forced = (name) => {
  const value = process.env[name];
  return value !== undefined && value !== "" && value !== "0";
};
const argv = process.argv.slice(2);
let payload;
if (argv[0] === "issue" && argv[1] === "view") {
  payload = {
    number: Number(argv[2]),
    // Marker only this stub returns: a test asserting it proves the stub ran.
    labels: [{ name: "x-stub-6023-marker" }],
    stubNoColor: process.env.NO_COLOR ?? null,
  };
} else if (argv[0] === "release" && argv[1] === "view") {
  const tag = argv[2] ?? "v0.0.0";
  payload = {
    isDraft: true,
    name: tag,
    tagName: tag,
    createdAt: "2026-01-01T00:00:00Z",
    publishedAt: null,
    assets: [],
    url: `https://github.com/example/releases/tag/${tag}`,
    stubNoColor: process.env.NO_COLOR ?? null,
  };
} else if (
  argv[0] === "api" &&
  argv.some((arg) => typeof arg === "string" && /\/releases(?:\?|$)/.test(arg))
) {
  payload = [
    {
      id: 6032,
      draft: true,
      name: "v0.21.0",
      tag_name: "v0.21.0",
      html_url: "https://github.com/deftai/directive/releases/tag/v0.21.0",
      stubNoColor: process.env.NO_COLOR ?? null,
    },
  ];
} else {
  const match = /\/issues\/(\d+)$/.exec(argv[1] ?? "");
  payload = {
    number: match ? Number(match[1]) : null,
    state: "closed",
    labels: [],
    stubNoColor: process.env.NO_COLOR ?? null,
  };
}
const text = JSON.stringify(payload);
const color = forced("CLICOLOR_FORCE") || forced("FORCE_COLOR");
process.stdout.write(color ? `\u001b[1;38m${text}\u001b[m\n` : `${text}\n`);
