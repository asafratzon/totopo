# Release Conventions

## Versioning

Follows [Semantic Versioning](https://semver.org/):

- `0.x.0` — new features or breaking changes while pre-1.0
- `0.x.y` — bug fixes and patches
- `1.0.0` — first stable, production-ready release

## Changelog

`src/releases/changelog.yaml` is the **source of truth** for all release notes.
`CHANGELOG.md` is a **generated artifact** — never edit it by hand.

To regenerate manually:

```bash
pnpm generate-changelog
```

### changelog.yaml format

```yaml
releases:
  - version: "x.y.z"
    date: "YYYY-MM-DD"
    added:     # new features
    changed:   # changes to existing behaviour
    fixed:     # bug fixes
    security:  # security fixes (always include if applicable)

in_progress:
  base_version: "x.y.z"   # next release version
  entries:                 # accumulates across rc iterations
    - rc_version: "x.y.z-rc-1"
      date: "YYYY-MM-DD"
      fixed:
        - "Description of fix"
```

Only include categories that have entries. Keep entries concise — one line per item.

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

Auto-increments the rc version based on registry state. Prompts for changelog notes (required on first rc for a base version). Commits `package.json` and `src/releases/changelog.yaml`, tags, and publishes as `rc`. Repeat until confirmed working.

### 2. Promote to latest

```bash
pnpm rc:promote
```

Validates `changelog.yaml` has entries, squashes all rc entries by category, regenerates `CHANGELOG.md`, updates `package.json`, commits, publishes as `latest`, removes `rc` dist-tag, and creates a GitHub release via `gh` CLI.

### 3. Sync GitHub releases (optional)

If GitHub releases are out of sync with npm:

```bash
pnpm sync-releases
```

## Release Checklist

- [ ] All Phase tasks for this version checked off in `docs/WORK.md`
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm pack --dry-run` inspected — only `src/core/` and `templates/` in tarball
- [ ] `pnpm rc` — add changelog notes, publish, test (`npx totopo@rc`)
- [ ] `pnpm rc:promote` — squashes notes, regenerates CHANGELOG.md, promotes to latest
- [ ] Verify on https://www.npmjs.com/package/totopo
- [ ] Test: `npx totopo` in a clean project directory
