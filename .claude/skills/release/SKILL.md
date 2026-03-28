---
name: release
description: Prepare an RC release — verify changelog, check registry, stage and commit. Use when ready to publish a release candidate.
disable-model-invocation: true
---

# Release: Prepare an RC

Follow these steps in order. Stop and wait for user input at each confirmation point.

## Step 1 — Read changelog state

Read `scripts/changelog.yaml` and extract:
- `in_progress.base_version`
- `in_progress.entries` (list of RC entries already recorded)

Print a summary: base version, number of existing RC entries, and their `rc_version` values.

## Step 2 — Check npm registry

Run these commands and capture the output:

```bash
npm view totopo dist-tags --json 2>/dev/null || echo '{}'
npm view totopo versions --json 2>/dev/null || echo '[]'
```

Print the current `latest` and `rc` dist-tags.

## Step 3 — Determine target RC version

Apply these rules:
- Look at `in_progress.entries` for any entry whose `rc_version` is **not** present in the published npm versions list. If found, that entry is being updated — use its `rc_version`.
- Otherwise, find the highest published RC number for `base_version` and target `base_version-rc-{N+1}`. If no RCs exist yet, target `base_version-rc-1`.

**Ask the user to confirm** the target RC version before proceeding.

## Step 4 — Review/draft changelog entry

If the target RC already has an entry in `in_progress.entries`, show it and ask if changes are needed.

If not, help the user draft a new entry. The entry must follow these rules:
- Use only the categories that apply: `added`, `changed`, `fixed`, `security`
- One line per item — concise, user-facing language
- No implementation details, file paths, or internal module names
- Group related changes into single entries rather than listing each file change separately
- Set `date` to today's date (YYYY-MM-DD format)

Write the entry to `scripts/changelog.yaml` under `in_progress.entries`.

## Step 5 — Lint and fix

Run `pnpm fix:all` to auto-fix formatting and lint issues across the codebase. This ensures everything is clean before committing.

If the command fails or reports unfixable issues, stop and show the output to the user.

## Step 6 — Stage and commit

Ask the user: **"Stage all changes and commit?"**

If yes:
1. Run `git add -A`
2. Commit with message: `chore: rc {target_rc_version}`

If no, skip this step.

## Step 7 — Remind about host commands

Print this reminder:

> The container cannot publish to npm or push to git remotes.
> On the host, run:
>
> ```
> pnpm rc
> ```
>
> This will publish the RC to npm and push the commit + tag.
