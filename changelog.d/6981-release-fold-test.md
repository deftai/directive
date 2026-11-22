Section: Fixed
- The #6981 shell-tool docs test now reads the folded `CHANGELOG.md` entry once a release cut removes its changelog fragment, so release PRs no longer fail on a missing file. A guard for the whole class is #7142.
