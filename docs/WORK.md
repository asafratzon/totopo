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

## Working Now / Next

- **Verify `npx totopo` end-to-end** — test in a clean project directory that the full flow works: install via npx, onboarding, dev session start/stop

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
