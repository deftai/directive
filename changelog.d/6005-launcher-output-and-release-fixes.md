section: Fixed
- Windows: `directive … --root e:\repo` is no longer refused when the drive letter's case differs from Git's (#6005).
- After install, repair and upgrade, "Review and commit" now lists every file Directive created or changed, grouped by folder, and never `node_modules` or readiness markers (#6006).
- `directive upgrade` on an old layout with no `package.json` now says in the plan that it will create a minimal one, and prints `Created package.json { "private": true }` when it does (#5965).
- The npm release run no longer ends red after a good publish: the post-publish check now runs as one bundled file that needs no installed packages (#5603).
- `task materialize:runtime` now extracts under Git Bash, places the new runtime next to its dependencies on pnpm checkouts, and puts the published runtime back if the new one cannot start (#6220).
