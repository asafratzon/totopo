## Git availability

Git is **not available** — no `.git` directory was found in the workspace root.

Remote access is also **blocked container-wide** by design (`protocol.allow = never` in `/etc/gitconfig`).

If git operations are needed, ask the user to run them on the host.
