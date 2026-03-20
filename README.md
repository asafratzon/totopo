# totopo

A simple CLI for sandboxed local AI agent development.

## What is totopo?

totopo spins up a secure, isolated dev container for any git project — with AI coding tools pre-installed — in a single command.

There are other solutions that offer more hardened security setups, and others with a richer feature set. totopo is neither of those. It is my own take on what makes a good balance between excellent developer experience and a sensible basic sandboxing setup — the combination I couldn't find elsewhere.

<!-- VIDEO: first-run onboarding — npx totopo in a fresh git repo, runtime mode selection, first container build -->

---

## Requirements

- [Docker](https://www.docker.com/products/docker-desktop/)
- [git](https://git-scm.com/) — totopo only works inside git repositories

---

## Quick Start

```bash
cd your-project
npx totopo
```

Select **Open session** from the menu. If `.totopo/` doesn't exist yet, the onboarding flow runs first — it sets up the container config, prompts for API keys, and updates `.gitignore`. The first run builds the Docker image (a few minutes). Subsequent starts are fast.

<!-- VIDEO: opening a session, container prompt, running an AI tool, exiting -->

---

## Features

### Sandboxed dev container

Every session runs inside a Docker container. Your code is bind-mounted from the host — edits are immediately visible in your editor. The container enforces several isolation boundaries:

| Control | Implementation |
| --- | --- |
| Non-root user | All processes run as `devuser` (uid 1001) — cannot modify system-level config |
| Filesystem isolation | Only the repo is mounted — host filesystem is not visible |
| Git remote block | `protocol.allow = never` in `/etc/gitconfig` — push, pull, fetch, and clone are all refused; requires root to override |
| No host credentials forwarded | Host git credentials are never copied into the container |
| Secrets never in image | API keys loaded at runtime from `~/.totopo/.env` — never baked into the image, never mounted into the container |
| No privilege escalation | `no-new-privileges:true` prevents any process from gaining elevated permissions |

Remote git operations are blocked inside the container. Push from your host terminal instead.

### Scoped sandboxing

Mount only the files and directories you need into the container rather than the full repository. Two scoped modes are available: `cwd` (current directory only) and `selective` (hand-pick individual files and folders).

In both scoped modes, `.git` is intentionally not mounted. Mounting `.git` would expose the full commit history of every repository file — including files outside the mounted paths — which defeats the point of scoped access. As a result, git is unavailable inside a scoped session and the agent operates without repository history. The agent is instructed to surface these limitations at session start.

Scoped sessions are well-suited for focused tasks where you want to give the agent a narrow, explicit view of your codebase.

### AI tools pre-installed

The container comes with the major AI coding CLIs ready to use out of the box:

```bash
opencode    # OpenCode
claude      # Claude Code (Anthropic)
codex       # Codex (OpenAI)
```

### Dev container runtime

Choose between two modes:

- **Host-mirror** — the container runtime matches your host Node.js version and selected tools, keeping the environment consistent with your local setup.
- **Generic** — a full dev container with the latest stable versions of all tools. Good default if you don't need version parity with your host.

Either way, basic dev tools and all three AI CLIs are always included.

<!-- VIDEO: settings menu — switching runtime mode, selecting tools, triggering a rebuild -->

---

## What gets created in your project

```
your-project/
└── .totopo/
    ├── Dockerfile        # container image definition
    ├── post-start.mjs    # security checks + readiness summary on every start
    ├── settings.json     # runtime mode + selected tools (committed with project)
    ├── README.md         # .totopo reference
    └── agents/           # agent session data — gitignored, created on first session start
        ├── claude/            → ~/.claude/
        ├── opencode/          → ~/.config/opencode/ + ~/.local/share/opencode/
        └── codex/             → ~/.codex/

~/.totopo/.env            # API keys — global, outside all repos, never mounted into container
```

Agent session history and conversation data are persisted in `agents/` across container rebuilds and restarts. This directory is gitignored — session data stays local to your machine.

---

## Limitations

**Audio / microphone** — the image includes `sox` (required by Claude Code for voice mode), but audio passthrough from the host depends on your OS. macOS, Linux, and Windows each require different device configuration. If you need voice mode, set up audio passthrough manually for your platform.

---

## Disclaimer

totopo is a side project. It is MIT licensed and fully open source — fork it, adapt it, build on it. Feel free to open an issue if you run into something, though I can't guarantee a response timeline. Use at your own risk.
