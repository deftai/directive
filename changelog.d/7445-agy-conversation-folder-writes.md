section: Fixed
- fix(hooks): agy may write to its own conversation folder (`~/.gemini/antigravity/brain/<id>/` or `~/.gemini/antigravity-cli/brain/<id>/`) before the session ritual; other conversations, `config/`, `..` and link escapes stay gated (#7445).
