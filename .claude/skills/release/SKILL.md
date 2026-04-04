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

1. Find all entries in `in_progress.entries` whose `rc_version` is **not** present in the published npm versions list.
2. **If more than one unpublished entry exists**, this is a mistake (likely from prior agent sessions). Warn the user, then fix it:
   - The target RC version is `base_version-rc-{N+1}` where N is the highest **published** RC number for `base_version` (or 0 if none exist).
   - Take the **content** (categories) from the highest-numbered unpublished entry (it should be cumulative).
   - Remove all unpublished entries from `in_progress.entries` and replace them with a single entry at the target RC version, carrying over the content and setting the date to today.
   - Show the user what you did.
3. **If exactly one unpublished entry exists**, that entry is being updated — use its `rc_version`.
4. **If no unpublished entries exist**, find the highest published RC number for `base_version` and target `base_version-rc-{N+1}`. If no RCs exist yet, target `base_version-rc-1`.

**Ask the user to confirm** the target RC version before proceeding.

## Step 4 — Review/draft changelog entry

If the target RC already has an entry in `in_progress.entries`, show it and ask if changes are needed.

If not, help the user draft a new entry. The entry must follow these rules:
- Use only the categories that apply: `added`, `changed`, `fixed`, `security`
- One line per item — concise, user-facing language
- No implementation details, file paths, or internal module names
- Group related changes into single entries rather than listing each file change separately
- Set `date` to today's date (YYYY-MM-DD format)
- **Cumulative convention**: the new RC entry should describe the **full release** as it would appear in the final release notes, not just the delta from the previous RC. Review all previous RC entries in `in_progress.entries` and carry forward any items that still apply. The latest entry becomes the release notes when promoted via `pnpm rc:promote`. Previous RC entries serve as a development audit trail.
- **Omit RC-relative fixes**: if a bug was introduced in a previous RC and fixed before this one, do NOT include it. The final release notes describe changes relative to the **last stable release**, not relative to previous RCs. A user upgrading from the last stable version never experienced the bug, so it is not a release note. Only include fixes for bugs that exist in the last stable release.

Write the entry to `scripts/changelog.yaml` under `in_progress.entries`.

**Before writing**, present the draft to the user and explicitly call out any items you chose to omit (and why) so they can confirm.

## Step 5 — Review test coverage

Review the changes included in this RC and assess whether any new unit or integration tests should be added before releasing.

For each significant change (new feature, behaviour change, bug fix):
1. Check whether the change is already covered by an existing test in `tests/` or `tests/docker/`.
2. If not, decide whether the gap is worth filling before this RC or can be deferred. Flag untested changes explicitly so the user can make the call.

If all changes are adequately covered, say so and move on.

## Step 6 — Check for missing migrations

Review the changes included in this RC and check whether any of them alter the on-disk structure that existing users would have from a previous version. Specifically, look for changes to:

- `totopo.yaml` schema (new required keys, renamed keys, removed keys)
- `~/.totopo/workspaces/<id>/` layout (new files, renamed files, changed `.lock` format)
- Container naming conventions (`deriveContainerName`)
- Any file or directory that totopo writes to the user's machine

If a structural change is found, check `src/lib/migrate-to-latest.ts` for a corresponding migration step in the `MIGRATIONS` registry. If no migration handles the change, **warn the user** and suggest what migration step is needed.

If no structural changes are found, say so explicitly and move on.

## Step 7 — Review docs for staleness

Review these three areas and flag anything that needs updating before the release:

1. **`README.md`** — does the description, feature list, and any command or path references still match the current codebase? Check for stale terminology, removed features, or new features not yet documented.
2. **`AGENTS.md`** — does the file structure, command list, and rules section reflect the current state of the repo?
3. **Agent context templates** (`templates/context/*.md`) — do the sandbox constraints, git policy, and workspace guidance still accurately describe what the container provides?

For each: if no changes are needed, say so explicitly. If changes are needed, make them and include them in the upcoming commit.

## Step 8 — Lint and fix

Run `pnpm lint:fix` to auto-fix formatting and lint issues across the codebase. This ensures everything is clean before committing.

If the command fails or reports unfixable issues, stop and show the output to the user.

## Step 9 — Stage and commit

Ask the user: **"Stage all changes and commit?"**

If yes:
1. Run `git add -A`
2. Commit with message: `chore: rc {target_rc_version}`

If no, skip this step.

## Step 10 — Remind about host commands and testing

Print this reminder:

> The container cannot publish to npm or push to git remotes.
> On the host, run:
>
> ```
> pnpm rc
> ```
>
> This will publish the RC to npm and push the commit + tag.

Then, derive a short test checklist from the RC changelog entry (the `added`, `changed`, and `fixed` items). For each item, suggest one concrete action the user can take to verify it works end-to-end on the host. Focus on user-visible behavior — skip internal refactors or convention changes that have no runtime effect.

Format it as:

> **RC smoke tests** — run these after `pnpm rc` publishes:
>
> ```
> npx totopo@rc
> ```
>
> - [ ] _test scenario derived from changelog item_
> - [ ] _..._

Only include tests that are actually testable by running `npx totopo@rc` interactively. Omit items that are documentation-only, tooling-only, or already covered by `pnpm check`.
