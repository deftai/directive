section: Fixed
- **Flaky pre-PR controller tests**: `controller.test.ts` now freezes `Date` for each test, so a second boundary between the command-phase and reviewer-report fills no longer trips the phase-order check and turns master's merge gate red (#6484)
