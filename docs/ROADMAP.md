# ROADMAP.md

Tracks current work in progress and upcoming planned items.

## In Progress



## Backlog

- Run 'npx totopo' when installed totopo version is older - discuss strategy and auto-upgrade option

- Make project directory name a bit more readbale? 1f0be1b76af0f6de36967119ec460080abce476ce15de6e88a109f342f63dac4...

- Add Tests + pnpm test + update AGENTS.md + update pre-commit hook to run them

- Improve/standarize the container image used so AI agents have all the tools they need
    - The baseline image, should be overridable by the user, but how/where to locate it?
    - New totopo versions running should detect existing ~/.totopo dir and "upgrade them" on first run (some files should be re-written, like docker image etc).

- **Orphan recovery via git remote**: store git remote URL at onboarding; if a new path is onboarded and remote URL matches an existing orphaned config, offer to reclaim it. (v1 onboarding already stores `gitRemoteUrl` in `meta.json`)
