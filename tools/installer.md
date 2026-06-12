# Installer

Legend: !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Version Currency

! `deft-install` MUST query the GitHub Releases API (`GET /repos/deftai/directive/releases/latest`) after the welcome banner and before the project-name prompt, with a 1.5s combined connect/read timeout. The `User-Agent` header MUST be `deft-install/<version>`.

! On version match, `deft-install` MUST print a one-line confirmation (`Running latest (<version>)`) and proceed without prompting.

! On version mismatch, `deft-install` MUST print the embedded version, latest version, publish date, and download URL, then prompt `[y/N]` with default abort.

! On network error or timeout, `deft-install` MUST print a "could not verify" message and prompt `[y/N]` with default abort.

! On non-TTY stdin, `deft-install` MUST exit 1 for any non-match outcome unless `DEFT_NO_UPDATE_CHECK=1` is set or `--no-update-check` is passed.

⊗ Run the version check for `--version` or `--help` invocations.

⊗ Suppress the prompt for any class of drift: rc-vs-GA, patch, and minor drift all use the same confirmation rule.

⊗ Warn when the embedded version is ahead of latest. Locally built development binaries must proceed without update-check noise in that case.

Comparison rule: warn iff `embedded < latest` under SemVer ordering. Pre-release identifiers sort below their corresponding GA per SemVer, so `v0.20.0-rc.1 < v0.20.0` without special-casing release candidates.
