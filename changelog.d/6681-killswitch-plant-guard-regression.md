section: Fixed
- Security: the kill-switch plant guard refuses a `cmd /c "..."` payload that redirects into the kill-switch file, and an `xargs` pipeline that feeds the kill-switch file or a protected store to a writer, again (both regressed in #6580). Read-only mentions stay allowed. Refs #6681.
