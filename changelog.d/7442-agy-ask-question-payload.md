section: Fixed
- fix(hooks): agy `ask_question` was always denied because its `questions` args were dropped before the hatch and spend gates; they now reach the gates (#7442).
