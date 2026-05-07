# AGENTS.md

Guidance for AI agents working in this repository.

## What is totopo

totopo (`npx totopo`) runs AI coding agents in an isolated Docker container per workspace. It manages workspace lifecycle: onboarding, container builds, profile selection, shadow path isolation, agent context injection, and persistent agent memory.

Key concepts (the vocabulary used everywhere):
- **Workspace** — a directory containing `totopo.yaml`. The `workspace_id` field drives container naming (`totopo-<id>`) and the cache dir (`~/.totopo/workspaces/<id>/`).
- **Profile** — a named Dockerfile variant in `totopo.yaml`. Its `dockerfile_hook` is appended to the base image. One profile is active per session.
- **Shadow path** — a gitignore-style pattern in `totopo.yaml`. Matching host paths are overlaid with empty container-local copies so agents never see or modify them.
- **Agent context** — markdown injected into each AI CLI's config dir at session start. Bind-mounted into the container; not edited by hand.

## Workflow

After editing `src/`, run `pnpm lint:fix` then `pnpm check`. Ask the user to run `pnpm start` on the host — Docker is not available inside the container. If `pnpm check` auto-fixes divider lines it will fail; review the diff, re-stage, and run again. Available `pnpm` scripts are listed in `package.json`.

## Coding conventions

- **ESM with `.js` extensions** in all TypeScript imports (Node.js nodenext resolution requirement)
- **Plain ASCII in comments** — no Unicode arrows or em dashes. Use `->` not the Unicode arrow, `-` not em dash
- **Comment lines start with a capital letter**
- **Biome formatting:** 140 char line width, 4-space indent, double quotes
- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Comment divider lines** must be exactly 141 chars (prefix `// ` + 138 `=` or `-`); enforced by `scripts/check.ts`

## Migration convention

`src/lib/migrate-to-latest.ts` transforms old structures (A) into the current one (B):
- **A paths** (source) — hardcode as string literals so the migration still finds the old location if a constant changes later.
- **B paths** (destination) — use constants from `constants.ts`.

## Security boundaries (non-negotiable)

Container isolation is the product. Never weaken:
- Default git mode (`local`) blocks remote operations via `protocol.allow = never` while allowing local mutations. `strict` additionally blocks mutating subcommands via the read-only wrapper. Only user-opt-in `unrestricted` lifts the remote block — never bypass in code.
- Non-root user (`devuser` uid 1001), `no-new-privileges:true`, no host credentials inside the container, only the workspace directory is mounted.

## Rules

- Never commit without explicit user instruction
- Never edit `scripts/changelog.yaml` without explicit user approval
- Read `ROADMAP.md` at session start to understand current state and open items

## Skills

Skills live in `.claude/skills/`. `.agents/skills/` contains symlinks — edit only the `.claude/skills/` versions.

## Release process

RC development happens on a dedicated branch (e.g. `v3.1.0-rc-development`), not on `main`. `main` always points to the latest stable release. The source of truth for release notes is `scripts/changelog.yaml` (`CHANGELOG.md` is generated from it). RC entries are cumulative — describe the full release, not delta from previous RC. Use the `/release` skill to prepare; publishing and git push happen on the host via `pnpm release`.
