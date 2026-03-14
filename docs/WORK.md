# WORK.md — totopo progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
totopo PACKAGE (this repo — distributed via npx in future)
├── ai.sh              ← entry point (run from user's project directory)
├── scripts/           ← totopo logic; never copied to user projects
│   ├── doctor.ts
│   ├── dev.ts
│   ├── stop.ts
│   ├── reset.ts
│   └── onboard.ts
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

## Phase 9 — npm Distribution (v0.1.0)

> Focus: get totopo published and invocable via `npx totopo` as a real package.
> Once this lands, all future work iterates as releases.

- [x] **Package name** — `totopo` registered on npm; consistent with `.totopo/` directory in every user's project
- [x] **Repo hygiene** — audit for npm package best practices: `LICENSE`, `CHANGELOG.md`, `.npmignore`, `engines` field, `files` field, correct `bin` entry, `README` fit for npm page
- [x] **Rename** — all references updated from `aibox` → `totopo`, `.aibox/` → `.totopo/`
- [ ] **`npx totopo` works** — verify end-to-end: `npx totopo` from a clean project directory runs the onboarding flow correctly
- [ ] **Version scheme** — confirm v0.1.0 as first publish; document versioning approach in `CHANGELOG.md`
- [ ] **Publish** — `npm publish` (or `pnpm publish`) with correct access and tags

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

- [ ] Fix onboarding — currently fails when run from a temp-test dir on host machine; investigate and fix
- [ ] Add troubleshooting option to the interactive menu
- [ ] Make DevPod workspace prefix more unique — current `totopo-<project>` could conflict with user's other Docker containers; consider something like `totopo-pod-<project>` or similar (discuss naming when picked up)
