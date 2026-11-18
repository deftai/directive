section: Changed
- OVPR docs revision **v261118**: old projects keep working until upgraded. The launcher hands calls to the project's own installed older copy, or stops with a plain install-or-upgrade message when none is installed; a bare `deft-hook` call in a project that pins the runtime is out-of-date wiring (AC10.11).
