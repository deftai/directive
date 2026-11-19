section: Fixed
- The lockfile reader no longer uses two slow-on-crafted-input patterns for `specifier:` and `version:` lines; very long lines now parse instantly with the same results. Closes #6680.
