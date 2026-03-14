# Release Conventions

## Versioning

Follows [Semantic Versioning](https://semver.org/):

- `0.x.0` — new features or breaking changes while pre-1.0
- `0.x.y` — bug fixes and patches
- `1.0.0` — first stable, production-ready release

## Changelog Format

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each release entry in `CHANGELOG.md` must include:

```
## [x.y.z] — YYYY-MM-DD

### Added      ← new features
### Changed    ← changes to existing behaviour
### Deprecated ← soon-to-be removed features
### Removed    ← removed features
### Fixed      ← bug fixes
### Security   ← security fixes (always include if applicable)
```

Only include sections that have entries. Keep entries concise — one line per item.

## npm dist-tags

Two tags are maintained:

| Tag | Points to | Used by |
| --- | --- | --- |
| `latest` | last stable release (e.g. `0.1.4`) | `npx totopo` |
| `rc` | current release candidate (e.g. `0.1.4-rc-2`) | `npx totopo@rc` |

## Release Workflow

### 1. Publish a release candidate

```bash
pnpm rc
```

Auto-increments the rc version based on registry state, commits, tags, and publishes as `rc`. Repeat until confirmed working.

### 2. Promote to latest

```bash
pnpm rc:promote
```

Reads `rc` from the registry, strips the `-rc-N` suffix, publishes the clean version as `latest`.

### 3. Create GitHub release

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(awk '/^## \[X\.Y\.Z\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md)"
```

## Release Checklist

- [ ] All Phase tasks for this version checked off in `docs/WORK.md`
- [ ] `CHANGELOG.md` updated with new version entry
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm pack --dry-run` inspected — only expected files in tarball
- [ ] `pnpm rc` — publish and test (`npx totopo@rc`)
- [ ] `pnpm rc:promote` — promote to latest
- [ ] GitHub release created from CHANGELOG.md
- [ ] Verify on https://www.npmjs.com/package/totopo
- [ ] Test: `npx totopo` in a clean project directory
