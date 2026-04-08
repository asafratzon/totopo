## In Progress


## High Priority Backlog

- ⁠container + image per profile instead of per workspace: totopo-<workspace-id>-<profile-name>

- ⁠Stale detections on startup for workspaces, containers and images? think this through

- ⁠when switching profile, ask whether to stop previous profile container:
  - no (enables parallel work)
  - yes, but keep image (quicker startup on next session)
  - yes and clear image (frees space, slower startup on next session)

- Part of this change will require docs update and a migration

- Pnpm min age (also for orot)

- Update cli date should also written on clean build and first image building - but how can we know when the related layer is built?

## Nice to have / Raw Ideas

- voice to text

- support readonly mounts? (possibly to refer to dirs outside the workspace)

- consider supporting Gemini CLI + pi.dev CLI

- Profile `extends` inheritance (e.g. `extends: default` to inherit and append dockerfile_hook)

- Make the blocking git remote disableable via workspace settings and via the yaml (Default to on)
