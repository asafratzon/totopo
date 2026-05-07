## Backlog

## Ideas

- checkout https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture

- `npx totopo -q 'direct message to claude in running container'` --> to return the response to the user. 
    - support another command that will let claude run in auto-approve mode on, so i could do: `npx totopo -x 'please create file here bla bla'`

- Voice to text support for claude

- container-only paths (like pnpm-store)?

- Base image sharing - a shared `totopo-base:latest` built from `templates/Dockerfile`, with profile images layered on top (`FROM totopo-base` + hook). Saves disk when multiple profiles are defined, faster profile rebuilds since only the hook layer runs.

- Stale image detection improvements - replace the current hardcoded file check in `isImageStale()` with hash comparison of the Dockerfile template and profile hook content baked into image labels. More robust, catches more staleness cases.

- Support readonly mounts? (possibly to refer to dirs outside the workspace)

- Local LLM Support? probably not relevant for a sandbox