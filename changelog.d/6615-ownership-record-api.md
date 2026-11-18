section: Added
- Directive can now tell, for any file in a project, whether a change to it is made only of Directive's own material, using one shared list of what Directive owns. This lets later fixes let Directive's own refreshed files through without a planning brief. Refs #6615.
- `directive uninstall` now removes the current hook files and their hook registrations. Before, both stayed behind after uninstall and pointed at a removed runtime. `directive install` now records those hook files as Directive's. Refs #6007, #5999.
