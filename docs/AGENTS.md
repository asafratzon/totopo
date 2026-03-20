# AGENTS.md — totopo session instructions

## Every session start

1. Read this file
2. Read `docs/ROADMAP.md` → summarise where we left off and what comes next, ask before starting.

## Project

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| What          | `totopo` — CLI for secure, isolated local AI agent development |
| Current state | `README.md`                                                    |
| Progress      | `docs/ROADMAP.md`                                              |

## Tech stack

| Layer              | Tool                          |
| ------------------ | ----------------------------- |
| Entry point        | `bin/totopo.js` (Node.js ESM) |
| Commands           | `src/core/commands/*.ts` via tsx |
| Shared lib         | `src/core/lib/*.ts` via tsx   |
| Release tooling    | `src/releases/*.ts` via tsx   |
| Terminal UI        | `@clack/prompts`              |
| Container          | Docker                        |
| Runtime / packages | Node.js + pnpm                |
| Lint / format      | Biome                         |

## Rules

- **Security is non-negotiable** — never weaken container isolation; explain security implications of any change touching isolation, git config, or permissions
- `bin/totopo.js` is the entry point — CLI logic lives in `src/core/commands/*.ts` and `src/core/lib/*.ts`; release tooling in `src/releases/*.ts`
- All totopo config in `.totopo/`
- Propose before implementing anything non-trivial
- **Never commit without explicit user instruction** — during work, ask "ready to commit?" if it feels like a natural point; only commit when the user says so
- One task at a time — complete and verify before moving on
- Keep `ROADMAP.md` honest — update it when scope changes rather than forcing the original plan
- For releases, follow `docs/RELEASES.md` for versioning, changelog format, and publish checklist
- Never suggest docker commands to the user — interactions happen exclusively through the totopo menu (start/stop/reset/rebuild)
- On every session start, totopo writes a context file into each agent's global config dir (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/.codex/AGENTS.md`) — these files are managed by totopo; do not edit them

## Architecture

Two distinct concerns — keep them separate:

```
1. totopo PACKAGE (this repo — distributed via npx)
├── bin/
│   └── totopo.js      ← entry point; imports compiled commands from dist/
├── dist/              ← compiled output of src/core/ (generated; not committed)
│   ├── commands/      ← compiled command modules
│   └── lib/           ← compiled shared utilities
├── src/
│   ├── core/          ← TypeScript source (compiled to dist/; not shipped directly)
│   │   ├── commands/  ← command modules imported by bin/totopo.js
│   │   │   ├── dev.ts
│   │   │   ├── doctor.ts
│   │   │   ├── manage.ts          ← manage workspaces submenu (stop/remove/uninstall)
│   │   │   ├── menu.ts
│   │   │   ├── onboard.ts
│   │   │   ├── rebuild.ts         ← remove image to force a fresh build on next start
│   │   │   ├── settings.ts        ← settings menu (mode switch + tool selection)
│   │   │   ├── stop.ts
│   │   │   └── sync-dockerfile.ts ← silent pre-flight: regenerate Dockerfile if stale
│   │   └── lib/                   ← shared utilities imported by commands
│   │       ├── config.ts          ← read/write .totopo/settings.json
│   │       ├── detect-host.ts     ← detect host runtime versions
│   │       ├── generate-dockerfile.ts  ← generate Dockerfile (full or host-mirror)
│   │       └── select-tools.ts    ← multiselect UI for runtime tool selection
│   └── releases/                  ← developer release tooling (NOT in npm package)
│       ├── rc.ts
│       ├── release.ts
│       ├── check.ts               ← pre-release health checks (validates changelog.yaml)
│       ├── sync-github-releases.ts
│       ├── changelog-utils.ts
│       ├── generate-changelog.ts
│       └── changelog.yaml         ← source of truth for all release notes
└── templates/                     ← copied into user's .totopo/ during onboarding
    ├── Dockerfile
    ├── post-start.mjs
    └── env

2. USER'S PROJECT (any git repo where totopo is used)
└── .totopo/            ← created by onboarding; config only, no scripts
    ├── Dockerfile     (regenerated on session start in host-mirror mode)
    ├── post-start.mjs
    └── settings.json  (runtimeMode + selectedTools; committed with project)

~/.totopo/.env          ← API keys; global, outside all repos, never mounted into container
```

`bin/totopo.js` computes `packageDir` (where the package is installed) and
`repoRoot` (git root of `$PWD`) once at startup and passes them as direct
arguments to each command.

Published npm package ships: `bin/`, `dist/`, `templates/`, `LICENSE`.
Build step (`pnpm build`) runs automatically as part of `pnpm rc` before publish.
