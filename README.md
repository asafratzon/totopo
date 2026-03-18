# totopo

Spin up a secure, isolated AI coding environment in any git project — in one command.

## Status

⚠️ **Early development (pre-1.0)** — experimental. API and behavior may change. Not yet recommended for production use.

## How It Works

`npx totopo` sets up a hardened Docker container in your project with AI coding assistants (Claude, Kilo, OpenCode) pre-installed. Your code stays on your host machine. The AI tools run isolated inside the container.

```
Host machine
├── your editor       → edits files normally (bind-mounted from container)
├── terminal          → connected to container via docker exec
│   ├── claude        → AI tools run here, isolated
│   ├── kilo
│   └── opencode
└── git push/pull     → only possible from host, blocked inside container
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

---

## Quick Start

### 1. Run totopo in your project directory

```bash
cd your-project
npx totopo
```

If `.totopo/` doesn't exist yet, the onboarding flow runs automatically — it creates the container config, prompts for API keys, and updates `.gitignore`.

### 2. Start the container

Select **Start session** from the menu. The first run builds the Docker image (a few minutes). Subsequent starts are fast.

### 3. Verify

Security checks run automatically on every container start. Re-run anytime from inside the container:

```bash
status
```

### 4. Stop

Run `npx totopo` again and select **Stop**.

---

## What gets created in your project

```
your-project/
└── .totopo/
    ├── .env              # API keys — gitignored, never committed
    ├── Dockerfile        # Container image definition
    └── post-start.mjs   # Security + readiness check on every start
```

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
| No privilege escalation  | `no-new-privileges:true` security opt                                                             |
| Secrets never in image   | API keys injected at runtime via `.env` only                                                      |

Remote git operations are blocked inside the container. Push from your host terminal instead.

See `docs/VISION.md` for full details on the security model.

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

## Limitations

**No audio / microphone support** — the container has no access to host audio devices. Features that require microphone input (e.g. Claude Code's `/voice` mode) will not work inside the container.

---

## Troubleshooting

**Container fails to start** — the startup check prints exactly which check failed and why.

**API key warnings** — check `.totopo/.env` has the correct variable names, then use **Rebuild** from the totopo menu to rebuild the container.

**AI tool not found** — use **Rebuild** from the totopo menu to rebuild the container image. Do not install tools manually inside a running container as changes won't persist.
