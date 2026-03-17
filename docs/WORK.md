# WORK.md — totopo progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
totopo PACKAGE (this repo — distributed via npx in future)
├── ai.sh              ← entry point (run from user's project directory)
├── src/
│   ├── core/          ← user-facing CLI (included in npm package)
│   │   ├── dev.ts
│   │   ├── detect-host.ts     ← detect host runtime versions
│   │   ├── doctor.ts
│   │   ├── generate-dockerfile.ts  ← generate Dockerfile (full or host-mirror)
│   │   ├── menu.ts
│   │   ├── onboard.ts
│   │   ├── reset.ts
│   │   ├── select-tools.ts    ← multiselect UI for runtime tool selection
│   │   ├── settings-menu.ts   ← settings menu (mode switch + tool selection)
│   │   ├── settings.ts        ← read/write .totopo/settings.json
│   │   ├── stop.ts
│   │   └── sync-dockerfile.ts ← silent pre-flight: regenerate Dockerfile if stale
│   └── releases/      ← developer release tooling (NOT in npm package)
│       ├── rc.ts
│       ├── release.ts
│       ├── sync-github-releases.ts
│       ├── changelog-utils.ts
│       ├── generate-changelog.ts
│       └── changelog.yaml   ← source of truth for all release notes
└── templates/         ← copied into user's .totopo/ during onboarding
    ├── Dockerfile
    ├── post-start.mjs
    └── env

USER'S PROJECT (any git repo where totopo is used)
└── .totopo/            ← created by onboarding; config only, no scripts
    ├── .env           (gitignored — API keys)
    ├── Dockerfile     (regenerated on session start in host-mirror mode)
    ├── post-start.mjs
    └── settings.json  (runtimeMode + selectedTools; committed with project)
```

`ai.sh` sets `TOTOPO_PACKAGE_DIR` (where ai.sh lives) and `TOTOPO_REPO_ROOT`
(git root of `$PWD`) and exports them so scripts don't recompute paths.

---

## Working Now

_Nothing — ready for next task._

## Recently Completed

- **Remove DevPod dependency** — replaced devpod up/ssh with docker build + docker run + docker exec; removed devcontainer.json template and all DevPod references across src, docs, README, AGENTS, package.json

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **Workspace scoping** — support three modes when starting a session: repo root (current default), current directory, or current directory selectively (user picks which files/folders to mount). Complement with built-in agent context injection so the agent knows it lives in a dev container, may need host help for some operations, and in selective-mount mode is aware it should confirm before creating files or folders that are not mounted

- **Stop: select which workspace** — when multiple workspaces are running, let the user choose which to stop (related to workspace scoping but implemented separately)

- **Settings submenu** — view/edit API keys, check for updates, uninstall (remove `.totopo/` and stop container)

- **Docs** — polish README for npm page (install, quickstart, security model); contribution guide

- **Troubleshoot/help menu option** — add a troubleshoot entry to the main menu (scope TBD)

- **Tech choices review** — audit tech decisions across the package, dev container, and repo; output a DECISIONS.md explaining rationale for each major choice

- **Security status review** — assess current security posture, gaps, and tradeoffs; output a SECURITY.md as a concise reference

- **Terminal output review** — review and refine all terminal printings across every flow for consistency, clarity, and polish, including more detailed container status.

- **Autostart agent** - improved experience upon connecting to the dev container so user could during onboarding decide if he want to auto start specific agent (claude/opencode/kilo etc.).

- **README illustrations** — add visuals to README.md using Google's Banana Pro AI.
