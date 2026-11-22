section: Fixed
- Release Step 5: when the host smoke check on a reused cut passes its deadline, the whole process tree of the smoke command now stops, not only its direct child. The failure says whether the tree was stopped, which processes survived, or that cleanup could not be checked (#6904).
