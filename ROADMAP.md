## In Progress


## High Priority Backlog

### Local LLM Support

## Low Priority Backlog

- Base image sharing - a shared `totopo-base:latest` built from `templates/Dockerfile`, with profile images layered on top (`FROM totopo-base` + hook). Saves disk when multiple profiles are defined, faster profile rebuilds since only the hook layer runs.

- Stale image detection improvements - replace the current hardcoded file check in `isImageStale()` with hash comparison of the Dockerfile template and profile hook content baked into image labels. More robust, catches more staleness cases.

- Voice to text support

- Support readonly mounts? (possibly to refer to dirs outside the workspace)

- Make the blocking git remote disableable via .lock - not via the yaml (Default to on)
