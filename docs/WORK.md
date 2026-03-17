# WORK.md — totopo progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
totopo PACKAGE (this repo — distributed via npx in future)
├── bin/
│   └── totopo.js      ← entry point (run from user's project directory)
├── src/
│   ├── core/          ← user-facing CLI (included in npm package)
│   │   ├── commands/  ← entry points invoked by bin/totopo.js
│   │   │   ├── dev.ts
│   │   │   ├── doctor.ts
│   │   │   ├── menu.ts
│   │   │   ├── onboard.ts
│   │   │   ├── reset.ts
│   │   │   ├── settings.ts    ← settings menu (mode switch + tool selection)
│   │   │   ├── stop.ts
│   │   │   └── sync-dockerfile.ts ← silent pre-flight: regenerate Dockerfile if stale
│   │   └── lib/       ← shared utilities imported by commands
│   │       ├── config.ts          ← read/write .totopo/settings.json
│   │       ├── detect-host.ts     ← detect host runtime versions
│   │       ├── generate-dockerfile.ts  ← generate Dockerfile (full or host-mirror)
│   │       └── select-tools.ts    ← multiselect UI for runtime tool selection
│   └── releases/      ← developer release tooling (NOT in npm package)
│       ├── rc.ts
│       ├── release.ts
│       ├── sync-github-releases.ts
│       ├── changelog-utils.ts
│       ├── generate-changelog.ts
│       └── changelog.yaml   ← source of truth for all release notes
└── templates/         ← copied into user's .totopo/ during onboarding
    ├── Dockerfile
    ├── post-start.mjs
    └── env

USER'S PROJECT (any git repo where totopo is used)
└── .totopo/            ← created by onboarding; config only, no scripts
    ├── .env           (gitignored — API keys)
    ├── Dockerfile     (regenerated on session start in host-mirror mode)
    ├── post-start.mjs
    └── settings.json  (runtimeMode + selectedTools; committed with project)
```

`bin/totopo.js` sets `TOTOPO_PACKAGE_DIR` (where the package is installed) and
`TOTOPO_REPO_ROOT` (git root of `$PWD`) and exports them so commands don't
recompute paths.

---

## Working Now

_Nothing in progress._

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **Agent context injection for AGENTS.md** — extend `buildAgentContextDoc()` in `dev.ts` to also read and inject `AGENTS.md` from the repo root (alongside CLAUDE.md). The function already accepts scope context; this is a straightforward extension to include a second source file.

- **Stop: select which workspace** — when multiple workspaces are running, let the user choose which to stop (related to workspace scoping but implemented separately)

- **Settings submenu** — view/edit API keys, check for updates, uninstall (remove `.totopo/` and stop container)

- **Docs** — polish README for npm page (install, quickstart, security model); contribution guide

- **Troubleshoot/help menu option** — refer to pacakge docs in repo root, and invite to open issues if encountered.

- **Tech choices review** — audit tech decisions across the package, dev container, and repo; output a DECISIONS.md explaining rationale for each major choice

- **Security status review** — assess current security posture, gaps, and tradeoffs; output a SECURITY.md as a concise reference

- **Terminal output review** — review and refine all terminal printings across every flow for consistency, clarity, and polish, including more detailed container status.

- **Autostart agent** - improved experience upon connecting to the dev container so user could during onboarding decide if he want to auto start specific agent (claude/opencode/kilo etc.).

- **README illustrations** — add visuals to README.md using Google's Banana Pro AI.

- **Compiled JS entry point (Option C)** — replace `bin/totopo.js` (which shells out to `tsx` at runtime) with a compiled TypeScript pipeline: add a `build` script (`tsc` compiles `src/core/` → `dist/`), point `bin` at `dist/bin/totopo.js`, move `tsx` to devDependencies, and update the release workflow to build before publish. Each command becomes an exported `async function` rather than a standalone script. Gains: ~200–400 ms faster startup, no runtime `tsx` dependency, fully cross-platform. Cost: refactor all commands from top-level-await scripts into importable modules; add build step to CI/release flow.
