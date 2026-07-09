## Git availability

The user set git mode to **strict** in totopo - do not attempt git operations that modify state or interact with remotes.

totopo enforces this by:
- Blocking git commands that would modify the repository (attempts return a clear error).
- Blocking remote access (push, pull, fetch, clone).
- Allowing read-only inspection commands (e.g. `git status`, `git log`, `git show`, `git diff`, `git blame`, `git branch --list`, `git rev-parse`) - use these freely when you need to understand the repo state.
