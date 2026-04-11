# totopo

<img src=".github/assets/logo.png" alt="totopo" width="100%" />

Local sandbox for AI agents.

![build](https://github.com/asafratzon/totopo/actions/workflows/build.yml/badge.svg)
![tests](https://github.com/asafratzon/totopo/actions/workflows/tests.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/totopo)
![npm downloads](https://img.shields.io/npm/dm/totopo)
![license](https://img.shields.io/npm/l/totopo)

## Motivation

Before they run freely on your machine, ask yourself: **can you trust AI agents?**

- **Inherently unpredictable**: agents inevitably make mistakes, in ways that may be hard to detect or undo.
- **Vulnerable to prompt injection**: agents with internet access can be subtly manipulated to leak sensitive data or execute unauthorized operations.

Totopo mitigates both risks with a dev container - when you run totopo in a given directory, that directory is mounted as a workspace where agents get a full, capable environment to work in - without access to anything outside it or to remote Git repositories.

If an agent makes a mistake, damage is contained to the workspace, your git remote is out of reach.<br>
If an agent gets compromised, it can't reach your host files — blast radius is limited to the workspace you chose to share.

> totopo's security approach is basic — it is about the minimal precautions I believe anyone running AI agents should have. If you need more robust protections, look somewhere else.

## Requirements

- [Docker](https://www.docker.com/products/docker-desktop/) — builds and runs the dev container
- [Node.js](https://nodejs.org/) — required to run `npx totopo`

## Quick Start

```bash
cd your-project
npx totopo
```

`npx totopo` always runs the latest stable version. Alternatively, install globally to pin a specific version: `npm install -g totopo`.

> **Do not install totopo as a local project dependency.** totopo stores all workspace state in `~/.totopo/`, shared across all your workspaces. A local install means different projects could run different versions, which can break schema compatibility with shared config. Use `npx` or a global install.

### Basic Usage

Once set up, the flow is simple:

1. Run `npx totopo` → **Open session**
2. Run `claude`, `opencode`, or `codex` — pick an agent, start working

A few things happen automatically:

- **Agents stay up to date** — totopo keeps all AI CLIs on their latest versions, checking for updates automatically.
- **Sessions are persistent** — agent memory and settings survive container restarts and rebuilds.
- **Your machine stays safe** — the container can't push to remote, can't read outside the workspace, and sensitive paths like `.env` can be hidden from agents entirely (see [Shadow Paths](#shadow-paths)).

For a deeper look at how totopo works and how to configure it, see the sections below.

## How totopo Works

totopo organises work around **workspaces** — any directory containing a `totopo.yaml` file. Running `npx totopo` for the first time in a directory walks you through a short setup and creates `totopo.yaml` (a small, well-documented config file that lives at the workspace root).

A few key concepts:

- **Workspace ID** - a unique slug declared in `totopo.yaml`. Used for container naming (`totopo-<id>`) and the local cache directory (`~/.totopo/workspaces/<id>/`).
- **Workspace Boundary** — `npx totopo` always resolves to the nearest `totopo.yaml` going up the directory tree. Each directory tree has exactly one workspace root.
- **Single Workspace Container** — totopo uses one Docker container per workspace, not one per session. Open as many terminals as you need — they all connect to the same running container, keeping resource use bounded and reconnections fast.

On every run, totopo shows the workspace menu:

- **Open session** — start or resume the dev container and connect
- **Stop container** — stop the running container
- **Manage Workspace** — shadow paths, rebuild, reset config
- **Manage totopo** — multi-workspace management (stop containers, clear memory, uninstall)

### Working directory

The workspace is always mounted at `/workspace` inside the container. When you run totopo from a subdirectory, you get a quick prompt to start **here** or at the **workspace root**. If you're already at the workspace root, the session starts directly at `/workspace`.

## Core Features

### Container Isolation

Every session runs inside a Docker container. Your code is bind-mounted from the host — edits are immediately visible in your editor.

| Control | Implementation |
|---|---|
| Non-root user | All processes run as `devuser` (uid 1001) |
| No host credentials | Host git credentials are never copied into the container |
| No privilege escalation | `no-new-privileges:true` prevents any process from gaining elevated permissions |
| Filesystem isolation | Only the workspace directory is mounted; the rest of the host is not visible |
| Git remote block | `protocol.allow = never` in `/etc/gitconfig` — push, pull, fetch, and clone are refused |
| Shadow mounts | Selected paths overlaid with isolated container-local copies — see [Shadow Paths](#shadow-paths) |
| Environment vars | Injected from a host file at session start (`env_file`) |

Remote git operations are blocked inside the container. Run them from your host terminal.

### Profiles

Profiles let you define multiple container image variants for a workspace. Each profile defines a `dockerfile_hook` — raw Dockerfile instructions appended after the base image layers:

```yaml
# totopo.yaml
profiles:
  default:
    description: "Base image: Node.js, git, and AI CLIs"
    dockerfile_hook: |
      # No extras — uses the totopo base image as-is (Node.js + git + AI CLIs).
  extended:
    description: Base image + Go, Java, Rust, and Bun
    dockerfile_hook: |
      # Go
      RUN apt-get update && apt-get install -y --no-install-recommends golang-go && rm -rf /var/lib/apt/lists/*
      # Java (headless JDK — includes javac; needed for Kotlin, Scala, Android tooling)
      RUN apt-get update && apt-get install -y --no-install-recommends default-jdk-headless && rm -rf /var/lib/apt/lists/*
      # Rust (system-wide install — devuser can use cargo and rustc)
      ENV RUSTUP_HOME=/usr/local/rustup
      ENV CARGO_HOME=/usr/local/cargo
      ENV PATH=/usr/local/cargo/bin:$PATH
      RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path && chmod -R a+rx /usr/local/cargo /usr/local/rustup
      # Bun (fast JS runtime, bundler, and package manager)
      ENV BUN_INSTALL=/usr/local/bun
      ENV PATH=/usr/local/bun/bin:$PATH
      RUN curl -fsSL https://bun.sh/install | bash
  # Add more profiles here — or ask the agent inside the container to set one up for you.

```

Two profiles are set by default. When multiple profiles are defined, totopo prompts you to pick one at session start (the choice is remembered). A profile change triggers a container rebuild on the next session.

The base image is defined in [`templates/Dockerfile`](templates/Dockerfile) — inspect it to see what's already included before adding your own layers. To force a fully fresh build (no Docker layer cache), use **Manage Workspace > Clean rebuild**.

### Shadow Paths

Shadow paths overlay specific files or directories with empty container-local equivalents. Changes stay in the container-local copy; your workspace files are hidden and untouched:

```yaml
# totopo.yaml
shadow_paths:
  - node_modules    # matches all nested node_modules directories
  - .env*           # hides .env, .env.local, etc. from agents
```

Patterns follow gitignore syntax — patterns without a `/` match at any depth. Manage via **Manage Workspace > Shadow paths** or edit `totopo.yaml` directly. Changes take effect on the next session.

Common use cases:
- **Separate `node_modules`** — the container installs its own dependencies, avoiding platform conflicts between host and container.
- **Hide sensitive files** — keep credentials and secrets invisible to agents.

### Environment Variables

You can point totopo at an env file relative to `totopo.yaml`:

```yaml
# totopo.yaml
env_file: .env
```

The file is loaded into the container's environment at session start. If the file is not found, totopo skips it with a warning.

### AI CLIs

The container comes with the major AI coding CLIs pre-installed and ready to use:

```bash
opencode    # OpenCode
claude      # Claude Code (Anthropic)
codex       # Codex (OpenAI)
```

Agents are self-aware — sandbox constraints, git remote block, and any active shadow path overlays are injected into agent context at every session start.

totopo keeps all three CLIs on their latest published versions, checking for updates automatically.

### Persistent Agent Memory

Agent session data (conversation history, settings) is stored per workspace and survives container restarts and rebuilds.

```
~/.totopo/workspaces/<id>/agents/
├── claude/             # mounted as ~/.claude/ inside the container
│   └── .claude.json    # mounted as ~/.claude.json (persists Claude Code settings across rebuilds)
├── opencode/
│   ├── config/         # mounted as ~/.config/opencode/ inside the container
│   └── data/           # mounted as ~/.local/share/opencode/ inside the container
└── codex/              # mounted as ~/.codex/ inside the container
```

To clear memory: `npx totopo` → **Manage totopo > Clear agent memory**.

## What Gets Installed

`totopo.yaml` lives in your workspace directory — commit it alongside your code. Everything else lives in `~/.totopo/` on your machine; nothing else is written into your project.

```
~/.totopo/
└── workspaces/
    └── <workspace_id>/
        ├── .lock       # workspace root path + active profile
        ├── agents/     # agent session data (persists across rebuilds)
        │   ├── claude/
        │   │   └── .claude.json
        │   ├── opencode/
        │   │   ├── config/
        │   │   └── data/
        │   └── codex/
        └── shadows/    # container-local shadow path storage
```

## Troubleshooting

**Move or rename the workspace directory** — re-run `npx totopo` in the new location. totopo detects the path mismatch and guides you through realigning the workspace cache.

**Single machine** — `~/.totopo/` is local. Switching machines requires re-running setup in each workspace.

**Audio** — `sox` is included (required by Claude Code for voice mode), but audio passthrough depends on your OS. macOS, Linux, and Windows each require different device configuration.

**Shift+Enter not working in VS Code terminal** — add this to your VS Code keybindings (`Cmd+Shift+P` → "Open Keyboard Shortcuts (JSON)"):

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Disclaimer

MIT licensed and fully open source. Issues welcome — no promises on response time. Use at your own risk.
