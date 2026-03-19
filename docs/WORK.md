# WORK.md — totopo progress tracker

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
    ├── .env           (gitignored — API keys)
    ├── Dockerfile     (regenerated on session start in host-mirror mode)
    ├── post-start.mjs
    └── settings.json  (runtimeMode + selectedTools; committed with project)
```

`bin/totopo.js` sets `TOTOPO_PACKAGE_DIR` (where the package is installed) and
`TOTOPO_REPO_ROOT` (git root of `$PWD`) and exports them so commands don't
recompute paths.

Published npm package ships: `bin/`, `dist/`, `templates/`, `LICENSE`.
Build step (`pnpm build`) runs automatically as part of `pnpm rc` before publish.

---

## Working Now

_(nothing active)_

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **Agent context injection for AGENTS.md** — extend `buildAgentContextDoc()` in `dev.ts` to also read and inject `AGENTS.md` from the repo root (alongside CLAUDE.md). The function already accepts scope context; this is a straightforward extension to include a second source file. Also expand the injected context to explicitly tell the agent: (1) whether git is available (only in repo scope — cwd/selective scopes do not mount `.git` because doing so would allow the agent to read the full commit history of files outside its mount via `git show`, defeating the security boundary); (2) instruct the agent to surface its scope and limitations to the user at the start of every session, so the user is always aware of what the agent can and cannot access.

- **Tech choices and Security review** — audit tech decisions across the package, dev container, and repo; assess current security posture, gaps, and tradeoffs output a DECISIONS.md explaining rationale for each major choice.

- **README illustrations** — add visuals to README.md using Google's Banana Pro AI.
