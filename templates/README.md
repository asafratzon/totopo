# .totopo — Reference

Created by `npx totopo`. Manages the secure dev container for this project.

---

## Files

| File             | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `Dockerfile`     | Builds the container image                                 |
| `post-start.mjs` | Runs on every start — security checks + readiness summary  |
| `settings.json`  | Runtime mode + selected tools (committed with project)     |
| `agents/`        | Agent session data — created on first session start        |

---

## agents/

Initialised automatically the first time you run a dev session. Contains
per-tool subdirectories for each supported agent, mounted into the container
so session history and conversation data persist across rebuilds:

```
agents/claude/           → ~/.claude/                    (Claude Code)
agents/opencode/config/  → ~/.config/opencode/           (OpenCode)
agents/opencode/data/    → ~/.local/share/opencode/
agents/codex/            → ~/.codex/                     (Codex)
```

Context files (`CLAUDE.md` / `AGENTS.md`) are written into these directories
by totopo on every session start and overwritten automatically — do not edit them.

`agents/` is gitignored — session data stays local to this machine.

To reset agent memory: **Advanced → Clear agent memory** from the totopo menu.

---

## Security model

- **Non-root user** (`devuser`, uid 1001) — cannot modify system-level config
- **Git remote access blocked** via `protocol.allow = never` in `/etc/gitconfig` — push, pull, fetch, and clone are all refused; local operations work normally
- **No host credentials forwarded** — host git credentials are never copied into the container
- **API keys passed at runtime** via `--env-file ~/.totopo/.env` — never baked into the image and never mounted into the container
- **No privilege escalation** — `no-new-privileges:true` prevents any process from gaining elevated permissions

---

## AI tools

| Command    | Package                     |
| ---------- | --------------------------- |
| `opencode` | `opencode-ai`               |
| `claude`   | `@anthropic-ai/claude-code` |
| `codex`    | `@openai/codex`             |

Tools are installed during image build. To update a tool version: edit `Dockerfile`,
then use **Advanced → Rebuild container** from the totopo menu.

---

## Startup check

`post-start.mjs` runs on every container start and validates:

1. Running as non-root
2. Git remote block active in `/etc/gitconfig`
3. `git push` functionally blocked
4. All AI tools installed and reachable

Re-run manually anytime from inside the container:

```bash
status
```
