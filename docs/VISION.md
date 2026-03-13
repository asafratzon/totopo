# VISION — totopo (Secure AI Box)

## What is totopo?

totopo is an open source command line tool that gives any developer a secure, isolated environment to work with AI coding assistants — in any project, from any directory, with a single command.

It is not an AI tool itself. It is the infrastructure that makes AI tools safe to use locally.

---

## The Problem

AI coding assistants are powerful. Tools like Claude Code, Kilo, and OpenCode can read your codebase, write code, run commands, and make decisions autonomously. That power comes with a real risk: when you run an AI agent locally, it operates with your full user permissions. It can access files outside your project, push to remote repositories, read credentials, and interact with your system in ways you may not intend or even notice.

Most developers using AI CLIs today are one misconfigured prompt away from an agent that does something unintended with their codebase or system.

There is currently no simple, standardized way to run AI agents locally in a contained, auditable environment.

---

## The Vision

totopo makes secure AI-assisted development the default, not the exception.

You go to any project directory on your machine, run `totopo`, and within minutes you have:

- A fully isolated development environment running in Docker
- Claude Code, Kilo, and OpenCode pre-installed and ready — no setup required
- All common development runtimes pre-installed (Node.js, Python, Java, Go, Rust, and more)
- Git remote operations blocked at the system level — the agent cannot push, pull, or clone anything
- No access to your host filesystem beyond the project directory
- Full internet access for AI APIs to function
- A beautiful, modern terminal experience that makes the whole thing feel effortless

When you are done, you run `totopo` again and stop the session cleanly. No residue, no complexity.

---

## Core Principles

**Security by default, not by configuration.**
The safe path is the easy path. totopo does not ask developers to configure security — it enforces it automatically, every time.

**Transparency above all.**
Every security decision totopo makes is documented, explained, and visible. The code is fully open source. There are no black boxes. A developer should be able to read exactly what totopo does to their system and why.

**Zero noise in your repo.**
totopo lives in a single hidden directory at your repo root. It does not scatter files, does not modify your existing configuration, and can be removed completely in one command.

**Works with what you already have.**
totopo does not replace your editor, your git workflow, or your terminal. It adds a safe layer around AI tool usage without changing how you work.

**Open source, guaranteed, forever.**
totopo is MIT licensed and will remain fully open source unconditionally — not as a policy that could change, but as a founding commitment. This project is made and shared with love. If you want to fork it, go ahead — we actively encourage it. In fact, one of the best ways to work on a fork of totopo is to use totopo itself: clone the repo, start a secure session, and build the next version from within the safety of the tool you are improving.

---

## How It Works

```
You run: totopo (from anywhere inside your repo)

totopo detects context:
├── Walks up directory tree to find git repo root
│   ├── .totopo/ found at root → doctor check → main menu
│   └── .totopo/ not found → onboarding flow
│       ├── Git repo → initialize .totopo/ at repo root
│       └── Not a git repo → explain requirement, offer to run git init
│
Main menu:
├── Start dev session
├── Stop dev session
├── Rebuild dev container
├── Settings
├── Check for updates
├── Uninstall totopo
└── About

Dev session:
├── Docker container starts (or resumes)
├── Terminal drops into container via SSH
├── AI tools ready: claude, kilo, opencode
├── Git remotes: unreachable (blocked at system level)
├── Host filesystem: invisible beyond repo root
└── Internet: available for AI API calls
```

---

## The Doctor Command

Before every session start, totopo runs a silent doctor check. If everything is healthy the user never sees it. If something is wrong, totopo stops and explains exactly what is broken and how to fix it.

What the doctor checks:

- Docker is installed and running
- DevPod is installed and has a provider configured
- `.totopo/` config exists and has not been corrupted
- Dockerfile and devcontainer config are present
- Container image has been built (or offers to build it)
- Security controls are active (non-root user, git protocol block)
- API keys are set (warning only — session can proceed without them)

Example output when something is wrong:

```
  ╭─────────────────────────────────╮
  │  totopo — doctor check           │
  ╰─────────────────────────────────╯

  ✔ Docker is running
  ✔ DevPod is installed
  ✔ totopo config found at repo root
  ✘ Docker image not built yet

  The dev container image needs to be built before starting a session.
  This usually takes 2-3 minutes and only happens once.

  ◆ Build it now?
    ● Yes
    ○ No
```

The doctor command can also be run manually at any time via the totopo menu or `totopo doctor`.

---

## The Developer Experience

The first time a developer uses totopo in a new project:

```
$ totopo

  ╭─────────────────────────────────╮
  │  totopo — Secure AI Box   v1.0   │
  ╰─────────────────────────────────╯

  No totopo setup found in this repo.
  Let's get you started.

  ✔ Git repository detected
  ✔ Docker is running
  ✔ DevPod is installed


  ◆ Would you like to configure your AI API keys now?
    You can skip this and set them later via totopo → Settings.
    ○ Yes, set them now
    ● Skip for now

  ├ Creating .totopo/ ..............  ✔
  ├ Writing Dockerfile .............  ✔
  ├ Writing devcontainer config ....  ✔
  ├ Building Docker image ..........  ✔  (this may take a few minutes)
  ├ Running security checks ........  ✔
  ╰ Done

  Your secure AI dev environment is ready.
  Run totopo to start a session anytime.
```

Every subsequent session:

```
$ totopo

  ╭─────────────────────────────────╮
  │  totopo — Secure AI Box   v1.0   │
  ╰─────────────────────────────────╯

  my-app  ✔ ready

  ◆ What would you like to do?
    ● Start dev session
    ○ Stop dev session
    ○ Rebuild dev container
    ○ Settings
    ○ About
```

If no API keys are configured, every session start shows a gentle reminder — the session continues uninterrupted:

```
  ⚠  No API keys configured.
     AI tools are installed but will not authenticate without keys.
     Go to Settings → API Keys to add them.
```

The experience is fast and clear. Developers who want to understand exactly what is happening can — every action totopo takes is logged and the source code is one command away.

---

## What totopo Installs in the Container

Every totopo dev container includes the same curated set of tools — no configuration required:

**AI coding assistants (always included)**

- Claude Code (Anthropic)
- Kilo AI
- OpenCode

**Runtimes**

- Node.js + npm + pnpm
- Python
- Java
- Go
- Rust
- Bash, curl, git, jq, and standard Unix tools

**Security controls (non-negotiable, always on)**

- Non-root user inside container
- Git remote transport blocked at system level
- No host filesystem access beyond repo root
- No credential forwarding from host
- No privilege escalation

Future versions will offer container presets (minimal, frontend, backend, fullstack) so developers can choose a leaner image when they do not need all runtimes.

---

## What totopo Will Never Do

- Modify files outside your repo directory
- Push, fetch, or pull from any git remote inside the container
- Collect telemetry or usage data
- Require a paid subscription or account for any feature, ever
- Hide what it is doing from the developer
- Close its source code

---

## Roadmap

**v1 — Foundation**
The working setup we have today: Docker-based dev container, AI tools pre-installed, git remote blocked, totopo CLI initializes and manages sessions.

**v2 — Distribution**
Published as an npm package (`npx totopo`). Doctor command. Onboarding flow. Modern terminal UI. Works in any repo with one command.

**v3 — Presets & Teams**
Container presets (minimal, frontend, fullstack). Team-shareable totopo config committed to repo. Shared `.totopo/` directory that works across the team without exposing individual API keys.

**v4 — Ecosystem**
Plugin system for additional AI tools. Community-contributed container presets. Video documentation and public website.

---

## Why Open Source?

A tool that sits between a developer and their AI agent — controlling what the agent can access, what it can do, and how it is isolated — must be fully auditable. Trust requires transparency.

totopo will always be open source. Not as a promise that could be walked back, but as the only version of this project that will ever exist. There is no private version. There is no enterprise tier with additional features. What you see is everything.

Fork it. Improve it. Build something new from it. That is exactly what it is here for.

---

## Get Involved

totopo is in early development. The foundation works. The vision is clear. If you believe developers deserve better defaults for AI tool safety, contributions are welcome.

- Read the code
- Report issues
- Suggest improvements
- Fork it and build your own version — use totopo to do it safely
- Share it with developers who are running AI agents without isolation today
