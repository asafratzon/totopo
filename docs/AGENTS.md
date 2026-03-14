# AGENTS.md — totopo session instructions

## Every session start

1. Read this file
2. Read `docs/INBOX.md` (if it exists) → action any notes left there, then clear the file
3. Read `docs/WORK.md` → summarise where we left off and what comes next, ask before starting
   - If `WORK.md` missing: read `README.md` + `docs/VISION.md`, propose breakdown, wait for approval

## Every session end

Update `docs/WORK.md` (check off done items, add discovered sub-tasks), then ask the user if they want to commit before sending the checkpoint message.

## Checkpoint message

Use this exact format — signals context is saved and container restart is safe:

```
CHECKPOINT

Done:      - …
Verify:    - …
Next:      - …

Safe to restart the container.
```

Never declare a checkpoint if the codebase is broken or half-migrated.

## Environment

- Claude Code runs **inside the dev container**; user SSHs in from host terminal
- Repo is bind-mounted — edits are immediately visible on the host
- Remote git (push/pull/fetch) is **blocked inside the container** — user pushes from host
- Never suggest devpod or docker commands directly — users interact exclusively through the totopo menu (start/stop/reset)

## Project

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| What          | `totopo` — CLI for secure, isolated local AI agent development |
| Vision        | `docs/VISION.md`                                               |
| Current state | `README.md`                                                    |
| Progress      | `docs/WORK.md`                                                 |

## Tech stack

| Layer              | Tool                          |
| ------------------ | ----------------------------- |
| Entry point        | `ai.sh` (bash — keep minimal) |
| Scripts            | `scripts/*.ts` via tsx        |
| Terminal UI        | `@clack/prompts`              |
| Container          | Docker + DevPod               |
| Runtime / packages | Node.js + pnpm                |
| Lint / format      | Biome                         |

## Rules

- **Security is non-negotiable** — never weaken container isolation; explain security implications of any change touching isolation, git config, or permissions
- `ai.sh` is the only bash file — all logic lives in `scripts/*.ts`
- All totopo config in `.totopo/` — DevPod always gets `--devcontainer-path .totopo/devcontainer.json`
- Propose before implementing anything non-trivial
- **Never commit without explicit user instruction** — during work, ask "ready to commit?" if it feels like a natural point; only commit when the user says so
- One task at a time — complete and verify before moving on
- Keep `WORK.md` honest — update it when scope changes rather than forcing the original plan
- For releases, follow `docs/RELEASES.md` for versioning, changelog format, and publish checklist
