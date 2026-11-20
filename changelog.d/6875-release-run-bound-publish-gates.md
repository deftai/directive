section: Changed
- The release finish step accepts a run binding for the coming `deft release:run` (#6845): with it, the tag gate accepts only the run's own grant for the exact merged tree, and the step refuses unless the release merge sits directly on the cut base. The finish step now reads the upgrade banner from the merged commit (#6875).
