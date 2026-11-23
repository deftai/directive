section: Fixed
- `pack-staged-runtime.mjs` (used by `task materialize:runtime`) no longer fails under Git Bash on Windows with "Cannot connect to C:". Its tar calls now run in the tarball's folder with the file name only and use System32 bsdtar on win32, the same fix #6703 made in `tasks/materialize.cjs` (#7172).
