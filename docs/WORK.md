# WORK.md — aibox progress tracker

## Architecture

Two distinct concerns — keep them separate:

```
aibox PACKAGE (this repo — distributed via npx in future)
├── ai.sh              ← entry point (run from user's project directory)
├── scripts/           ← aibox logic; never copied to user projects
│   ├── doctor.ts
│   ├── dev.ts
│   ├── stop.ts
│   ├── reset.ts
│   └── onboard.ts
└── templates/         ← copied into user's .aibox/ during onboarding
    ├── Dockerfile
    ├── devcontainer.json
    ├── post-start.mjs
    └── env

USER'S PROJECT (any git repo where aibox is used)
└── .aibox/            ← created by onboarding; config only, no scripts
    ├── .env           (gitignored — API keys)
    ├── Dockerfile
    ├── devcontainer.json
    └── post-start.mjs
```

`ai.sh` sets `AIBOX_PACKAGE_DIR` (where ai.sh lives) and `AIBOX_REPO_ROOT`
(git root of `$PWD`) and exports them so scripts don't recompute paths.

---

## Completed

- **Phase 1** — Migrate config to `.aibox/` ✅
- **Phase 2** — Doctor command (Docker, DevPod, provider checks; silent pre-menu, verbose on demand) ✅
- **Phase 3** — Clean package vs project separation; `scripts/` stays with aibox, `templates/` copied to user projects ✅
- **Phase 4** — Onboarding flow: detects missing `.aibox/`, copies templates, substitutes project name, creates `.env`, updates `.gitignore` ✅
- **Phase 5** — Post-onboarding fixes: macOS compat, push-blocked test fix, existing workspace detection ✅
- **Phase 6** — Port cleanup + `aibox-<project>` workspace naming ✅
- **Phase 7** — Main menu UX: clack-based interactive menu, status box, project name, API key indicator ✅
- **Phase 8** — TypeScript + pnpm + Biome toolchain; cross-platform binaries; `@clack/prompts` v1.1.0 ✅

---

## Phase 9 — npm Distribution (v0.1.0)

> Focus: get aibox published and invocable via `npx aibox` as a real package.
> Once this lands, all future work iterates as releases.

- [x] **Package name** — `aibox` chosen; consistent with `.aibox/` directory already in every user's project
- [x] **Repo hygiene** — audit for npm package best practices: `LICENSE`, `CHANGELOG.md`, `.npmignore`, `engines` field, `files` field, correct `bin` entry, `README` fit for npm page
- [x] **Rename** — all references updated from `saia` → `aibox`, `.saia/` → `.aibox/`
- [ ] **`npx aibox` works** — verify end-to-end: `npx aibox` from a clean project directory runs the onboarding flow correctly
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
- [ ] Uninstall option: remove `.aibox/` and stop any running container

---

## Phase 12 — Docs

- [ ] Polish `README.md` for npm page (install via `npx`, quickstart, security model)
- [ ] Document security model in depth
- [ ] Contribution guide
