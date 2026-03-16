# WORK.md — totopo progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
totopo PACKAGE (this repo — distributed via npx in future)
├── ai.sh              ← entry point (run from user's project directory)
├── src/
│   ├── core/          ← user-facing CLI (included in npm package)
│   │   ├── dev.ts
│   │   ├── doctor.ts
│   │   ├── menu.ts
│   │   ├── onboard.ts
│   │   ├── reset.ts
│   │   └── stop.ts
│   └── releases/      ← developer release tooling (NOT in npm package)
│       ├── rc.ts
│       ├── release.ts
│       ├── sync-github-releases.ts
│       ├── changelog-utils.ts
│       ├── generate-changelog.ts
│       └── changelog.yaml   ← source of truth for all release notes
└── templates/         ← copied into user's .totopo/ during onboarding
    ├── Dockerfile
    ├── devcontainer.json
    ├── post-start.mjs
    └── env

USER'S PROJECT (any git repo where totopo is used)
└── .totopo/            ← created by onboarding; config only, no scripts
    ├── .env           (gitignored — API keys)
    ├── Dockerfile
    ├── devcontainer.json
    └── post-start.mjs
```

`ai.sh` sets `TOTOPO_PACKAGE_DIR` (where ai.sh lives) and `TOTOPO_REPO_ROOT`
(git root of `$PWD`) and exports them so scripts don't recompute paths.

---

## Working Now

- **Release tooling hardening (`pnpm rc` + `pnpm rc:promote`)** — two improvements:
  1. `pnpm rc` idempotent/resumable — rc.ts should be stateless so re-running after any phase failure picks up where it left off rather than re-committing or re-tagging. Phases to handle: changelog check, package.json alignment, git commit (skip if already committed), npm publish (skip if version already in registry), git tag (skip if tag exists), git push tags, GitHub release sync.
  2. `pnpm rc:promote` idempotent/resumable + uncommitted changes guard — make the script stateless so re-running after any phase failure picks up where it left off (e.g. skip changelog squash if already done, skip git commit if already committed, skip npm publish if version already latest). Also detect uncommitted changes early and always stop to inform the user. Two cases: (a) changes touch packaged files (`ai.sh`, `src/core/`, `templates/`, `tsconfig.json`, `LICENSE`, `package.json`) — stop and explain they'd end up published, suggest commit + new rc or manual stash + re-run; (b) changes don't touch packaged files — stop and offer three automated options: stash → flow → unstash, auto-commit and continue, or cancel.

---

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **Dockerfile: full runtime support** — add Python, Go, Rust, Java and audit common tools; update post-start.mjs checks and templates

- **Dockerfile: runtime mode** — let the user decide if he wants the full dev container with all dev tools in their latest stable versions, or have only the the tools that are available on host machine and in the same versions so that both dev container and host behave in a similar fashion. If user selects the host-versions, this should be checked on every session startup since possibly user updated his local versions or added new tools etc. Should be manageable via settings menu and configurable per repo, so the setting should probably be saved/come from .totopo dir.

- **Settings submenu** — view/edit API keys, check for updates, uninstall (remove `.totopo/` and stop container)

- **Docs** — polish README for npm page (install, quickstart, security model); contribution guide

- **Workspace scoping** — support three modes when starting a session: repo root (current default), current directory, or current directory selectively (user picks which files/folders to mount). Complement with built-in agent context injection so the agent knows it lives in a dev container, may need host help for some operations, and in selective-mount mode is aware it should confirm before creating files or folders that are not mounted

- **Troubleshoot/help menu option** — add a troubleshoot entry to the main menu (scope TBD)

- **Tech choices review** — audit tech decisions across the package, dev container, and repo; output a DECISIONS.md explaining rationale for each major choice

- **Security status review** — assess current security posture, gaps, and tradeoffs; output a SECURITY.md as a concise reference

- **Stop: select which workspace** — when multiple workspaces are running, let the user choose which to stop (related to workspace scoping but implemented separately)

- **Terminal output review** — review and refine all terminal printings across every flow for consistency, clarity, and polish, including more detailed container status.

- **Autostart agent** - improved experience upon connecting to the dev container so user could during onboarding decide if he want to auto start specific agent (claude/opencode/kilo etc.).
