section: Fixed
- `directive uninstall` now removes the current hook files and their hook registrations. Before, both stayed behind after uninstall and pointed at a removed runtime. `directive install` now records those hook files as Directive's. Refs #6615.
