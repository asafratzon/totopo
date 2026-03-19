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
    ├── Dockerfile     (regenerated on session start in host-mirror mode)
    ├── post-start.mjs
    └── settings.json  (runtimeMode + selectedTools; committed with project)

~/.totopo/.env          ← API keys; global, outside all repos, never mounted into container
```

`bin/totopo.js` sets `TOTOPO_PACKAGE_DIR` (where the package is installed) and
`TOTOPO_REPO_ROOT` (git root of `$PWD`) and exports them so commands don't
recompute paths.

Published npm package ships: `bin/`, `dist/`, `templates/`, `LICENSE`.
Build step (`pnpm build`) runs automatically as part of `pnpm rc` before publish.

---

## Working Now

Testing 0.9.0-rc-2 — awaiting results.

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **0.9.0 release** — once rc-2 passes testing, squash in_progress entries and publish 0.9.0.
- **Package README + illustrations** — explain tech choices and security review: audit tech decisions across the package, dev container, and repo; assess current security posture, gaps, and tradeoffs. Add visuals to README.md.


