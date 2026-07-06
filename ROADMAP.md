## Backlog

- rewrite all commits history just in order to remove claude from all commit messages

## Ideas

- `npx totopo -q 'direct message to claude in running container'` --> to return the response to the user. 
    - support another command that will let claude run in auto-approve mode on, so i could do: `npx totopo -x 'please create file here bla bla'`

- Base image sharing - a shared `totopo-base:latest` built from `templates/Dockerfile`, with profile images layered on top (`FROM totopo-base` + hook). Saves disk when multiple profiles are defined, faster profile rebuilds since only the hook layer runs.

- Support readonly mounts? (possibly to refer to dirs outside the workspace)

- Local LLM Support?