section: Fixed
- Hooks: the #5656 commit-shape check no longer treats heredoc text that only names a commit command as a commit, so a Bash call that writes such a note is not refused. It reads the command through the shared authz line-continuation and heredoc strip; real commits and the -a/pathspec refusal are unchanged, and other string literals stay out of scope (#6187, #5656).
