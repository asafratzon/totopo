---
name: release
description: Prepare a release — verify changelog, check registry, stage and commit. Use when ready to publish a release candidate, promote an RC, or ship a direct stable release.
disable-model-invocation: true
---

# Release: Prepare a release

Follow these steps in order. Stop and wait for user input at each confirmation point.

## Step 1 — Read changelog state

Read `scripts/changelog.yaml` and extract:
- `in_progress.base_version`
- `in_progress.entries` (list of entries already recorded — may be RC entries with `rc_version` or stable entries with `version`)

Print a summary: base version, number of existing entries, and their version values.

## Step 2 — Check npm registry

Run these commands and capture the output:

```bash
npm view totopo dist-tags --json 2>/dev/null || echo '{}'
npm view totopo versions --json 2>/dev/null || echo '[]'
```

Print the current `latest` and `rc` dist-tags (if rc exists).

## Step 3 — Choose release type

Ask the user which release flow they want:

- **Release candidate** — publish an `-rc-N` version for testing
- **Promote rc to stable** — only offer this if an `rc` dist-tag exists on npm
- **Direct stable release** — bypass the RC lane, publish directly as `latest`

The choice determines how the remaining steps behave. Refer to it as the **release type** below.

## Step 4 — Determine target version

Check the current branch name with `git branch --show-current`.

### If release type is "Release candidate"

If the branch follows the `v{X.Y.Z}-rc-development` convention, extract the version — this is a strong signal for what base version is being developed. If it differs from `in_progress.base_version`, use the branch version as the base when proposing the target RC version below.

Apply these rules:

1. Find all entries in `in_progress.entries` whose `rc_version` is **not** present in the published npm versions list.
2. **If more than one unpublished entry exists**, this is a mistake (likely from prior agent sessions). Warn the user, then fix it:
   - The target RC version is `base_version-rc-{N+1}` where N is the highest **published** RC number for `base_version` (or 0 if none exist).
   - Take the **content** (categories) from the highest-numbered unpublished entry (it should be cumulative).
   - Remove all unpublished entries from `in_progress.entries` and replace them with a single entry at the target RC version, carrying over the content and setting the date to today.
   - Show the user what you did.
3. **If exactly one unpublished entry exists**, that entry is being updated — use its `rc_version`.
4. **If no unpublished entries exist**, find the highest published RC number for `base_version` and target `base_version-rc-{N+1}`. If no RCs exist yet, target `base_version-rc-1`.

### If release type is "Direct stable release"

Determine the target version based on bump type (patch/minor/major from current `latest`). Ask the user to confirm. If `in_progress.base_version` doesn't match, update it.

### If release type is "Promote rc to stable"

The target version is the base version derived from the current `rc` dist-tag (strip the `-rc-N` suffix). No version selection needed — confirm with the user and skip to Step 6 (changelog entries already exist from RC phase).

**Ask the user to confirm** the target version before proceeding.

## Step 5 — Review/draft changelog entry

**Skip this step for "Promote rc to stable"** — entries already exist from the RC phase.

### For "Release candidate"

If the target RC already has an entry in `in_progress.entries`, show it and ask if changes are needed.

If not, help the user draft a new entry. The entry must use the `rc_version` field and follow these rules:
- Use only the categories that apply: `added`, `changed`, `fixed`, `security`
- One line per item — concise language describing what changed and why it matters
- Include all relevant changes, not just user-facing ones. Test improvements, internal refactors, and tooling changes matter to users who follow the project. However, compact them: multiple related changes (e.g. several test additions) should be grouped into a single bullet rather than listed individually
- No file paths or internal module names — describe changes in terms of what they affect, not where the code lives
- Use common sense for grouping and filtering: a single bullet for "improved test coverage for shadow paths" is better than five bullets listing each test file, but omitting test changes entirely loses useful signal
- Set `date` to today's date (YYYY-MM-DD format)
- **Cumulative convention**: the new RC entry should describe the **full release** as it would appear in the final release notes, not just the delta from the previous RC. Review all previous RC entries in `in_progress.entries` and carry forward any items that still apply. The latest entry becomes the release notes when promoted. Previous RC entries serve as a development audit trail.
- **Omit RC-relative fixes**: if a bug was introduced in a previous RC and fixed before this one, do NOT include it. The final release notes describe changes relative to the **last stable release**, not relative to previous RCs.

### For "Direct stable release"

Same rules as above, except the entry must use the `version` field (not `rc_version`):

```yaml
- version: "x.y.z"
  date: "YYYY-MM-DD"
  added:
    - "Description of change"
```

Write the entry to `scripts/changelog.yaml` under `in_progress.entries`.

**Before writing**, present the draft to the user and explicitly call out any items you chose to omit (and why) so they can confirm.

## Step 6 — Review test coverage

Review the changes included in this release and assess whether any new unit or integration tests should be added before releasing.

For each significant change (new feature, behaviour change, bug fix):
1. Check whether the change is already covered by an existing test in `tests/` or `tests/docker/`.
2. If not, decide whether the gap is worth filling before this release or can be deferred. Flag untested changes explicitly so the user can make the call.

If all changes are adequately covered, say so and move on.

## Step 7 — Check for missing migrations

Review the changes included in this release and check whether any of them alter the on-disk structure that existing users would have from a previous version. Specifically, look for changes to:

- `totopo.yaml` schema (new required keys, renamed keys, removed keys)
- `~/.totopo/workspaces/<id>/` layout (new files, renamed files, changed `.lock` format)
- Container naming conventions (`deriveContainerName`)
- Any file or directory that totopo writes to the user's machine

If a structural change is found, check `src/lib/migrate-to-latest.ts` for a corresponding migration step in the `MIGRATIONS` registry. If no migration handles the change, **warn the user** and suggest what migration step is needed.

If no structural changes are found, say so explicitly and move on.

## Step 8 — Review docs for staleness

Review these three areas and flag anything that needs updating before the release:

1. **`README.md`** — does the description, feature list, and any command or path references still match the current codebase? Check for stale terminology, removed features, or new features not yet documented.
2. **`AGENTS.md`** — does the file structure, command list, and rules section reflect the current state of the repo?
3. **Agent context templates** (`templates/context/*.md`) — do the sandbox constraints, git policy, and workspace guidance still accurately describe what the container provides?

For each: if no changes are needed, say so explicitly. If changes are needed, make them and include them in the upcoming commit.

## Step 9 — Lint and fix

Run `pnpm lint:fix` to auto-fix formatting and lint issues across the codebase. This ensures everything is clean before committing.

If the command fails or reports unfixable issues, stop and show the output to the user.

## Step 10 — Stage and commit

Check the current branch with `git branch --show-current`.

- For **Release candidate**: if the branch is `main`, warn the user — RC development should happen on a dedicated branch (e.g. `v3.1.0-rc-development`), not on `main`. Ask them to switch branches before committing.
- For **Direct stable release**: committing from `main` is fine.
- For **Promote rc to stable**: a commit may not be needed if changelog entries were already committed during the RC phase. Check if there are uncommitted changes first.

Ask the user: **"Stage all changes and commit?"**

If yes:
1. Run `git add -A`
2. Commit with message:
   - Release candidate: `chore: rc v{target_rc_version}`
   - Direct stable: `chore: release v{target_version}`
   - Promote: `chore: release v{target_version}` (if there are changes to commit)

If no, skip this step.

## Step 11 — Remind about host commands and testing

Print this reminder:

> The container cannot publish to npm or push to git remotes.
> On the host, run:
>
> ```
> pnpm release
> ```
>
> The script will show current registry state and let you choose the action.

Then, derive a short test checklist from the changelog entry (the `added`, `changed`, and `fixed` items). For each item, suggest one concrete action the user can take to verify it works end-to-end on the host. Focus on user-visible behavior — skip internal refactors or convention changes that have no runtime effect.

Format it as:

> **Smoke tests** — run these after publishing:
>
> ```
> npx totopo@rc     # for RC
> npx totopo        # for stable release
> ```
>
> - [ ] _test scenario derived from changelog item_
> - [ ] _..._

Only include tests that are actually testable by running totopo interactively. Omit items that are documentation-only, tooling-only, or already covered by `pnpm check`.
