section: Fixed
- Hooks: the #5656 commit-shape check no longer reads `2>&1 | tail -N` or other pipes and redirections after a commit as file names, reads short option clusters like `-qm` as git does, and keeps a `cd` joined to the commit by a pipe unresolvable. Real `-a`, `-am` and trailing file names are still refused, and the refusal now names the word that tripped it (#6471, #5656).
