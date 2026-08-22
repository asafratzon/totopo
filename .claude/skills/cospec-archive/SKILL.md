---
name: cospec-archive
description: Sign off a completed cospec specification and move it to cospec/archive/ with the completion date. Use when the user confirms the implementation of a spec is done. User-invoked only.
disable-model-invocation: true
argument-hint: "[slug of the spec to archive]"
---

# Cospec archive - sign off a finished spec

This skill runs only when the user types `/cospec-archive`.
No other event starts it.

Archiving is the user's sign-off that a spec is implemented and done.
The archived directory becomes the record of what was built and when.

Ask each decision through `AskUserQuestion`.
If you do not have that tool, ask the question as a normal message and end your turn there.
Send the final summary as a normal message.

## Asking questions

Write a question whose options do not depend on the work as a fenced block tagged `question`, and ask it exactly as written.

````markdown
```question
Question: <the question text, verbatim>
Header: <the short chip label, verbatim>
Multi-select: yes            (only when the question allows several answers)
- <option label>
  <option description>
- <option label>
  <option description>
```
````

Follow these steps to read a block:

- Copy the question text, the header, the option labels, the descriptions, and their order exactly as they stand.
- Angle brackets mark the only parts you fill in, for example `<slug>`, `<phase name>`, `<count>`.
- A line in a block can mark an option as conditional (`only when ...`) or repeated (`one per ...`).
- Every other line is always present.
- Never reword any part to fit the moment, and never add an option.
- `AskUserQuestion` appends its own free-text choice, so a block never needs an option that only means "something else".
  A block does carry a named alternative when a typed answer leads somewhere real.

Follow these wording rules for every question, block or not:

- Write for a user who has never used cospec.
  Do not use internal terms - spec directory layout, phase files, stage names - unless the option explains them in the same breath.
- Put the recommended option first, and end its label with `(Recommended)`.
  When another reason fixes the order, such as the stage list, add the marker in place instead.
- Keep labels short.
  Put the reasoning and the trade-offs in the descriptions.

## 0. Bootstrap

Before anything else, run the bootstrap defined in `../cospec-config/SKILL.md` (see its "The bootstrap" section).
That bootstrap tells you to resolve the cospec root, read `<cospec root>/principles.md` when it exists and take what parses from it, offer the one-time setup when no file exists at all, and apply the settings and the principles for the rest of the run.
When that file does not exist at its sibling path, run on the built-in defaults and say so in the summary.

## 1. Select the spec

Use the slug when the user passed one.
Otherwise, infer it from the conversation.
When exactly one spec exists under the cospec root (ignore `archive/`), adopt it silently under `spec_pickup: auto`.
Under `ask` (the default setting), confirm it with the question below, and list that one candidate as its only option.
When more than one spec could match, ask, and list the specs whose work is fully done first:

```question
Question: Which piece of work are you signing off as done?
Header: Work
- <title of the spec> (one per candidate spec)
  <how far it got, in a few words>.
```

## 2. Check completeness

Read `README.md`, and read `plan/PLAN.md` and the phase files when a plan exists.
Count the unchecked stages, phases, and tasks.
Also run `git status` when the plan's `Commits:` line is anything other than `none`, because uncommitted changes there usually mean the work is not complete.

Ask the question below when anything is unchecked, or when `git status` shows uncommitted changes.
List each open item as one line under `<what is left>`:

```question
Question: Some of this work looks unfinished: <what is left, in a line each>. Sign it off anyway?
Header: Unfinished
- Sign it off anyway (Recommended)
  You are telling me it is done, so I file it away as it is and note what was left open.
- Cancel
  Nothing is moved or changed, and you can come back to this later.
```

Warn the user and ask for confirmation, but never block the sign-off: the user's decision wins.

## 3. Post-execution commits

Work the user adds on the spec's dedicated branch after execution finishes is not described in the spec directory.
As a result, the archived spec can end up disagreeing with what was actually built.
Run this check only when all of these conditions hold.
Otherwise, skip the check silently, with no message:

- The spec has `plan/PLAN.md`.
- Its `Branch:` line names a dedicated branch (anything other than `current`).
- That branch exists in the repository.

You need no condition on `Commits:`, because `Commits: none` always pairs with `Branch: current`, so a dedicated branch always means the run committed.

Find where execution ended.
Look for the last commit on that branch that changes the spec directory.

```bash
git log -1 --format=%H <branch> -- <cospec root>/<slug>/
```

Every commit made by an execution run changes the spec directory, so that commit marks where execution stopped, and everything after it on the branch came later.
When no commit touches the spec directory, you have no boundary to work from - skip the check silently.
Then list what came after that commit: run `git log --first-parent <hash>..<branch>`.
The `--first-parent` flag keeps the list to work done on this branch: a branch merged in afterwards shows up as one merge commit, not as all of its own commits.
When no such commits exist, continue silently.

**Judge before you ask.**
Read what those commits actually changed.
Read their diffs (`git show <hash>`, or `git diff <hash>..<branch>` for all of them at once) and not just their subject lines, and compare that against what `spec/SPEC.md` and the plan files say was built.
Skip a question when the change leaves the written record true: a comment, a formatting change, a rename that touches nothing the spec names, or a fix the spec already describes.
Continue silently on those.
Ask a question only when the record and the code genuinely disagree - in behavior, in scope, or in a design decision the files no longer describe.
Name those gaps in the question, in the user's own terms:

```question
Question: More work landed on the branch <branch name> after this was finished, and the written record no longer matches it: <the gaps, in a line each>. Bring the record up to date before archiving?
Header: Late changes
- Update, then archive (Recommended)
  I revise the written record so it describes what was actually built, note these commits in the work's log, and then archive.
- Archive as is
  Nothing is changed, and the files are archived exactly as they are.
```

When the user picks "Update, then archive": bring `spec/SPEC.md` and the plan files in line with what was actually built, and add a dated log line to `README.md` that names the commits by their count and short hashes.
When the user picks "Archive as is": change nothing, and continue.

## 4. Sign off and move

1. In `README.md`: set `Status: complete`, and add a log line, for example `- YYYY-MM-DD: signed off and archived`.
2. In `spec/SPEC.md`: add `Completed: YYYY-MM-DD` directly under the title.
3. Move the directory:

```bash
mkdir -p <cospec root>/archive
mv <cospec root>/<slug> <cospec root>/archive/YYYY-MM-DD-<slug>
```

Use today's date.
When the target directory already exists, stop and report the conflict instead of overwriting it.
Move the directory as it stands, and delete nothing from it.
The web interface renders archived work as read-only, so the archived work can be read later exactly the way it was read while it was open.

Once the move is done, ask one `AskUserQuestion`:

```question
Question: Should I commit the move to git?
Header: Commit
- Commit it (Recommended)
  I commit only the files that moved, with the message "<the message composed from the commit style in principles.md>". I never push. You can also just type a different message.
  (only when the working tree holds unrelated changes) Everything else you have changed is left exactly as it is.
- Don't commit
  The move stays in your working folder for you to handle.
```

When the user picks "Commit it": stage the archive change by path - the removed `<cospec root>/<slug>/` and the added `<cospec root>/archive/YYYY-MM-DD-<slug>/`.
Commit it with a one-line message composed from the commit style in `principles.md`, and use "archive spec" as its descriptive part.
Commit only, and never push.
Staging by path is what leaves unrelated working-tree changes alone.

## 5. Summary

Report in a normal message: the spec name, where you archived it, whether you committed the archive, and any warning it carries (for example, "archived with 2 incomplete tasks", or a note that the user chose to archive as is even though the record is known to disagree with the later commits).
