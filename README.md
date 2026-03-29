# totopo

<img src=".github/assets/logo.png" alt="totopo" width="100%" />

A simple CLI to use AI coding agents safely in your local codebase.

![npm version](https://img.shields.io/npm/v/totopo)
![npm downloads](https://img.shields.io/npm/dm/totopo)
![license](https://img.shields.io/npm/l/totopo)

## Why totopo?

Here's the thing about AI agents: they're probabilistic. They occasionally misinterpret instructions or simply get it wrong. Most of the time they're fine. But "most of the time" isn't a great argument for giving them unrestricted access to your machine, your credentials, and your remote repositories.

totopo draws a simple boundary: agents get a full, capable environment to work in — they just can't touch anything outside the project, and they can't reach your remote. That's it. No domain whitelisting, no paranoia, no compromise on what the agent can actually do. Just a reasonable containment for non-deterministic tools.

Note: no sandbox substitutes for good judgment. Consider keeping any sensitive secrets or privileged scripts away from your agents.

## How totopo Works

totopo organises work around **projects** — any local directory you register with totopo. The first time you run `npx totopo` in a directory, it walks you through a short setup. Every subsequent run, from anywhere inside that directory tree, totopo resolves the project automatically and shows the project menu:

- **Open session** — jump into an AI coding session
- **Stop container** — stop the running container
- **Project Settings** — runtime mode, shadow paths
- **Rebuild container** — rebuild the docker image (upon changing runtime mode)

All config lives in `~/.totopo/` — nothing is written to your project directory.

### Concurrent Sessions
totopo uses one Docker container per project, not one per session. You can open as many terminal sessions as you need — they all connect to the same container, keeping resource usage bounded and reconnections fast.

## Requirements

- [Docker](https://www.docker.com/products/docker-desktop/) — used to build and run the dev container
- [Node.js](https://nodejs.org/) — required to run `npx totopo`

## Quick Start

```bash
cd your-project
npx totopo
```

<!--First-time setup — running `npx totopo` in a fresh repo, selecting a runtime mode, and waiting for the Docker image to build for the first time:-->
<!-- ![First-time setup](.github/assets/demo-onboarding.gif) -->

<!--Opening a session when totopo is already initialized is quick. The agent is aware of the sandbox constraints:-->
<!-- ![Quick start](.github/assets/demo-quickstart.gif) -->

## Core features at a glance

- **Docker isolation** — AI agents run in a container with strict filesystem and privilege boundaries
- **No remote git access** — push, pull, fetch, and clone are blocked inside the container, so agents can't accidentally affect your remote repositories
- **AI CLIs included** — OpenCode, Claude Code, and Codex are pre-installed and ready to use, agents are informed of their constraints at session start
- **Persistent agent memory** — conversation history and session data survive container restarts and rebuilds, stored in `~/.totopo/`
- **Shadow paths** — opt-in overlay of specific files or directories with empty container-local equivalents, useful for separate `node_modules` or hiding sensitive files from agents
- **Host-mirror or standard runtime** — match the container environment to your host, or use a general-purpose dev container with the latest stable tools

## Features in Detail

### Container isolation

Every session runs inside a Docker container. Your code is bind-mounted from the host, so edits are immediately visible in your editor. The container enforces several isolation boundaries:

| Control | Implementation |
| --- | --- |
| Non-root user | All processes run as `devuser` (uid 1001) and cannot modify system-level config |
| Filesystem isolation | Only the project directory is mounted; the rest of the host filesystem is not visible |
| Git remote block | `protocol.allow = never` in `/etc/gitconfig` — push, pull, fetch, and clone are all refused and require root to override |
| No host credentials forwarded | Host git credentials are never copied into the container |
| Secrets never in image | API keys are loaded at runtime from `~/.totopo/.env` — never baked into the image, never mounted into the container |
| No privilege escalation | `no-new-privileges:true` prevents any process from gaining elevated permissions |

Remote git operations are blocked inside the container. Push from your host terminal instead.

### Working directory

The full project directory is always mounted at `/workspace` inside the container. When you run totopo from a subdirectory, you get a quick prompt to choose your starting working directory:

- **Here** — start in the subdirectory you launched from
- **Repo root** — start at `/workspace`

If you're already at the project root, no prompt is shown — the session starts directly at `/workspace`.

### Shadow paths

Shadow paths let you overlay specific project files or directories with empty container-local equivalents. Configure them via the Settings menu (`Settings > Shadow paths`).

- A shadowed **directory** appears as an empty directory on first use. The container can populate it freely and the contents persist across sessions — for example, running `npm install` into a shadowed `node_modules` means subsequent sessions find it already installed.
- A shadowed **file** appears as an empty file inside the container, hiding the host file's contents from agents.

Common use cases:
- **Separate `node_modules`** — the container installs its own dependencies, useful when host and container run different operating systems
- **Hide sensitive files** — keep `.env`, credentials, or other secrets invisible to agents running inside the container

Shadow paths are stored in `settings.json` and persist across rebuilds. When shadow paths change, the container is automatically recreated on the next session. Host-side shadow entries are stored in `~/.totopo/projects/<id>/shadows/`.

### AI CLIs included

The container comes with the major AI coding CLIs ready to use out of the box:

```bash
opencode    # OpenCode
claude      # Claude Code (Anthropic)
codex       # Codex (OpenAI)
```

### Persistent agent memory

Agent session data is isolated per project and persists across container restarts and rebuilds.

To clear memory, run `npx totopo` and navigate to `Manage totopo > Clear agent memory` and select a project. This stops the container if running and removes the agents memory from ~/.totopo directory.

### Dev container runtime

Choose between two modes:

- **Host-mirror** — the container runtime matches your host Node.js version and selected tools, keeping the environment consistent with your local setup.
- **Standard** — a general-purpose dev container with the latest stable versions of all tools. Good default if you do not need version parity with your host.

Either way, basic dev tools and all three AI CLIs are always included.

## What gets installed

All totopo config lives in `~/.totopo/` on your machine — nothing is written to your project directory.

```text
~/.totopo/
├── .env                        # API keys — global, never mounted into container
└── projects/
    └── <id>/                   # stable hash of the project root path
        ├── meta.json           # project root, display name, container name
        ├── settings.json       # runtime mode + selected tools
        ├── Dockerfile          # container image definition
        ├── post-start.mjs      # security checks + readiness summary on every start
        ├── shadows/            # host-side directories for shadow path mounts
        └── agents/             # agent session data — created on first session start
            ├── opencode/       # mounted as ~/.config/opencode/ + ~/.local/share/opencode/
            ├── claude/         # mounted as ~/.claude/
            └── codex/          # mounted as ~/.codex/
```

Agent session history and conversation data are persisted in the `agents/` directory across container rebuilds and restarts.

### Shared onboarding (optional)

If you want contributors to get a one-click setup experience, add a `totopo.yaml` file at your project root:

```yaml
# totopo.yaml — project anchor
#
# name        — shown as: "Welcome to <name>."
# description — shown as: "<description>"

name: my-project
description: Our AI coding sandbox. Ask @alice for the API keys.
```

When a new contributor runs `npx totopo`, totopo reads this file to anchor the project root and displays the welcome message before prompting for setup. Without it, totopo will find the git root and suggest it as the project root, so `totopo.yaml` is purely optional.

To add a project anchor to an existing local-only totopo project, run `npx totopo` and select `Add project anchor` from the project menu.

## Limitations

**Rename or move** — moving the project directory breaks identity since totopo uses the absolute path as the project key. Re-run `npx totopo` in the new location to onboard again. Orphaned configs can be cleaned up via `Manage totopo`.

**Single machine** — `~/.totopo/` is local. Switching to a new machine requires re-onboarding each project.

**Audio / microphone** — the image includes `sox` (required by Claude Code for voice mode), but audio passthrough from the host depends on your OS. macOS, Linux, and Windows each require different device configuration. If you need voice mode, set up audio passthrough manually for your platform.

## Disclaimer

MIT licensed and fully open source. Fork it, adapt it, make it yours. Issues are welcome — no promises on response time. Use at your own risk.
