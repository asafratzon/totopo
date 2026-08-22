---
name: cospec-execute
description: Execute the plan of a cospec specification phase by phase. Use when the user wants to start or continue implementing a spec from cospec/. User-invoked only.
disable-model-invocation: true
argument-hint: "[slug of the spec to execute]"
---

# Cospec execute - implement a spec's plan

This skill runs only when the user types `/cospec-execute`, and never on its own.

Your job is to move through the phases of `cospec/<slug>/plan/`, and to keep all progress on disk so that a later session can restart from this point.

Write, build, verify, record, and commit each phase file yourself.
The only subagents are reviewers, and they exist so that a person who did not do the work can judge it.

Use `AskUserQuestion` for decisions.
When that tool is not available, ask the question in a normal message and end your turn.
Progress reports during building are normal message text.

## The plan is the user's instruction

The user chose everything in the plan at spec time: the commits and branch, the pauses, the review checkpoints, the verify steps, and the principles check and its recorded deviations.
All of it binds this run.

A recorded deviation is an approved exception.
Build the work to match it, and never return it quietly to the principle it excepts.

A principle that the plan does not except stays binding.

Your own limits do not justify a change to the plan.
When you cannot do what the plan asks, treat this as a stop condition: the "Stop and ask" section below tells you how to raise it.
Never replace the plan's instruction with a weaker one and continue.

Two things fall outside this rule.
First, a choice of your own that changes nothing, such as which of two equal ways to read a file, is yours to make.
Second, an instruction from the user in this conversation overrides the plan.
The plan loses only to the user, never to you.

## Asking questions

When a question's options do not depend on the work, write it in a fenced block tagged `question`, and ask it exactly as written.

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

**Reading a block:**

- Copy the question text, header, option labels, descriptions, and their order unchanged.
- Angle brackets mark only the parts you fill in, for example `<slug>`, `<phase name>`, `<count>`.
- A line may mark an option as conditional (`only when ...`) or repeated (`one per ...`); every other line is always present.
- Never reword a block to fit the moment, and never add an option.
- `AskUserQuestion` appends its own free-text choice.
- A block never carries an option that only means "something else", but it does carry a named alternative when a typed answer leads somewhere real.

**Wording rules for every question, in a block or not:**

- Write for a reader who has never used cospec.
- Do not use internal terms, such as the spec directory layout, phase files, or stage names, unless the option explains them at the same time.
- Put the recommended option first, and end its label with `(Recommended)`.
- When another reason fixes the order, such as the stage list, place the marker there instead.
- Keep labels short, and put the reasoning and the trade-offs in the descriptions.

## 0. Bootstrap

Before anything else, run the bootstrap from `../cospec-config/SKILL.md` (section "The bootstrap"):

- Resolve the cospec root.
- Read `<cospec root>/principles.md` when it exists, and take what parses from it.
- Offer one-time setup when the file does not exist.
- Apply the settings and principles for the rest of the run.

When the file does not exist at its sibling path, run with the built-in defaults and state this in the report.

## 1. Select the spec

If the user passed a slug, use it.
Otherwise, infer it from the conversation.

When exactly one spec under the cospec root, other than `archive/`, has an unchecked-phase plan:
- With `spec_pickup: auto`, adopt it silently.
- With `ask`, the default, confirm it with the question below, listing it as one option.

When more than one spec is a candidate, ask:

```question
Question: Which piece of work should I carry out?
Header: Work
- <title of the spec> (one per candidate spec)
  <count> of <total> phases done. Next: <name of the next phase>.
```

Then read, in this order: `README.md`, `spec/SPEC.md`, and `plan/PLAN.md`.
Do not read the phase files yet: read or write a phase file only when its phase starts.

**Handle these states before anything else:**

- No `plan/` directory: tell the user this spec has no execution plan, say that `/cospec` can add one, and stop.
- All phases checked: say so, and suggest `/cospec-archive`. Stop.

## 2. Derive and announce the status

Work out where things stand from disk alone.
Announce this before you do anything, together with what the plan asks for: the `Pauses:` line and the `Review checkpoints:` line.
The user then knows from the start where this run stops and where it gets reviewed.

**Phase status:**

- A phase ticked in `PLAN.md` is done.
- The first unticked phase is next.
- When a phase file exists, its `Status:` line reads `in progress` or `done`.
- A phase file is written just before its phase starts.
- A file at `in progress` under an unticked phase means an earlier session stopped mid-phase.
  Treat this case as suspect: check `git status` for half-done work, re-run the verify steps of any ticked tasks, and proceed from where the evidence points, and only then.
- `README.md` carries a dated line for each completed review checkpoint.
- A checkpoint with all its phases done but no dated line has not run yet.
  Run it before you move on.

**Commits and branches:**

Read the `Commits:` line in `PLAN.md`: `per phase`, `single`, or `none`.
This line tells you how much of the record the repository itself shows:

- `per phase`: A completed phase is a committed phase. Uncommitted changes belong to the phase that was interrupted.
- `single` or `none`: You commit nothing before the run ends, if at all. The phase status lines and the ticked boxes in `PLAN.md` are the only record of progress.

Read the `Branch:` line together with it.
`Branch: current` means commits land on the current branch.
Any other value names a dedicated branch for the run, either `cospec/<slug>` or a name the user chose.

**Resolving state problems:**

When the disk state does not match what this skill expects, or is missing something, resolve it with judgment, and state your choice in the report.
Do not stop, and do not follow a fixed rule.

## 3. The loop

Every phase goes through the same steps, and you carry out every step yourself.

1. **The phase file.**

   Check for a phase file left on disk from an interrupted run, and never rewrite it.
   Check it against the actual code before you change anything.
   Keep the task checkboxes from that run, since they show what got done.
   Adapt small changes, and note them, but treat a design change as a stop condition.

   With no such file, write `plan/phase-NN-<slug>.md` right before you build this phase.
   Write it against the code as it stands after the earlier phases, and take the phase goal and the definition of done from `PLAN.md`.
   Follow this layout:

   ```markdown
   # Phase 02 - <name>

   Status: in progress

   ## Tasks

   - [ ] <task>
   - [ ] <task>

   ## Verify

   - <command or check that proves the definition of done>
   ```

   When you write a phase file, do not weigh development cost heavily.
   Prefer quality, simplicity, robustness, scalability, and long-term maintainability instead.
   When something grows too large, restructure it by judgment: refactor it, split it, or extract a part of it.
   Never restructure by a number set in advance.

2. **Build.**
   Keep changes scoped to this phase, and tick each task checkbox as it completes.

3. **Verify.**
   Run the Verify section, and make it pass.

4. **Record.**
   Set the phase status to `done`, tick the phase checkbox in `PLAN.md`, and add a dated line to `README.md`.

   With `Commits: per phase`:
   - Commit the phase's changes.
   - Write a one-line message in the commit style from `principles.md`.
   - Use "phase NN - <name>" as the descriptive part.
   - Commit only, and never push.
   - Under a style with a type slot, set the work commit's type from what the phase did (see `../cospec-config/SKILL.md`).

   With `single` or `none`:
   - Do not commit at this point.

   Finish all recording before the next phase starts, so that an interrupted session loses nothing.

**Then, in this order:**
- The review checkpoint after this phase, if the plan places one there.
- The user pause after this phase, if the plan places one there.

The pause always reports results that are already reviewed and fixed.

**The final commit with `Commits: single`:**

Once the last phase passes its verify steps and finishes its record step:
- Commit everything this work produced, in one commit.
- Compose the message from the commit style in `principles.md`.
- Use the `PLAN.md` title as the descriptive part.
- This commit also covers earlier runs of the same work, since they did not commit.
- Make this commit before the final review checkpoint.
- The final checkpoint must never read an uncommitted tree when commits are on.

With `Commits: none`, commit nothing at any point.

**Every commit carries the spec's record:**

The record step updates `PLAN.md` and `README.md` before it commits.
Every commit that the step makes, whether per-phase or the single final one, touches the spec directory.
Give the review-fixes commit the same quality: add a dated `README.md` line that names what the checkpoint found and fixed, and let that commit carry the line.

This record is what lets `/cospec-archive` later find where execution ended and what the user added after that point.

**On the first phase of a run:**
Set Status: executing in `README.md`.

**Before that first phase, when `Branch:` names a dedicated branch:**

Set the run on that branch:
- Already on it: proceed.
- Exists but not checked out: switch to it.
- Does not exist: create it from the current `HEAD`.

When the working tree holds changes that do not belong to this spec, ask before you switch or create the branch.
This step keeps unexpected changes off the branch:

```question
Question: You have unsaved changes that are not part of this work. Move to the branch <branch name> anyway?
Header: Branch
- Move to the branch (Recommended)
  Your unsaved changes come along to it. The commits of this work land there.
- Stay where I am
  I work and commit on your current branch. The plan's branch is not created.
```

If the user declines:
- Stay on the current branch.
- State in the report that this run's commits did not go to the planned branch.

Never merge, and never push.
Merging the work back is the user's job.

**Keep the spec true:**

If what gets built differs from `spec/SPEC.md` or the plan:
- Update those files as part of the phase.
- The archived spec later becomes the documentation of what was actually built.

If the solution deviates noticeably from an approved solution sketch in `spec/SPEC.md`:
- Treat this as a stop condition.
- The sketch does not bind you, but the user approved it and must stay informed.

### Review checkpoints

The `Review checkpoints:` line in `PLAN.md` says where fresh reviewers judge the work.
Each sub-bullet names one checkpoint, and states where it sits, either after a named phase or at `final`, how many reviewers it wants, a focus for each reviewer, and why the checkpoint is there.

`Review checkpoints: none` means no review runs.
State in the report that the plan chose none.

**Run a checkpoint:**
- Once you record the phase it sits after.
- Once any commit the plan asks for lands, when `Commits: per phase`.
- Run the `final` checkpoint once the spec's last phase is recorded, any required commit has landed, and before you give the end-of-run report.

**Spawn one reviewer subagent for each focus that the checkpoint names.**

The reviewers work with no shared context: each reviewer gets its own prompt, no reviewer sees this conversation, no reviewer learns what the other reviewers found, and you are never one of the reviewers.

A reviewer's whole value comes from judging work it did not do.
Treat an inability to spawn reviewers as a stop condition, and never review the work yourself instead.

**Tell each reviewer:**

- Its focus, and to check the work against what was asked.
- Which files to read: `spec/SPEC.md`, `plan/PLAN.md`, the phase files written so far, and `<cospec root>/principles.md`.
- That the plan's principles check records deviations as approved exceptions, not as findings.
- How to see the changes: name the commit the work started from, so the reviewer can diff against it, and point to the working tree when nothing is committed yet.

**Each reviewer returns a verdict with concrete findings.**
Every finding points at a file and a line.

**Then, yourself:**

- Merge the findings, and remove duplicates.
- Dismiss what you judge to be wrong, and state why in the report.
- Fix the rest yourself.
- Re-run the Verify steps of every phase the fixes touch.
- Have each reviewer who rejected a fix re-check it once.
- When a reviewer still objects after that re-check, you settle the point: fix it once more when the objection names something real, and otherwise record the finding in `README.md` as knowingly accepted, and move on.
- When commits are on, land the fixes in one follow-up commit.
- Compose the message from the commit style in `principles.md`, and use "review fixes" as the descriptive part.

Log the completed checkpoint in `README.md` with a dated line that names its outcome.
An interrupted run can then tell from disk whether the checkpoint ran.

### User pauses

The `Pauses:` line in `PLAN.md` says when the run stops for the user: `none`, a list of phases, for example `after phase 2, after phase 4`, or `every phase`.

**At a pause**, after the phase is built, reviewed if a checkpoint sits there, recorded, and committed:

Report what the phase produced, and ask:

```question
Question: Phase <N> - <phase name> is done. <what it produced, in a line>. Carry on?
Header: Pause
- Carry on (Recommended)
  I start the next phase, <name of the next phase>.
- Stop here
  I stop now. Run /cospec-execute again whenever you want the rest. It picks up from here.
```

**Carrying on:** Start the next phase in this same session.

**Stopping:** End the run with the report below.
A later run finds from disk where this one stopped, and resumes at the next unfinished phase, and pauses only at the pauses still ahead of it.

A pause placed after the spec's last phase has nothing left to carry on to.
Run the final review checkpoint, and give the end-of-run report instead of asking a question.

## 4. Stop and ask

Stop and ask the user when one of these three conditions holds.
Otherwise, keep going on your own:

1. **The work deviates significantly from the spec.**
   - What you build contradicts `spec/SPEC.md`.
   - A fact you discovered makes the approved shape no longer fit.
   - The solution departs noticeably from an approved solution sketch.

2. **A blocker that only the user can resolve.**
   - A scope or design decision with no single right answer.
   - An action that is destructive or hard to reverse, such as a data migration, a deletion, or a call to an external service.
   - Missing access that only the user can grant.

3. **The run cannot proceed for technical reasons.**
   - A verify step that still fails after a real attempt to fix it.
   - A tool the plan needs, and your environment refuses to provide.

For condition 3, ask with this block:

```question
Question: The plan asks for <what it asks for>, and I cannot do it here: <why, in a line>. How should I go on?
Header: Blocked
- Stop here (Recommended)
  I stop and change nothing else. Sort it out when you can, then run /cospec-execute again. It picks up from this point.
- Carry on without it
  I keep going and leave that part undone. The report says plainly that it never happened.
```

**Everything else is yours to settle:**
- Review findings
- Wording calls
- An unclear task
- Which of two fixes reads better

Settle these yourself, keep the run moving, and state in the report what you settled.
A run that stops to ask about something it could have settled has failed.
Quality is yours to hold, and the user is waiting for the finished work.

## 5. Report

At the end of the run, or at a pause, report in a normal message:

- The phases you completed this run, and overall progress, for example "5/7 phases done".
- What the verification showed, and the outcome of every review checkpoint this run ran: what the reviewers found, what was fixed, what was dismissed and why, and, when the plan asked for no review, a statement that it asked for no review.
- What you settled on your own, where it matters to the user.
- When the run committed to a dedicated branch, state its name, that it is unmerged, and that merging it back is the user's job.
- If the run stopped at a pause or a stop condition, state why, and what you need from the user.
- If everything is done:
  - Suggest `/cospec-archive`.
  - When this run finishes the last phase with commits on a dedicated branch, suggest running archive before the merge.
  - Give the reason: archiving reads the commits that landed on the branch after execution ended, and offers to align the record with them. This works only while the work stays on its own branch, so archiving before the merge means the merge carries the archived spec with it.
