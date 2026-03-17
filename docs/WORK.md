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

- **Selective scope improvements** — two enhancements to `promptSelectivePaths()` in `dev.ts`:
  - *Show hidden files/dirs* — currently all dotfiles/dotdirs are filtered out - they should all be visible always in mutliselect.
  - *Select by path* — for selective options, add an optional text input ("add specific paths, comma-separated, e.g. src/auth, src/db/migrations") for targeting deeply nested files or dirs not reachable from the top-level picker; validate each path exists before proceeding; combines with (does not replace) the visual multiselect

## Upcoming

Brief descriptions for planning; each is input for plan mode before we decide to work on it.

- **Tree multiselect for selective scope** — replace the current two-step flow (multiselect + freeform text input) in `promptSelectivePaths()` with a single recursive/expandable tree picker, so the user can drill into nested directories inline without having to type paths from memory. `@clack/prompts` doesn't support this natively — will require either a custom readline/ANSI component or a suitable third-party library. A lighter interim option would be autocomplete/fuzzy search across all paths (e.g. type `src/` to get completions).

- **Agent context injection for AGENTS.md** — extend `buildAgentContextDoc()` in `dev.ts` to also read and inject `AGENTS.md` from the repo root (alongside CLAUDE.md). The function already accepts scope context; this is a straightforward extension to include a second source file. Also expand the injected context to explicitly tell the agent: (1) whether git is available (only in repo scope — cwd/selective scopes do not mount `.git` because doing so would allow the agent to read the full commit history of files outside its mount via `git show`, defeating the security boundary); (2) instruct the agent to surface its scope and limitations to the user at the start of every session, so the user is always aware of what the agent can and cannot access.

- **Stop / Remove overhaul** — rework the stop and removal experience as two distinct menu entries:
  - **Stop** — only shown in the main menu when at least one `totopo-managed-*` container is running; if multiple are running, show a multiselect so the user can pick which to stop (single running container skips the picker and shows confirmation prompt so user know which is being stopped).
  - **Remove** — always visible in the main menu; leads to a submenu with two options:
    - *Remove container images* — multiselect of all `totopo-managed-*` images on the host, each labelled with its workspace name in parentheses; stops any running containers for selected images before removing.
    - *Uninstall totopo from this project* — confirms with the user, then: stops all containers belonging to this project, removes their images (label-based, project-scoped only), and deletes `.totopo/` from the repo root. Does not touch other projects.
  - The existing Reset option (wipe all workspaces + images) should be removed.

- **Settings submenu** — view/edit API keys, check for updates

- **Docs** — polish README for npm page (install, quickstart, security model); contribution guide

- **Troubleshoot/help menu option** — refer to pacakge docs in repo root, and invite to open issues if encountered.

- **Tech choices review** — audit tech decisions across the package, dev container, and repo; output a DECISIONS.md explaining rationale for each major choice

- **Security status review** — assess current security posture, gaps, and tradeoffs; output a SECURITY.md as a concise reference

- **Terminal output review** — review and refine all terminal printings across every flow for consistency, clarity, and polish, including more detailed container status.

- **Autostart agent** - improved experience upon connecting to the dev container so user could during onboarding decide if he want to auto start specific agent (claude/opencode/kilo etc.).

- **README illustrations** — add visuals to README.md using Google's Banana Pro AI.

- **Compiled JS entry point (Option C)** — replace `bin/totopo.js` (which shells out to `tsx` at runtime) with a compiled TypeScript pipeline: add a `build` script (`tsc` compiles `src/core/` → `dist/`), point `bin` at `dist/bin/totopo.js`, move `tsx` to devDependencies, and update the release workflow to build before publish. Each command becomes an exported `async function` rather than a standalone script. Gains: ~200–400 ms faster startup, no runtime `tsx` dependency, fully cross-platform. Cost: refactor all commands from top-level-await scripts into importable modules; add build step to CI/release flow.
