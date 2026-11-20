section: Changed
- The release finish step and the draft flip accept a run binding for the coming `deft release:run` (#6845): with it, only the run's own grant for the exact merged tree counts and the finish step refuses unless the release merge sits directly on the cut base; the finish step now reads the upgrade banner from the merged commit (#6875).
