# WORK.md — totopo progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
totopo PACKAGE (this repo — distributed via npx in future)
├── ai.sh              ← entry point (run from user's project directory)
├── src/
│   ├── core/          ← user-facing CLI (included in npm package)
│   │   ├── dev.ts
│   │   ├── doctor.ts
│   │   ├── menu.ts
│   │   ├── onboard.ts
│   │   ├── reset.ts
│   │   └── stop.ts
│   └── releases/      ← developer release tooling (NOT in npm package)
│       ├── rc.ts
│       ├── release.ts
│       ├── sync-github-releases.ts
│       ├── changelog-utils.ts
│       ├── generate-changelog.ts
│       └── changelog.yaml   ← source of truth for all release notes
└── templates/         ← copied into user's .totopo/ during onboarding
    ├── Dockerfile
    ├── devcontainer.json
    ├── post-start.mjs
    └── env

USER'S PROJECT (any git repo where totopo is used)
└── .totopo/            ← created by onboarding; config only, no scripts
    ├── .env           (gitignored — API keys)
    ├── Dockerfile
    ├── devcontainer.json
    └── post-start.mjs
```

`ai.sh` sets `TOTOPO_PACKAGE_DIR` (where ai.sh lives) and `TOTOPO_REPO_ROOT`
(git root of `$PWD`) and exports them so scripts don't recompute paths.

---

## Completed

- **Phase 1** — Migrate config to `.totopo/` ✅
- **Phase 2** — Doctor command (Docker, DevPod, provider checks; silent pre-menu, verbose on demand) ✅
- **Phase 3** — Clean package vs project separation; `scripts/` stays with totopo, `templates/` copied to user projects ✅
- **Phase 4** — Onboarding flow: detects missing `.totopo/`, copies templates, substitutes project name, creates `.env`, updates `.gitignore` ✅
- **Phase 5** — Post-onboarding fixes: macOS compat, push-blocked test fix, existing workspace detection ✅
- **Phase 6** — Port cleanup + `totopo-<project>` workspace naming ✅
- **Phase 7** — Main menu UX: clack-based interactive menu, status box, project name, API key indicator ✅
- **Phase 8** — TypeScript + pnpm + Biome toolchain; cross-platform binaries; `@clack/prompts` v1.1.0 ✅

---

## Phase 9 — npm Distribution (v0.1.x) ← IN PROGRESS

> Focus: get totopo published and invocable via `npx totopo` as a real package.

- [x] **Package name** — `totopo` registered on npm
- [x] **Repo hygiene** — `LICENSE`, `CHANGELOG.md`, `.npmignore`, `engines`, `files`, `bin`, README
- [x] **Rename** — all references updated from `aibox` → `totopo`
- [x] **Release tooling** — `pnpm rc`, `pnpm rc:promote`, `pnpm sync-releases` scripts
- [x] **Published** — v0.1.3 is current `latest` on npm

### Completed in this session
- [x] **Directory restructure** — `scripts/` split into `src/core/` (npm) and `src/releases/` (dev-only)
- [x] **changelog.yaml source of truth** — `src/releases/changelog.yaml` replaces manual CHANGELOG.md edits
- [x] **generate-changelog** — `pnpm generate-changelog` regenerates CHANGELOG.md from yaml
- [x] **rc.ts** — now prompts for changelog notes, hard-blocks if no notes exist, appends to yaml
- [x] **release.ts** — validates yaml has entries, squashes rc notes, regenerates CHANGELOG.md on promote
- [x] **sync-github-releases.ts** — reads release notes from changelog.yaml (not raw CHANGELOG.md)

### Next task
- [ ] **`npx totopo` works end-to-end** — verify in a clean project directory

---

## Phase 10 — Dockerfile: Full Runtime Support

> The vision promises a universal dev environment. Deferred until after v0.1.0 ships.

- [ ] Add Python
- [ ] Add Go
- [ ] Add Rust
- [ ] Add Java (JDK)
- [ ] Add common tools: curl, wget, jq, unzip, ca-certificates (audit existing)
- [ ] Update `post-start.mjs` runtime checks to cover new runtimes
- [ ] Update `templates/Dockerfile` to match

---

## Phase 11 — Settings

- [ ] Settings submenu: view/edit API keys, check for updates
- [ ] Uninstall option: remove `.totopo/` and stop any running container

---

## Phase 12 — Docs

- [ ] Polish `README.md` for npm page (install via `npx`, quickstart, security model)
- [ ] Document security model in depth
- [ ] Contribution guide

---

## Backlog

- [x] Fix onboarding — tsx moved to dependencies, ai.sh uses package-local tsx binary; pnpm added to Dockerfile ✅
- [ ] Add troubleshooting option to the interactive menu
- [ ] Make DevPod workspace prefix more unique — current `totopo-<project>` could conflict with user's other Docker containers; consider something like `totopo-pod-<project>` or similar (discuss naming when picked up)
