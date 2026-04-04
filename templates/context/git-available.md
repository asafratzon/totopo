## Git availability

Git is fully available for local operations (commit, branch, log, diff, status, etc.).

Remote access (push, pull, fetch, clone) is **blocked at the system level** by design — `protocol.allow = never` is enforced in `/etc/gitconfig` and cannot be overridden without root. This is a deliberate security boundary: the container has no access to remote repositories. Ask the user to run any remote git operations from the host.
