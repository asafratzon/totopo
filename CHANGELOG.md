# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.3] — 2026-03-14

### Fixed

- Onboarding crash — `devcontainer.json` template contains `//` comments (valid devcontainer spec, invalid `JSON.parse`); substitution now uses plain string replace, preserving comments in the output

---

## [0.1.2] — 2026-03-14

### Fixed

- `npx totopo` symlink resolution — `PACKAGE_DIR` now correctly resolves to the package root when invoked via npx (was resolving to `.bin/` directory, causing wrong `node_modules` and `tsx` paths)

---

## [0.1.1] — 2026-03-14

### Fixed

- `npx totopo` onboarding failure — `tsx` moved to `dependencies` and resolved from the package directory rather than expected globally
- Container startup status now shows pnpm version alongside node and npm

### Changed

- `pnpm` added to container image (Dockerfile + template)
- `ai.sh` auto-install falls back to npm if pnpm is unavailable
- README rewritten to reflect `npx totopo` workflow; removed stale Next.js reference and internal repo structure

---

## [0.1.0] — 2026-03-13

### Added

- Interactive clack-based menu: Start session, Stop all, Reset, Doctor
- Automatic onboarding: detects missing `.totopo/`, copies templates, substitutes project name, creates `.env`, updates `.gitignore`
- Doctor command: checks Docker, DevPod, provider, and API key readiness (silent pre-menu, verbose on demand)
- Security model: non-root container user (`devuser` uid 1001), git remote blocked via `protocol.allow never`, no credential forwarding, no privilege escalation (`no-new-privileges:true`)
- TypeScript source via `tsx` — no compile step required
- Workspace naming convention: `totopo-<project>`
- Port cleanup on stop/reset
- Status box with project name and API key indicator in menu UI
