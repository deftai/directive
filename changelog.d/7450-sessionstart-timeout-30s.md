section: Fixed
- fix(hooks): the deposited SessionStart hook timeout was 5 seconds, which Windows runs exceeded (4.9s-6.5s measured on agy); it is now 30 seconds for every host, and old 5-second deposits repair as drift (#7450).
