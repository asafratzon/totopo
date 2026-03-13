# .totopo — Security & Configuration Reference

This directory contains everything that defines and secures the dev container. It is designed to be self-contained — when copying this template to a real project, copy the entire `.totopo/` directory as-is.

---

## Files

| File                | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `Dockerfile`        | Builds the image: Node 22, AI tools, git protocol block, non-root user                   |
| `devcontainer.json` | Container config: workspace mount, startup hook, security options                        |
| `post-start.mjs`    | Runs on every container start — validates security controls and prints readiness summary |
| `.env`              | API keys injected at runtime — never baked into the image                                |

---

## Security Model

### Non-root user

The container runs as `devuser` (uid 1001). Root is never available during normal use. This means system-level files like `/etc/gitconfig` cannot be modified from within a container session.

### Git remote block

Enforced via git's own system-level configuration in `/etc/gitconfig`:

```
protocol.allow = never
protocol.file.allow = always
```

This blocks all remote transport (https, ssh, git://) at the git layer — not via a PATH wrapper or script. Any call to git, including direct calls to `/usr/bin/git`, will be refused for remote operations. Local operations (commit, branch, log, diff) work normally.

To verify it is active inside the container:

```bash
git config --system protocol.allow   # → never
git push                              # → fatal: transport 'https' not allowed
```

The only way to override this is to write to `/etc/gitconfig`, which requires root. `devuser` cannot do this.

### No credentials forwarded

`devcontainer.json` sets `gitCredentialHelperConfigLocation: none` — host git credentials are never copied into the container.

### Filesystem isolation

Only the repo is bind-mounted to `/workspace`. Nothing else on the host filesystem is accessible.

### No privilege escalation

`securityOpt: no-new-privileges:true` prevents any process inside the container from gaining elevated permissions.

### Secrets never in image

API keys are passed at runtime via `--env-file .totopo/.env`. They are never written into the image layers.

---

## Startup Check

`post-start.mjs` runs automatically on every container start via `postStartCommand`. It validates:

1. Running as non-root
2. Git protocol block is active in `/etc/gitconfig`
3. `git push` is functionally blocked
4. All AI tools are installed and reachable
5. Node.js and npm are available
6. API keys are set (warning only — does not fail)

Any failed check exits with a non-zero code, surfacing a readable error. Re-run manually anytime:

```bash
status
```

---

## AI Tools Installed

| Command    | Package                     | Provider  |
| ---------- | --------------------------- | --------- |
| `claude`   | `@anthropic-ai/claude-code` | Anthropic |
| `kilo`     | `@kilocode/cli`             | Kilo AI   |
| `opencode` | `opencode-ai`               | OpenCode  |

Tools are installed globally during image build. Do not install or update them manually inside a running container — changes will not persist. To update a tool, bump its version in the `Dockerfile` and rebuild with `devpod up . --recreate`.

---

## Copying to a Real Project

1. Copy the entire `.totopo/` directory to your project root
2. **Add `.totopo/.env` to that project's `.gitignore`** — in this template repo the `.env` is committed intentionally (it only contains placeholder values). In a real project with real keys it must never be committed
3. Fill in real API keys in `.totopo/.env`
4. Run `devpod up . --recreate` to build the image
