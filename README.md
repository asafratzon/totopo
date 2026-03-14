# Secure AI Dev Environment

A reusable, hardened development container template for Next.js projects with AI coding assistants (Claude, Kilo, OpenCode).

## Status

⚠️ This package is currently in **early development (v0.1)** and is considered **experimental**. The API, behavior, and internal structure may change without notice as the project evolves. It is published primarily for exploration and early feedback, and should **not yet be relied upon in production environments**.

## How It Works

Your code and VSCodium stay on your host machine as normal. The AI tools and all development activity run inside an isolated Docker container, connected to your terminal via SSH.

**DevPod** is the glue — it reads the `.totopo/` configuration, builds the Docker image, manages the container lifecycle, and sets up the SSH tunnel so your terminal session lands inside the container automatically.

```
Host machine
├── VSCodium          → edits files normally (bind-mounted from container)
├── terminal          → SSH'd into container via DevPod
│   ├── claude        → AI tools run here, isolated
│   ├── kilo
│   └── opencode
└── git push/pull     → only possible from host, blocked inside container
```

`./ai.sh` is the single entry point — it lets you start or stop the container.

---

## Repository Structure

```
.
├── .totopo/
│   ├── .env                # API keys — fill in before first start
│   ├── Dockerfile          # Image: Node 22, AI tools, git protocol block
│   ├── devcontainer.json   # Dev container config: mounts, startup hook
│   ├── post-start.mjs      # Security checks + readiness output on every start
│   └── README.md           # Security model details
├── scripts/                # totopo logic — not copied to user projects
│   ├── dev.ts
│   ├── stop.ts
│   ├── reset.ts
│   ├── doctor.ts
│   └── onboard.ts
├── templates/              # Copied into user's .totopo/ during onboarding
│   ├── Dockerfile
│   ├── devcontainer.json
│   ├── post-start.mjs
│   └── env
├── .gitignore
├── ai.sh                   # Entry point — run from your project directory
└── README.md               # This file
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [DevPod CLI](https://devpod.sh/docs/getting-started/install)

### One-time DevPod setup

After installing the DevPod CLI, register Docker as the backend provider:

```bash
devpod provider add docker
```

This only needs to be done once per machine.

---

## Quick Start

### 1. Fill in your API keys

Edit `.totopo/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
KILO_API_KEY=your-kilo-key-here
```

### 2. Start the container

```bash
./ai.sh
```

Select **Start session**. First run builds the image (a few minutes). Subsequent starts are fast.

### 3. Verify startup

Security checks run automatically on every start. Re-run anytime from inside the container:

```bash
status
```

### 4. Stop the container

```bash
./ai.sh
```

Select **Stop all**.

---

## Container Management

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `./ai.sh`         | Start, stop, or reset the container          |
| `./ai.sh` → Reset | Wipe all workspaces + images and start fresh |
| `devpod list`     | List active workspaces                       |

---

## AI Tools

Run inside the container terminal:

```bash
claude      # Claude Code (Anthropic)
kilo        # Kilo AI
opencode    # OpenCode
status      # Re-run security + readiness check
```

---

## Security Model

| Control                  | Implementation                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Non-root user            | All processes run as `devuser` (uid 1001)                                                         |
| Filesystem isolation     | Only the repo is mounted — host is not visible                                                    |
| Git remote block         | `protocol.allow never` in `/etc/gitconfig` — enforced at the git layer, requires root to override |
| No credentials forwarded | `gitCredentialHelperConfigLocation: none` in devcontainer.json                                    |
| No privilege escalation  | `no-new-privileges:true` security opt                                                             |
| Secrets never in image   | API keys injected at runtime via `.env` only                                                      |

Remote git operations are blocked inside the container. Push from your host terminal instead.

See `.totopo/README.md` for full details.

---

## Git Workflow

```bash
# Inside container — local operations ✅
git add .
git commit -m "message"
git log / diff / branch

# Remote operations — host terminal only 🚫 blocked inside container
git push / pull / fetch
```

---

## Using This Template

When using totopo in a real project, run `ai.sh` from your project directory — the onboarding flow will create `.totopo/` automatically. You do not need to copy `scripts/` — those stay with the totopo package.

---

## Troubleshooting

**Container fails to start** — the startup check prints exactly which check failed and why.

**API key warnings** — check `.totopo/.env` has the correct variable names, then run `devpod up . --recreate`.

**AI tool not found** — rebuild with `devpod up . --recreate`. Do not install tools manually inside a running container as changes won't persist.

