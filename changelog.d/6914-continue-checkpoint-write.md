section: Fixed
- The write hook now admits the continue checkpoint (`xbrief/continue.xbrief.json`, legacy `vbrief/continue.vbrief.json`) as a process-owned path, with or without an active story, and spends no story extra-path allowance. Links, `..` parts and multi-hard-link files are not admitted (#6914).
