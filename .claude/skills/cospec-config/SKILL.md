---
name: cospec-config
description: View and change the cospec settings and principles - commit style, spec pickup, saved planning answers, and the principles every skill honors - check the file against the shipped template, and define the one-time setup the other cospec skills offer at start. User-invoked only.
disable-model-invocation: true
---

# Cospec config - the user's preferences

Runs when the user types `/cospec-config`. Never auto-invoked.

This skill owns the cospec principles file: it writes the file the first time, runs a wizard to view and change it, and runs a doctor that checks it against the shipped template.
The other cospec skills only read this file.
The init flow - the one-time setup - is the one thing this skill offers those other skills to run.

Decisions go through `AskUserQuestion`.
When you do not have that tool, ask the question as a normal message and end your turn.

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

How to read a block:

- Copy the question text, the header, the option labels, the descriptions, and their order exactly as they stand.
- Angle brackets mark the only parts you fill in, for example `<slug>`, `<phase name>`, `<count>`.
- A line in a block may mark an option as conditional (`only when ...`) or repeated (`one per ...`). Every other line is always present.
- Never reword anything to fit the moment. Never add an option.
- `AskUserQuestion` appends its own free-text choice, so a block never carries an option that only means "something else".
  A block does carry a named alternative when a typed answer leads somewhere real.

Every question follows these wording rules, whether it is a block or not:

- Write for someone who has never used cospec.
  Do not use internal terms - spec directory layout, phase files, stage names - unless the option explains them in the same breath.
- Put the recommended option first, and end its label with `(Recommended)`.
  When the order is fixed for another reason, put the marker in place instead.
- Keep labels short. Put reasoning and trade-offs in the descriptions.

## The cospec root

Every `cospec/...` path in every cospec skill resolves against one **cospec root**.
Work out the cospec root at the start of each run:

- The agent tool states the base directory this skill's `SKILL.md` runs from.
- When that base directory sits under an agent directory inside a project - `<project>/.claude/skills/...`, `<project>/.agents/skills/...`, or similar - the cospec root is `<project>/cospec/`.
- When it sits under the home directory instead of a project, the cospec root is `cospec/` at the workspace root.

For example, in a monorepo with the skills installed at `apps/some-project/.claude/skills/`, the specs, the archive, and the principles file all live under `apps/some-project/cospec/`.

## The principles file

`<cospec root>/principles.md` is pure markdown: a settings section and a principles section, and nothing managed or generated anywhere in it.
The shipped template is `references/principles-template.md`, next to this file, and a fresh file starts as a copy of it.
The settings and the principles steer the skills best-effort: they shape questions and behavior, but they are not enforced checks.

Its shape: the settings live under a `## Settings` heading, one `- <key>: <value>` bullet per setting, values only, under one note line that points at `/cospec-config`.
The principles live under a `## Principles` heading, one `- <principle>` bullet per line.
The file holds nothing else: no explanation of what a setting means, no guidance on how to write a principle, and no examples.
Every cospec skill reads this file on every run, so it carries only what an agent must honor.
The meaning of each setting and the form of a good principle live in this skill, which is the only skill that writes or edits the file.

What each part holds:

- `commit_style` - the shape of every commit message any cospec skill makes. `default` names the default style, defined below. Any other value is a plain-English description of the project's own shape, with an example message in it.
- `spec_pickup` - the setting for when `/cospec-execute` or `/cospec-archive` finds exactly one candidate spec. `ask` (the default) still asks using its selection question, with that one candidate as the option. `auto` adopts the lone candidate silently.
- `commit_mode` - a saved answer to "Should the run save its work with git commits as it goes?": `prompt` (the default) keeps the per-spec question, `current-branch` commits on the current branch, `new-branch` commits on a new branch, or `no-commits` leaves changes untracked.
- `commit_grouping` - a saved answer to "How should those commits be grouped?": `prompt` (the default) asks per spec, `per phase` commits each phase separately, or `single` commits all the work at the end. This setting matters only when commits happen at all.
- `branch_naming` - the branch name pattern used when `commit_mode: new-branch`, so the branch-name follow-up is not asked either. `<slug>` in the pattern is replaced by the spec's slug.
- The principles section - plain-English engineering principles and rules that every skill reads at start and honors best-effort.
  A principle states its why when the why is not obvious.
  A principle scopes itself in its own sentence when it should not apply everywhere.
  When a rule is already written in the project's own documents (`CLAUDE.md`, `AGENTS.md`, and similar files), the principle points at that rule and declares it binding, instead of restating the rule.
  The section ships empty, so a missing or empty section means no principles.
  Use this form when you draft or reword a principle:

  ```markdown
  - Always recommend at least two code reviewers in execution plans, because one reviewer shares too many blind spots with the author.
  - Never add a new dependency without asking first: every dependency is a cost the project carries for years.
  ```

A saved answer skips its question silently.
The execution-plan stage still records the resolved `Commits:` and `Branch:` lines in `PLAN.md`, whatever their source, so that a plan stands on its own for the executing agent.
The plan-review gate still shows the whole setup, so the user can make a per-spec exception there through free text. That exception changes only that plan, never the principles file.

## The default style (commit messages)

The default style is the spec name, then a colon, then what the commit did:

```
user-preferences: spec ready
user-preferences: phase 02 - the consuming skills
user-preferences: review fixes
user-preferences: archive spec
```

This skill and its template are the only places that spell out the pattern, and every other mention of it, anywhere, says "the default style".

Config commits - the ones the setup and the doctor make - use `cospec` in place of the spec name: `cospec: set up config` and `cospec: update config`.
These commits are restyled like every other message when `commit_style` is not `default`.

When `commit_style` describes a type-prefixed convention, two families apply:

- Spec-level commits (`spec ready`, `archive spec`, and the config commits) touch only cospec files, so their type is fixed - for example `docs`.
- Work-level commits carry real code, so their type is chosen per commit from what the phase did.

## The bootstrap (what the other skills run)

Before its first step, every other cospec skill does the following:

1. Resolves the cospec root.
2. Reads `<cospec root>/principles.md` when it is there, and takes whatever parses from it: the settings it recognizes, and the principles bullets.
   When a setting is missing, unreadable, or holds a value that the principles-file section above does not list, that setting falls back to its default, and the run says so once - one line, naming what it fell back on and `/cospec-config` as where it gets sorted out.
   Nothing is repaired, migrated, or asked about here: a run someone is waiting on is not the place to fix a settings file.
3. With no file there at all, asks the question below, and on "set it up now" runs the **init flow** inline before it continues.
4. Applies the settings and the principles for the rest of the run.

```question
Question: You have no cospec settings file yet. Should I set one up now?
Header: Setup
- Set it up now (Recommended)
  A few questions about how you like to work - how commits are written, and what cospec may do without asking - and I write the file before carrying on. You answer them once.
- Carry on without it
  I use the built-in defaults for this run and ask again next time. You can also set it up whenever you like with /cospec-config.
```

When the file reads cleanly, the bootstrap produces no message: it says nothing about the settings, the root, or what specs exist.
The init flow is the only flow a bootstrap ever runs.
Everything else about the file - checking it against the shipped template, repairing it, changing it - belongs to a direct `/cospec-config` run.
A skill that cannot find `../cospec-config/SKILL.md` at its sibling path runs on the built-in defaults (the template's values) and says so in its report.

## Init flow

This flow runs when a direct `/cospec-config` run finds no principles file yet, and when another skill's bootstrap offers it and the user says yes.

1. Send one short intro message: cospec keeps a small settings and principles file next to the specs, this is its one-time setup, and the user can change anything chosen here later, through `/cospec-config` or by editing the file directly.
2. Derive the project's commit style: read the project's documented commit rules and its recent commit subjects.
   A clear shape - a type prefix, a ticket key, or any other consistent pattern - becomes the first option below. Write it in plain words, with an example message from this project. When the project shows no consistent shape, drop that option.
   Commits that cospec itself made in the default style do not count as a project convention.
3. Ask the four questions below in **one `AskUserQuestion` call**.

```question
Question: How should the commits cospec makes be written?
Header: Commit style
- <the project's own style, in a few words> (Recommended) (only when the project's commits or rules show a clear shape)
  <the shape found, in plain words, with an example message from this project>.
- The default style
  The spec name, a colon, then what the commit did.
- Conventional prefixes (only when the first option is not itself a type-prefix shape)
  A type prefix, then what the commit did: "feat: ...", "fix: ...", "docs: ...", and so on.
```

When the first option is absent, the default style comes first, and its label carries the "(Recommended)" marker instead.
Save the choice as `commit_style`. Use `default` for the default style, and otherwise use a plain-English description of the chosen shape with an example message in it, including a shape that the user typed themselves.

```question
Question: When exactly one piece of work is open, may cospec pick it up without asking?
Header: Pickup
- Ask me first (Recommended)
  Running /cospec-execute or /cospec-archive confirms which work to start on, even when only one is open.
- Pick it up silently
  They start on the only open work right away.
```

```question
Question: Should runs save their work with git commits as they go?
Header: Commits
- Decide per work (Recommended)
  Each execution plan asks this when it is written.
- Yes, on the current branch
  Every run commits as it goes, on whatever branch is checked out.
- Yes, on a new branch
  Every run commits on its own branch, named by a pattern you can change later.
- No commits
  Runs leave their changes in the working folder for you to handle.
```

```question
Question: And when a run commits, how should the commits be grouped?
Header: Grouping
- Decide per work (Recommended)
  Each execution plan asks this when it is written.
- One commit per phase
  Each finished phase is committed on its own.
- A single commit
  All the work lands in one commit at the end.
```

4. Ask the question below in a **second `AskUserQuestion` call**, right after the four settings questions.
   This is a second call because one call is limited to four questions, and the settings questions already fill one.

```question
Question: Should I read your project now and draft the principles cospec should follow?
Header: Principles
- Draft them from the project (Recommended)
  I read your rule documents, the README, the lint and CI setup, and recent commits, and propose a short list for you to look over.
- Start with none
  The file is written with an empty principles section. You can add principles any time through /cospec-config, which offers the same full draft from your project.
```

On "draft them from the project": read `CLAUDE.md`/`AGENTS.md`, the README, the lint and CI configs, and recent commits, and draft the principles from what they show.
When a rule is already written in the project's own documents, point at it and declare it binding, instead of restating it.
Write down only undocumented conventions and standards for how cospec runs here.
Keep the draft short - five or six principles at most, since every skill reads this file on every run.
This step does not write the draft anywhere yet. Step 5 writes it.

On "start with none": keep the template's empty principles section for step 5 to write.

5. Write `<cospec root>/principles.md`, once: a copy of the installed template, with each setting's value replaced by the answer given, plus the principles section - either the draft or the template's empty section.
6. Only when principles were drafted, ask the user to read them in the file:

```question
Question: I wrote the principles into <cospec root>/principles.md - please read them there. Keep them as they are?
Header: Principles
- Keep them (Recommended)
  The file stays as it is written.
- Change them
  Tell me what to add, reword, or drop, I rewrite the principles section in the file, and I ask again.
```

On "change them": rewrite the principles section in the file from what the user typed, then ask this same question again. Keep looping until the user keeps them.

7. Offer to commit the new file, with the commit gate below and the message `cospec: set up config`, composed in the confirmed style.
8. Continue with whatever the skill was invoked to do.

```question
Question: Should I commit your cospec principles file to git?
Header: Commit file
- Commit it (Recommended)
  I commit only <cospec root>/principles.md, with the message "<the composed message>". I never push.
  (only when the working tree holds unrelated changes) Everything else you have changed is left exactly as it is.
- Don't commit
  The file stays in your working folder for you to handle.
```

On "commit": stage the principles file by path and commit it. Commit only. Never push.

## The doctor

The doctor is the check that `/cospec-config` runs on an existing file, and the one place where any file trouble is dealt with.
No other skill runs it, and it never runs on its own during someone else's work.

Compare the user's file against the shipped template by meaning rather than by bytes, and gather what you find:

- A setting the template has and the file lacks: propose adding it with its default value, and say in the message what it does.
- A setting whose value the principles-file section above does not list: say what the setting does, name the values that exist, and ask which one is meant.
- A setting the file holds that the template no longer has: propose dropping it, since nothing reads it.
- Text the template does not have - an opening note, an explanation under a setting, guidance on writing principles, example principles: propose dropping it, since every skill run reads this file and that material belongs in this skill instead.
  Never touch a line under `## Principles` this way: a principle belongs to the user, however it is worded.
- Template content the file lacks entirely - the settings section, the note line above it: treat this as something the user chose to remove. Name what is on offer, and put back only what the user asks for.
- A file that cannot be read as markdown at all: say so plainly, and offer to write a fresh one from the template, keeping whatever settings and principles the current file still lets you read out.

Nothing found here is an error, and none of it gets applied silently.
Walk through what you found in one short message, in plain words, then ask:

```question
Question: I compared your settings file with the one this version of cospec ships: <what differs, in a line each>. Bring it up to date?
Header: Settings file
- Apply these (Recommended)
  I make those changes. Every setting you chose and every principle you wrote stays exactly as it is.
- Leave it as it is
  Nothing is changed, and everything keeps working on what your file already says.
```

Custom answers - one change and not another - come through free text. The wizard below follows either way.
Write into the file whatever the user accepts. The commit gate at the end of the run covers it, along with anything the wizard changes.

## Running directly - the wizard

When the user types `/cospec-config`, first resolve the cospec root and look at `principles.md`:

- No file yet: run the init flow, minus its final "continue with the skill" step, and stop there. A file just written needs no doctor.
- A file there: run the doctor, then carry on with the wizard below.

Then show one short message in plain words: the commit style, the pickup behavior, the saved planning answers, and a short summary of the principles - or, when the section is empty, the plain fact that no principles are written yet.
Then ask:

```question
Question: Anything you want to change?
Header: Principles file
- Nothing - keep it as it is (Recommended)
  The wizard ends here.
- The commit style
  How the commits cospec makes are written. I can also derive a fresh proposal from your project's commits.
- Pickup and the planning answers
  Whether a lone open work is picked up without asking, whether runs commit as they go, how commits are grouped, and the branch name pattern.
- The principles
  Plain-English principles and rules every cospec skill reads at start and honors best-effort. I show you the ones you have, and you add, reword, or drop them by typing what you want.
```

Changing a setting reuses the matching init-flow question where one exists. The commit style change offers a fresh derivation from the repo, the same way the init flow does.
The principles area also offers the full repo derivation, the same one the init flow runs.
Change the principles and the branch name pattern through free text: the user types, you restate, they confirm.
After each change, ask this question again, so that several things can change in one run.

When the doctor or the wizard changed anything, write the file and end with the commit gate from the init flow, using the message `cospec: update config`.
When nothing changed, end without touching the file.
