# Imagination mode

This file holds imagination mode for `/cospec` (`SKILL.md` in the parent directory).
Read it when you offer the mode, and not before.

## What the mode is

Imagination mode is a divergence budget.
A normal run narrows the work from the first question onward.
A run in the mode holds the space open on purpose, spends real effort to explore wide, and narrows late.

The mode adds no stage.
It adds one question at protocol time, and it gates the exploration stage once more than a normal run.
It changes three things:

- The early stages ask for the ideal first, and practicality waits its turn.
- The UI mocks stage starts with a fan-out: many deliberately different candidate screens, and the user chooses among them.
- The UI mocks stage runs before the technical specs stage, so the spec is written to the direction the user chose.

Token cost is not a concern in this mode.
Depth and range are the point of it.

**Raise a doubt, never guess** stays fully in force.
The mode widens the solution space.
It never lets you settle a doubt on your own.

## The offer

Offer the mode with a follow-up `AskUserQuestion`, right after the protocol answers of step 4 arrive.
Offer it when, and only when, the confirmed protocol includes high-level exploration or UI mocks.
When the protocol includes neither stage, make no offer, and say nothing about the mode.

```question
Question: Should we look for the ideal version of this first, before we settle on what is practical?
Header: Imagination
- Yes, look wide first
  I call this imagination mode: I ask what the best possible version looks like, and I study how others solved work like this. Where there are screens, I design several very different versions for you to choose from. It takes longer, and it often finds an idea a direct run never reaches.
- No, take the direct route
  We work towards a practical answer from the first question, the normal way.
```

The two options stay in this fixed order.
Append "(Recommended)" in place to the one that fits the work:

- The mode, for new user-facing work whose shape is still open.
- The direct route, for a change to something that exists, for work with a decided direction, and for a fix or a chore.

## Direct activation

The user's words outrank the trigger rule.
The user turns the mode on by naming it: in the opening input, or at any time before the technical specs stage writes the spec.
This works even when the trigger would have made no offer.
Ask no offer question when the user already asked for the mode.

**Late activation.**
The mode applies to the stages still ahead:

- Update the protocol list in `README.md`, and put the mocks stage before the technical specs stage where that reorder can still apply.
- Add the mode line to `README.md`, and add a log line for the moment the mode went on.
- Run every stage still ahead in the mode.

For a stage that already finished, judge whether the mode would change its outcome.
When it would, ask:

```question
Question: We already did <the finished step, in plain words>. Should I do it again, this time looking wide first?
Header: Redo
- Yes, do it again (Recommended)
  I run that step again in the new mode. What we have from it stays until the new round replaces it.
- No, keep what we have
  We keep the result we have, and only the steps still ahead of us look wide.
```

## The record and the resume

The `- Mode: imagination` line in `README.md` is the whole record of the mode, and `SKILL.md` states where that line is written and where it is read again.
The "protocol confirmed" log line covers a mode that went on at protocol time.
A mode that goes on later gets a log line of its own, as the late-activation rules above state.

## The stage order

With the mode on, and with both stages in the protocol, the UI mocks stage runs **before** the technical specs stage.
Write the protocol list in `README.md` in that order at protocol time.
The list is the order of the run, so every later agent follows it and needs none of the rules in this file.

The reorder applies only to these two stages.
Every other stage keeps its place.

## High-level exploration in the mode

Run the first pass magic-first.
Name the ideal experience as if everything were possible: no cost, no platform limit, and no legacy code.
**Feasibility talk is not allowed in that first pass.**
Let no answer of your own, and no answer of the user's, pull the conversation to what is practical.
When the user raises a constraint, write it down, and say that it comes back after the ideal is clear.

Practicality enters after the first pass has a gate-confirmed conclusion.
For this reason the stage gates twice.

First, gate the ideal pass with this question:

```question
Question: Is the ideal clear enough now, or is there more to imagine?
Header: Exploring
- The ideal is clear (Recommended)
  I write the ideal down, and then we go over it again against what is really possible.
- Keep imagining
  There is more to picture first.
```

On "The ideal is clear", write the ideal into the `North star` section of `spec/SPEC.md`, and then run the second pass.
That section is the home of the ideal from this point on, and `references/spec-guide.md` defines it.
Create it here, and let the later stages fill in its other parts.
The second pass holds the ideal against the real code, the real cost, and the real limits, and it names what survives.
Gate that pass with the exploration gate of `references/stages.md`, which ends the stage.

## The interview in the mode

Ask for the ideal experience first.
Constraint questions follow.
A constraint then applies to a vision, instead of standing in for one.

Keep the round rules of the interview stage: the stop option, production-grade options, and one focused question or a tight batch at a time.
When a round outgrows the question tool, ask it with an HTML page, as `references/html-questions.md` defines.

## The UI mocks stage in the mode

The stage keeps every rule in its `references/stages.md` section.
The mode puts a fan-out in front of the normal iterative loop.

### The creative research pass

Before the fan-out, study prior art and novel patterns for work of this kind.
Look at how other products solved it, and at patterns the user has probably not seen.
Size the pass by your own judgment.

This pass belongs to the mode, and it is not the research stage.
It leaves no document of its own.
Write what shaped the candidates as a short note in the north-star section of `SPEC.md`.

### The fan-out question

Form your own feel for how many distinct directions this work holds.
Then ask one question round, before you build anything:

```question
Question: I can design several different versions of the screens for you to choose from. They differ on <the axes of variation, a few words each>. How many should I make?
Header: Ideas
- <the count you propose> versions
  <what this many covers, in a line>.
- <a smaller count> versions
  <what this many covers, and what it leaves out>.
- Push for more than that
  I look for directions I have not reached yet, and I come back with a wider set than the counts above.
```

The three options stay in this fixed order.
Append "(Recommended)" in place to your own count.
Name the axes in the question text, since the axes are what makes the candidates different.
A count of the user's own arrives through the free-text choice.

On "push for more": go back to the axes, find directions outside the ones you named, and come back with the wider set.

### The candidates

Build each candidate as a standalone page at `<cospec root>/<slug>/mocks/candidates/<NN>-<short name>.html`.
`<NN>` is the candidate's number, and it runs on across rounds, so no two candidates ever share a number.
The candidate's id is its file name without the extension, for example `03-split-view`.
Use that id in the gallery, and in the selection text.

Every candidate differs from every other one on a named axis.
Name that axis in the candidate's page, in one line at the top.
A candidate that differs only in a color or a word is not a direction, and it does not earn a place in the set.

### The gallery

Write a gallery page at `<cospec root>/<slug>/mocks/candidates/gallery.html`, beside the candidates.
The gallery follows `references/html-questions.md`: the page, how you hand it over, the copy control, the manual-copy fallback, and the themes.

The gallery holds what is its own, and its output format is its own too:

- One line per candidate: its id, its title, and its axis in a few words, with one checkbox.
- No embedded candidate pages. The user opens each candidate in the web interface, which renders every page in the directory.
- "Copy my selection" as the label of the copy control.
- The selection output format below.

```
cospec-selection: gallery
- keep: <candidate id>; <candidate id>
- notes: <what the user typed, on one line>
```

`keep` holds the ids of the candidates the user checked, and it reads `(none)` when the user checked nothing.
`notes` holds the free text box of the page, and it reads `(no answer)` when the user typed nothing.

### The selection

Hand the gallery over with the question in `references/html-questions.md`, and wait.
Its second option, which asks you to come to chat, means this here: name each candidate in chat with its axis, and take the choice there.
The user then selects in one of three ways, and all three are normal:

- The gallery text, pasted into a web-interface comment.
- Plain comments on the candidate pages in the web interface.
- Words in chat.

Read the choice out of whichever arrives, and apply it:

- Move every candidate the user keeps to `<cospec root>/<slug>/mocks/<mock-id>.html`, under a name that says what the screen is. These are now the mocks, and they enter the normal iterative loop of the UI mocks stage.
- Leave every discarded candidate in `mocks/candidates/` as a creative record. A rejected direction can inspire a later feature, so delete none of them.
- Delete the gallery page as soon as you have applied the selection.

List the survivors in the `Mocks` section of `SPEC.md`, as the UI mocks stage requires.
List no candidate there: the `Mocks` section holds the screens to build.

### When nothing is kept

A round can end with zero candidates kept.
Ask what was wrong with them:

```question
Question: None of those versions is right. What was wrong with them?
Header: Ideas
- They are all too close to each other
  I pull the next set further apart, on axes I have not tried yet.
- They all solve the wrong problem
  Tell me what the screens should be about, and I start the next set from that.
- <another reading of the round, in a few words> (one per further reading the round suggests)
  <what you would change on the next set, in a line>.
```

The first two options stay in this fixed order.
Append "(Recommended)" in place to the reading you find most likely, and leave the marker off when you have no view.

Then run another fan-out with fresh axes, informed by the answer.
Keep the discarded set on disk.
This loop has no fixed round limit.
It ends when at least one direction survives, or when the user takes the work somewhere else.

## The north star

When the mode ran, `SPEC.md` carries a north-star section: the ideal experience the run reached for, written beside what the work actually chose.
`references/spec-guide.md` defines that section.

## The mocks checkpoint after the spec

With the mode on, the mocks are approved before the spec is written.
The spec can then settle something the approved mocks show.

After the technical specs gate passes, compare the approved mocks against the approved spec.
Offer a checkpoint when the spec settled anything the mocks show: a flow, a state, a field, a name on the screen, or a rule the screen has to obey.
Name what changed in the question:

```question
Question: The spec settled <what changed, in a line> since you approved the screens. Should I bring the screens up to date with it?
Header: Screens
- Yes, update them (Recommended)
  I revise the screens against the spec, and show you the result for a quick look.
- No, leave them
  The screens stay as you approved them, and the spec is what the work is built from.
```

On yes: revise the mocks, take a re-approval through the normal mocks gate in `references/stages.md`, and add a log line for the re-approval.
On no: change nothing, and add a log line saying the user left the screens as they were.

Offer no checkpoint when nothing the mocks show changed.
