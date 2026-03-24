# totopo

<img src=".github/assets/logo.png" alt="totopo" width="100%" />

A simple CLI to use AI coding agents safely in your local codebase.

![npm version](https://img.shields.io/npm/v/totopo)
![npm downloads](https://img.shields.io/npm/dm/totopo)
![license](https://img.shields.io/npm/l/totopo)

## Why totopo?

Here's the thing about AI agents: they're probabilistic. They occasionally misinterpret instructions, take unexpected shortcuts, or simply get it wrong. Most of the time they're fine. But "most of the time" isn't a great argument for giving them unrestricted access to your machine, your credentials, and your remote repositories.

totopo draws a simple boundary: agents get a full, capable environment to work in — they just can't touch anything outside the project, and they can't reach your remote. That's it. No domain whitelisting, no paranoia, no compromise on what the agent can actually do. Just a reasonable containment for non-deterministic tools.

Note: no sandbox substitutes for good judgment. Consider keeping any sensitive secrets or privileged scripts away from your agents.

## How totopo Works

- Unified, simple DX: run `npx totopo` from anywhere inside a local git repo.
- Installed once per git repository in a `.totopo/` directory at the repo root.
- Manages one Docker container per repository.

To start a development session, run `npx totopo`, choose `Open session` and confirm the desired scope: the full repo, the current directory, or selected files and folders.

### Concurrent Sessions
totopo uses one container per repository (not per session). This keeps resource usage bounded and makes reconnections fast - you can open as many sessions as you need — they all share the same running container.

The tradeoff is that only one scope can be active at a time: if you reopen a session with a different scope, totopo recreates the container to match the new mounts, which would terminate any active sessions connected to the previous container.

## Requirements

- [Docker](https://www.docker.com/products/docker-desktop/) - used to build and run the dev container
- [git](https://git-scm.com/) - safeguard to ensure agents only run in projects with version control in place

## Quick Start

```bash
cd your-project
npx totopo
```

First-time setup — running `npx totopo` in a fresh repo, selecting a runtime mode, and waiting for the Docker image to build for the first time:
![First-time setup](.github/assets/demo-onboarding.gif)

Opening a session when totopo is already initialized is quick. The agent is aware of its scope and sandbox constraints:
![Quick start](.github/assets/demo-quickstart.gif)

## Core features at a glance

- **Docker isolation** — AI agents run in a container with strict filesystem and privilege boundaries
- **Agents can't reach remote** — push, pull, fetch, and clone are blocked inside the container, preventing agents from accidentally affecting your remote repositories
- **AI CLIs with persistent sessions** — OpenCode, Claude Code, and Codex are pre-installed, with conversation history that survives restarts and rebuilds
- **Host-mirror or full runtime** — either match the container environment to your host, or use a standard dev container with the latest stable tools
- **Agents are scope-aware** — agents are informed of the mounted files and constraints at session start, so they can factor that into how they work
- **Scoped access** — expose only the files and directories the agent needs

## Features in Detail

### Container isolation

Every session runs inside a Docker container. Your code is bind-mounted from the host, so edits are immediately visible in your editor. The container enforces several isolation boundaries:

| Control | Implementation |
| --- | --- |
| Non-root user | All processes run as `devuser` (uid 1001) and cannot modify system-level config |
| Filesystem isolation | Only the selected project paths are mounted; the rest of the host filesystem is not visible |
| Git remote block | `protocol.allow = never` in `/etc/gitconfig` — push, pull, fetch, and clone are all refused and require root to override |
| No host credentials forwarded | Host git credentials are never copied into the container |
| Secrets never in image | API keys are loaded at runtime from `~/.totopo/.env` — never baked into the image, never mounted into the container |
| No privilege escalation | `no-new-privileges:true` prevents any process from gaining elevated permissions |

Remote git operations are blocked inside the container. Push from your host terminal instead.

### Session scope

When you open a session, totopo asks what part of the repository to mount into the container:

- `Repo root` — the full repository
- `Current directory` — only the current directory
- `Selective` — specific files and folders chosen interactively

The selected scope is stored on the container and checked on every later `Open session`.

- If the requested scope matches the existing container, totopo connects directly to it if running, or resumes it if stopped.
- If the requested scope is different, totopo recreates the container so the mounted paths match the new scope.
- Parallel terminals on the same scope are fine. totopo connects with `docker exec`, so any concurrency limits are just the normal limits of sharing one running container.

This is an intentional tradeoff: you get predictable resource usage and quick reconnects, but only one active mounted view per repository at a time.

In `Current directory` and `Selective` scopes, `.git` is intentionally not mounted. Mounting `.git` would expose the full commit history of every repository file, including files outside the mounted paths, which defeats the point of scoped access. As a result, git is unavailable inside those scoped sessions and the agent operates without repository history. The agent is instructed to surface these limitations at session start.

Scoped sessions are well-suited for focused tasks where you want to give the agent a narrow, explicit view of your codebase.

Example showcasing agent awareness of selective scope limitations:
![Scoped access](.github/assets/demo-scoped.gif)

### AI CLIs with persistent sessions

The container comes with the major AI coding CLIs ready to use out of the box:

```bash
opencode    # OpenCode
claude      # Claude Code (Anthropic)
codex       # Codex (OpenAI)
```

Agent session data is isolated per repository, so agents do not bleed context between projects. To clear memory, run `npx totopo` and navigate to `Advanced > Clear agent memory`. This stops the container if running and removes the `.totopo/agents/` directory.

### Dev container runtime

Choose between two modes:

- **Host-mirror** — the container runtime matches your host Node.js version and selected tools, keeping the environment consistent with your local setup.
- **Full** — a full dev container with the latest stable versions of all tools. Good default if you do not need version parity with your host.

Either way, basic dev tools and all three AI CLIs are always included.

## What gets created in your project

```text
your-project/
└── .totopo/
    ├── Dockerfile        # container image definition
    ├── post-start.mjs    # security checks + readiness summary on every start
    ├── settings.json     # runtime mode + selected tools (committed with project)
    ├── README.md         # .totopo reference
    └── agents/           # agent session data — gitignored, created on first session start
        ├── claude/       # mounted as ~/.claude/
        ├── opencode/     # mounted as ~/.config/opencode/ + ~/.local/share/opencode/
        └── codex/        # mounted as ~/.codex/

~/.totopo/.env            # API keys — global, outside all repos, never mounted into container
```

totopo is initialized at the repository root, and `.totopo/` lives there regardless of which directory you later open a session from. Agent session history and conversation data are persisted in `.totopo/agents/` across container rebuilds and restarts. This directory is gitignored so session data stays local to your machine.

## Limitations

**Audio / microphone** — the image includes `sox` (required by Claude Code for voice mode), but audio passthrough from the host depends on your OS. macOS, Linux, and Windows each require different device configuration. If you need voice mode, set up audio passthrough manually for your platform.

## Disclaimer

MIT licensed and fully open source. Fork it, adapt it, make it yours. Issues are welcome — no promises on response time. Use at your own risk.
