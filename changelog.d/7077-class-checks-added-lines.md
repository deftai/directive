section: Fixed
- fix(class-checks): class 2 of `verify:class-checks` scans only the lines the diff against the merge base adds, so a file that already names a test root can be edited (#7077). Injected callers pass `addedLines`; a path with no added-line data is still scanned on every line.
