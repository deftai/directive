section: Fixed
- Authz: a quoted heredoc body line that ends in a backslash no longer hides the commands after the heredoc from the zip / protected-destination check. The heredoc lexer is now shared with the commit-shape check (#6187).
