# totopo

<img src=".github/assets/logo.png" alt="totopo" width="100%" />

Local sandbox for AI agents.

![build](https://github.com/asafratzon/totopo/actions/workflows/build.yml/badge.svg)
![tests](https://github.com/asafratzon/totopo/actions/workflows/tests.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/totopo)
![npm downloads](https://img.shields.io/npm/dm/totopo)
![license](https://img.shields.io/npm/l/totopo)

## Who this is for

Developers who use `claude`, `codex`, or `opencode` **interactively** — one human pair-programming with one agent.

totopo isn't an orchestration tool (no SDK, no parallel agents, no per-run worktrees), and its security is basic — just the minimum precautions I think anyone running AI agents should take. If you need more on either front, look elsewhere.

## Motivation

Two fundamental risks when running AI agents locally:

1. Agents are unpredictable — they will make mistakes that may be hard to detect or undo.
2. Agents are vulnerable to prompt injection and can be subtly manipulated to leak sensitive data or execute unauthorized operations.

Totopo mitigates both risks by letting you run agents in a dev container — when you run totopo in a given directory, that directory is mounted as a workspace where agents can work freely, without access to the rest of your filesystem or your git remote.

In practice, this means any mistake can be reverted from your git remote, and even a compromised agent can't access sensitive files on your machine — SSH keys, credentials, browser data — things a locally-running agent could otherwise do without you ever noticing.

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
- **The blast radius is bounded** — the container can't push to remote or read outside the workspace, and you can hide files like `.env` from the agent (see [Shadow Paths](#shadow-paths)). For what this does and doesn't protect against, see [Threat Model](#threat-model).

For a deeper look at how totopo works and how to configure it, see the sections below.

## How totopo Works

totopo organises work around **workspaces** — any directory containing a `totopo.yaml` file. Running `npx totopo` for the first time in a directory walks you through a short setup and creates `totopo.yaml` (a small, well-documented config file that lives at the workspace root).

A few key concepts:

- **Workspace ID** - a unique slug declared in `totopo.yaml`. Used for container naming (`totopo-<id>`) and the local cache directory (`~/.totopo/workspaces/<id>/`).
- **Workspace Boundary** — `npx totopo` always resolves to the nearest `totopo.yaml` going up the directory tree. Each directory tree has exactly one workspace root.
- **Single Workspace Container** — totopo uses one Docker container per workspace, not one per session. Open as many terminals as you need — they all connect to the same running container, keeping resource use bounded and reconnections fast.

### `totopo.yaml`

The config is minimal — only `workspace_id` is required; the rest are optional:

- **`workspace_id`** *(required)* — unique slug for container naming and cache directory
- **`profiles`** *(optional)* — Dockerfile image variants (see [Profiles](#profiles))
- **`shadow_paths`** *(optional)* — gitignore-style patterns hidden from agents (see [Shadow Paths](#shadow-paths))
- **`env_file`** *(optional)* — path to env file injected at runtime (see [Environment Variables](#environment-variables))
- **`ports`** *(optional)* — host ports published into the container so a web tool inside opens in your host browser (see [Published Ports](#published-ports))

The file totopo generates (onboarding, `Settings > Reset`) is deliberately minimal — just `workspace_id` and `shadow_paths`. Add the optional settings above as you need them; each is documented in this README.

On every run, totopo shows the workspace menu:

- **Open session** — start or resume the dev container and connect
- **Stop container** — stop the running container
- **Settings** — git mode, shadow paths, voice, auto-start agent, rebuild, reset config
- **Advanced** — multi-workspace management (stop containers, clear memory, uninstall)

### Working directory

The workspace is always mounted at `/workspace` inside the container. The session opens wherever you ran totopo — from a subdirectory it starts at the matching path under `/workspace`, and from the workspace root it starts at `/workspace`. The whole workspace root stays mounted either way, so `cd /workspace` always reaches it.

## Core Features

### Container Isolation

Every session runs inside a Docker container. Your code is bind-mounted from the host — edits are immediately visible in your editor.

| Control | Implementation |
|---|---|
| Non-root user | All processes run as `devuser` (uid 1001) |
| No host credentials | Host git credentials are never copied into the container |
| No privilege escalation | `no-new-privileges:true` prevents any process from gaining elevated permissions |
| Filesystem isolation | Only the workspace directory is mounted; the rest of the host is not visible |
| Git guardrails | Per-workspace **git mode** controls what git can do inside the container — see [Git Modes](#git-modes) |
| Shadow mounts | Selected paths overlaid with isolated container-local copies — see [Shadow Paths](#shadow-paths) |
| Environment vars | Injected from a host file at session start (`env_file`) |

### Git Modes

Each workspace has a git mode (set via **Settings > Git mode**) that controls what git operations are permitted inside the container:

| Mode | Local mutations | Remote (push/pull/fetch/clone) |
|---|---|---|
| **local** *(default)* | Allowed | Blocked at the gitconfig protocol layer |
| **strict** | Blocked — a read-only `git` wrapper allows inspection (`status`, `log`, `diff`, `blame`, `show`, etc.) and rejects mutations (`commit`, `add`, `reset`, `checkout`, etc.) | Blocked at the gitconfig protocol layer |
| **unrestricted** | Allowed | Allowed |

The active mode is recorded per workspace in `.lock`, exposed inside the container as `TOTOPO_GIT_MODE`, and reflected in the agent context so each session knows what is permitted. Switching modes recreates the container on the next session.

### Profiles

Profiles let you define multiple container image variants for a workspace. Useful for teams — each person can have a lean profile tailored to their stack instead of one large shared image. Each profile defines a `dockerfile_hook` — raw Dockerfile instructions appended after the base image layers:

```yaml
# totopo.yaml
profiles:
  default:
    description: "Base image: Node.js, git, and AI CLIs"
    dockerfile_hook: |
      # No extras — uses the totopo base image as-is (Node.js + git + AI CLIs).

  # Uncomment to enable additional runtimes (Go, Java, Rust, Bun):
  # extended:
  #   description: Base image + Go, Java, Rust, and Bun
  #   dockerfile_hook: |
  #     # Go
  #     RUN apt-get update && apt-get install -y --no-install-recommends golang-go && rm -rf /var/lib/apt/lists/*
  #     # Java (headless JDK)
  #     RUN apt-get update && apt-get install -y --no-install-recommends default-jdk-headless && rm -rf /var/lib/apt/lists/*
  #     # Rust (system-wide)
  #     ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
  #     RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path && chmod -R a+rx /usr/local/cargo /usr/local/rustup
  #     # Bun
  #     ENV BUN_INSTALL=/usr/local/bun PATH=/usr/local/bun/bin:$PATH
  #     RUN curl -fsSL https://bun.sh/install | bash
  # Add more profiles here — or ask the agent inside the container to set one up for you.

```

New workspaces ship with the `default` profile active and an `extended` profile (Go, Java, Rust, Bun) included as a commented-out template — uncomment to enable. When multiple profiles are defined, totopo prompts you to pick one at session start (the choice is remembered). A profile change triggers a container rebuild on the next session.

The base image is defined in [`templates/Dockerfile`](templates/Dockerfile) — inspect it to see what's already included before adding your own layers. To force a fully fresh build (no Docker layer cache), use **Settings > Clean rebuild**.

### Shadow Paths

Shadow paths overlay specific files or directories with empty container-local equivalents — they apply across all profiles. Changes stay in the container-local copy; your workspace files are hidden and untouched:

```yaml
# totopo.yaml
shadow_paths:
  - node_modules    # matches all nested node_modules directories
  - .env*           # hides .env, .env.local, etc. from agents
```

Patterns follow gitignore syntax — patterns without a `/` match at any depth. Manage via **Settings > Shadow paths** or edit `totopo.yaml` directly. Changes take effect on the next session.

Git-tracked paths are skipped to avoid worktree diversions. Shadowing them has no privacy benefit anyway since agents can `git show` tracked content. To hide a file, untrack it and add it to `.gitignore` first.

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

totopo also injects privacy and sandbox environment variables into every container — a universal `DO_NOT_TRACK` opt-out plus switches that disable Claude Code telemetry, error reporting, and other non-essential traffic.

### Published Ports

A web tool running inside the container (dev server, `python3 -m http.server`, etc.) is not reachable from your host browser by default. List it under `ports` and totopo publishes it, identity-mapped and loopback-only, at container creation:

```yaml
# totopo.yaml
ports:
  - port: 4820          # desired host port (1024-65535)
    ifTaken: next       # "fail" (default) refuses to start if taken; "next" scans upward for a free port
    env: EXAMPLE_PORT   # injected with the resolved port number (required when ifTaken: next)
  - port: 5432
    ifTaken: fail       # default; refuses to start if 5432 is taken
```

- **Identity-mapped, loopback-only.** A port resolving to N is published as `127.0.0.1:N:N`. It is reachable only from your own machine, never the LAN — and because the number is identical inside and outside the container, a tool's printed `http://localhost:<port>` URL just works on the host.
- **`env`.** When set, the resolved number is injected as that env var. The tool binds it (e.g. `python3 -m http.server "$EXAMPLE_PORT"`) — one env var is the whole integration.
- **`ifTaken`.** `fail` (default) refuses to start and names the entry if the port is taken; `next` scans upward from `port` (bounded) for a free one. `next` requires `env`, since a remapped port is unreachable unless its number is injected.
- **Sticky per workspace.** The resolved number is remembered and reused across container recreation, so each workspace keeps its own port with no cross-workspace collisions. Editing an entry's `port` discards its old allocation; changing `ifTaken`/`env` recreates the container but keeps the port.

Each session prints one line per entry (e.g. `port 4821 open → EXAMPLE_PORT`) so you always know the resolved number. Changes to `ports` take effect through the normal container-recreation flow.

### AI CLIs

The container comes with the major AI coding CLIs pre-installed and ready to use:

```bash
claude      # Claude Code (Anthropic)
codex       # Codex (OpenAI)
opencode    # OpenCode
```

Agents are self-aware — sandbox constraints, git remote block, and any active shadow path overlays are injected into agent context at every session start.

totopo keeps all three CLIs on their latest published versions, checking for updates automatically.

#### Claude status line

For convenience, every Claude session opens with a status line at the bottom of the terminal:

```
174k (17%) · Opus 4.7 (1M context) xhigh · 5h limit ▓░░░░░░░░░ (resets in 2h 15m) · Claude Code v2.1.132
```

Four segments: current context usage (count and percentage), the model display name as provided by Claude Code followed by reasoning effort in purple, a 10-block gauge of the 5-hour rate-limit window with a relative countdown to reset (subscriber accounts only), and the installed Claude Code CLI version with a freshness hint that escalates as the install ages. The line stays on a calm grey baseline and only escalates to yellow or red when something genuinely warrants attention. Ask Claude `/totopo-statusline` to customize or restore the default.

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

To clear memory: `npx totopo` → **Advanced > Clear agent memory**.

## What Gets Installed

`totopo.yaml` lives in your workspace directory — you may commit it alongside your code. Everything else lives in `~/.totopo/` on your machine:

```
~/.totopo/
└── workspaces/
    └── <workspace_id>/
        ├── .lock       # workspace root path, active profile, and git mode
        ├── agents/     # agent session data (persists across rebuilds)
        │   ├── claude/
        │   ├── opencode/
        │   └── codex/
        └── shadows/    # container-local shadow path storage
```

## Voice Mode (microphone)

Claude Code's `/voice` records from a mic via SoX, but a container has none (on Docker Desktop the Linux VM has no device passthrough). totopo bridges your host mic in over a local PulseAudio server — **opt-in per workspace** from **Settings → Voice / audio**.

**macOS (automated):** in that menu, **Enable wiring**, then **Install pulseaudio → Start host server → Test microphone** (approve the mic prompt for your terminal under **System Settings → Privacy & Security → Microphone**). Open a session and run `/voice`. The main menu reminds you while the server runs — stop it there when done. For hands-off control, turn **Auto start/stop** on in the same menu: totopo then starts the server when a voice-enabled session opens and stops it once your last session exits, so you never start or stop it by hand.

**Linux / Windows (manual):** automation is macOS-only. **Enable wiring**, then run your own PulseAudio server reachable at TCP `4713` (load `module-native-protocol-tcp`). It must accept totopo's cookie at `~/.totopo/global/pulse-cookie` (mounted read-only into the container), or load the module with `auth-anonymous=1`. On Windows the source is typically the WSLg PulseAudio server.

> **Security:** while running, the server exposes your mic on a local TCP port, gated by an `auth-ip-acl` (private networks only) and — the real gate — a **dedicated, rotating cookie**: totopo-owned (not your general PulseAudio credential), mounted read-only, regenerated on every server start, so a leaked cookie dies on the next restart. Still, run the server only while you need voice and stop it after. A deliberate widening of totopo's boundary — see [Threat Model](#threat-model).

## Auto-start agent

By default a session drops you into a shell where you run `claude`, `opencode`, or `codex` yourself. To launch your favorite agent automatically as each session starts, pick it under **Settings → Auto-start agent**. Quit the agent and you land back in the container shell (the session stays open) — the info banner still lists how to run `status`, `exit`, and the other agents.

This is a host-global preference (stored in `~/.totopo/global/config`), so it applies to every workspace. Changing it recreates the current workspace's container; other workspaces pick it up on their next session.

## Troubleshooting

**Move or rename the workspace directory** — re-run `npx totopo` in the new location. totopo detects the path mismatch and guides you through realigning the workspace cache.

**Single machine** — `~/.totopo/` is local. Switching machines requires re-running setup in each workspace.

**Voice mode / audio** — `/voice` needs a microphone, which a container does not have by default. Enable it under **Settings → Voice / audio**; see [Voice Mode](#voice-mode-microphone).

**Shift+Enter not working in VS Code terminal** — add this to your VS Code keybindings (`Cmd+Shift+P` → "Open Keyboard Shortcuts (JSON)"):

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Threat Model

Totopo makes everyday agent mistakes safer. It is not built to stop a determined attacker.

**What it helps with:**
- Confused-agent mistakes — only the workspace is at risk; the rest of your machine is invisible.
- Casual prompt injection — the agent can't read your SSH keys or push to your remote, because neither is in the container.

**What it does not help with:**
- A determined adversarial agent. The network is open, and `/usr/bin/git` is reachable by absolute path even in strict mode. Anything in the workspace can still leave over HTTP.
- Secrets you didn't shadow. A `.env` tracked in git is visible unless you list it in `shadow_paths`.
- Container escapes. Totopo uses a non-root user and `no-new-privileges`, but no capability drops or seccomp profiles. For stronger isolation, use a microVM sandbox.
- Edits to your working tree. The workspace is bind-mounted, so agent changes land on your real files. Commit often.

**Voice mode widens this boundary** — enabling the mic bridge runs a host PulseAudio server that exposes your microphone over a local TCP port (cookie- and ACL-gated) for as long as it runs. Opt in only while dictating, and stop the server when done (or let automatic mode handle it on macOS); see [Voice Mode](#voice-mode-microphone).

## Disclaimer

MIT licensed and fully open source. Issues welcome — no promises on response time. Use at your own risk.
