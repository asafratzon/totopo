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

## Pre-release Testing

To publish for testing without affecting `npx totopo` (latest) for existing users:

```bash
pnpm publish --access public --tag next
npx totopo@next   # test in a clean directory
```

Once verified, promote to latest:

```bash
npm dist-tag add totopo@X.Y.Z latest
```

## Release Checklist

Before every `npm publish`:

- [ ] All Phase tasks for this version checked off in `docs/WORK.md`
- [ ] `CHANGELOG.md` updated with new version entry
- [ ] `package.json` version bumped
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm pack --dry-run` inspected — only expected files in tarball
- [ ] Commit all changes: `git commit -m "chore: release vX.Y.Z"`
- [ ] Tag: `git tag vX.Y.Z`
- [ ] User pushes tag from host: `git push && git push --tags`
- [ ] Create GitHub release from CHANGELOG.md (run on host):
  ```bash
  gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(awk '/^## \[X\.Y\.Z\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md)"
  ```
- [ ] `pnpm publish --access public`
- [ ] Verify on https://www.npmjs.com/package/totopo
- [ ] Test: `npx totopo@X.Y.Z` in a clean project directory
