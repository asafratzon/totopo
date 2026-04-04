# Contributing to totopo

Contributions are welcome - whether it's a bug report, a feature request, or a pull request.

## Reporting issues & requesting features

If you run into something unexpected or have an idea for an improvement, feel free to [open an issue](../../issues). There's no formal template — just describe what you encountered or what you'd like to see.

## Pull requests

Pull requests are welcome. To contribute:

1. Fork the repository
2. Create a branch for your change
3. Make your changes
4. Open a pull request with a clear description of what you did and why

For larger changes, it's worth opening an issue first to discuss the direction before investing time in the implementation.

## Maintainer notes

### Recording terminal GIFs

Install the required tools:

```bash
brew install asciinema
brew install agg
```

Record a session:

```bash
asciinema rec demo.cast
# do your thing, then Ctrl+D or exit to stop
```

Convert to GIF:

```bash
agg demo.cast demo.gif

# useful options:
agg --cols 120 --rows 30 demo.cast demo.gif   # set terminal dimensions
agg --speed 2 demo.cast demo.gif               # speed up slow parts (e.g. Docker build)
agg --theme monokai demo.cast demo.gif         # change color theme
```

Place final GIFs in `.github/assets/` and uncomment the relevant placeholder in `README.md`.

### Releases

`scripts/changelog.yaml` is the source of truth for all release notes. `CHANGELOG.md` is a generated artifact — never edit it by hand; regenerate with `pnpm generate-changelog`.

- `pnpm rc` — publish a release candidate to npm under the `rc` dist-tag
- `pnpm rc:promote` — squash RC entries, regenerate CHANGELOG.md, promote to `latest`
- `/release` — guided workflow that checks the registry, helps draft changelog entries, and commits

#### changelog.yaml format

```yaml
in_progress:
  base_version: "x.y.z"   # next release version
  entries:                 # accumulates across rc iterations
    - rc_version: "x.y.z-rc-1"
      date: "YYYY-MM-DD"
      fixed:
        - "Description of fix"

releases:
  - version: "x.y.z"
    date: "YYYY-MM-DD"
    added:     # new features
    changed:   # changes to existing behaviour
    fixed:     # bug fixes
    security:  # security fixes (always include if applicable)
```

Only include categories that have entries. Keep entries concise — one line per item.

**Cumulative convention**: each RC entry should be a cumulative description of the full release — not just its delta from the previous RC. When drafting a new entry, carry forward all items from previous RC entries that still apply. `pnpm rc:promote` uses only the latest RC entry as the release notes. Earlier RC entries serve as a development audit trail.

#### npm dist-tags

Two tags are maintained:

| Tag | Points to | Used by |
| --- | --- | --- |
| `latest` | last stable release (e.g. `3.0.0`) | `npx totopo` |
| `rc` | current release candidate (e.g. `3.0.1-rc-1`) | `npx totopo@rc` |

### Maintaining agent mount definitions

totopo intercepts AI CLI config directories via bind mounts defined in
`src/lib/agent-context.ts`. These must stay aligned with the actual paths each
CLI reads/writes.

Periodically verify against official documentation:
- **Claude Code**: https://docs.anthropic.com/en/docs/claude-code
- **Codex**: https://github.com/openai/codex
- **OpenCode**: https://github.com/opencode-ai/opencode

Check for new config directories, renamed paths, or new project-level files.
Agent config dirs (`.claude/`, `.codex/`, `.opencode/`) are managed by the
agents themselves inside the container.

Shadow path mounts (configured via Settings > Shadow paths) are also assembled
in `src/commands/dev.ts` and must be appended after the workspace mount to
overlay correctly.