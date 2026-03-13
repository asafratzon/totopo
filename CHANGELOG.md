# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
