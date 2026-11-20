section: Fixed
- The release-names test no longer runs the real release task chain, so it can no longer hang the merge gate: it checks the #2547 quoting path against a small go-task fixture, and every go-task call in it has a 30 s limit (#6862).
