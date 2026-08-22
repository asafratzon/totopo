# Cospec stages

This file holds the stage definitions for `/cospec` (`SKILL.md` in the parent directory).
Read a stage's section when the stage starts, and run the stage from its definition here.

The `question` blocks in this file follow the **Asking questions** section of `SKILL.md`.
Ask them exactly as written, and fill in only the parts in angle brackets.

## The web interface

The spec directory is the whole product: plain files that agents write and the user reads.
`npx cospec` starts the web interface over these files: a local page that renders every file in the spec directory as it stands on disk, splits each document into its `##` sections, and puts a comment box on each one.
Nothing is generated for the web interface, and nothing is kept in step with it - it reads the files themselves, so it is never out of date.

Name the web interface at every gate, the way the gate blocks do: give the command, and give the path of the spec directory, so the user can read the files as they are.
The gates stay in chat, and the page is input, not the decision.
An approval typed in chat is authoritative, however the user used the page.

**When the user reads the files directly.**
Step 5 of `SKILL.md` asks the user whether the page is open, and it records the answer in the `README.md` log.
When that record says the user reads the files directly, change every later question block of this spec in one way: drop the sentence that names `npx cospec`, and give the paths of the files to read in its place.
Change nothing else in the block.
This is the one substitution the asking rules of `SKILL.md` allow, and it is written here once, for every gate.

A resuming session reads the same log line, and it honors the same choice.
The user can flip the choice at any gate, by asking for the web interface: give the command from that gate on, and add a line to the log for the flip.

**Applying feedback.**
A `.cospec/user-feedback.json` file in the spec directory holds feedback from the user that no session has applied yet.
Its presence is also the signal to a resuming session that feedback is waiting.
Apply it in four steps:

1. Rename the file to `.cospec/user-feedback.applying.json`.
   Rename it first: this keeps a submit that arrives while you revise, since it lands on the free name and is applied in the next round instead of being deleted unread.
2. Read the file, and open the asset files it names.
3. Revise the artifacts that its comments ask about.
4. Delete the renamed file and every asset file it named. Delete the assets directory too, when nothing is left in it.

Then ask the gate again, or ask the resume question when this happened on resume.
A leftover `.cospec/user-feedback.applying.json` file means an earlier session was interrupted mid-apply.
Apply it the same way, starting from step 2.

The file names the spec directory it belongs to, in the `entry` field, and holds one round per submit that the user made.
Each round holds one comment per place that the user wrote on: the file and heading the comment sits on, its text, and the images and files attached to it.
Assets are written out beside the JSON file and named by relative path:

```json
{
  "version": 1,
  "entry": "checkout-discounts",
  "rounds": [
    {
      "submittedAt": "2026-08-19T09:41:12.004Z",
      "comments": [
        {
          "unit": "spec-spec-goal",
          "file": "spec/SPEC.md",
          "heading": "Goal",
          "text": "Say plainly that the engine renders any directory, not only a spec.",
          "assets": []
        },
        {
          "unit": "mocks-dashboard",
          "file": "mocks/dashboard.html",
          "heading": "",
          "text": "The archived group should sit below the open work. See the sketch.",
          "assets": [
            {
              "path": "user-feedback-assets/2026-08-19-094112-sketch.png",
              "name": "sketch.png",
              "type": "image/png"
            }
          ]
        },
        {
          "unit": "overall",
          "file": "",
          "heading": "",
          "text": "Good direction overall. My notes on the wording are attached.",
          "assets": [
            {
              "path": "user-feedback-assets/2026-08-19-094112-wording.txt",
              "name": "wording.txt",
              "type": "text/plain"
            }
          ]
        }
      ]
    }
  ]
}
```

`file` is relative to the spec directory.
`unit` is that path with the heading added at the end, both slugified: this is the address of the exact place the comment is on.
One exception: `unit: "overall"` has `file` and `heading` empty, and it marks feedback on the whole spec directory, not on one place in it.
A comment on a section of the review report is input to the finding in that section, the same as any comment on any section.

The user may answer a gate with "I sent my feedback" when neither file is there.
When this happens, do not guess and do not carry on.
Say plainly that no feedback file is in the spec directory, and ask the user to send it again, or to give the feedback in chat instead.
Then ask the gate again.

## Visuals

When a stage document is finished, decide whether a standalone visual would make the user's review meaningfully easier: a diagram, an SVG, or a small HTML figure or chart.
Write the visual as a lowercase file beside the document, when the visual earns its place.
The web interface renders images inline and shows HTML pages in a frame, so a visual beside the document is read on the same page as the document.
When a visual belongs to one section, put it inside the document instead, as inline SVG or as an HTML table or figure.
Either way, the visual is self-contained: no external images, no scripts, and nothing fetched.
This is a judgment call, never a rule: most documents need no visual, and a visual that nobody would look at is not worth writing.

## High-level exploration

Think together before you commit to anything.
Hold an open conversation, not a script, since normal message text and ASCII diagrams are allowed here.
Map the problem space, question assumptions, compare directions, and raise risks and unknowns.
Ground the thinking in the actual codebase when relevant, instead of theorizing.

With imagination mode on, the first pass of this stage names the ideal as if everything were possible, and it allows no feasibility talk.
`references/imagination-guide.md` states how the stage then runs.

Gate when things become clear, then add the conclusions to `spec/SPEC.md` as background and direction:

```question
Question: Ready to move on, or is there more to think through?
Header: Exploring
- Ready to move on (Recommended)
  I write down what we concluded and we start the next step.
- Keep exploring
  There is more to work out first.
```

## Interview

Track down every doubt and unclear point, until the spec can stand on its own.
First read what the input points to, so your questions are sharp: an uninformed interview wastes the user's time.
Open `[NEEDS CLARIFICATION: ...]` markers in `SPEC.md` are the interview's first input.
Read them before you write any question, and turn each one into a question of its own: an earlier stage already judged these doubts worth asking.

Then interview the user, one focused question or a tight batch at a time, most important points first, down to minor points.
With imagination mode on, ask for the ideal experience first, and put the constraint questions after it, as `references/imagination-guide.md` states.
In every round:

- **Always include a stop option**, labeled exactly **"That's enough - stop the interview"**, so the user can end the stage at any moment.
- **Frame options production-grade by default**, and mark that option "(Recommended)".
- **When there is a real trade-off, lay it out** in the question text and in the option descriptions, and let the user decide. Do not decide silently.
- **Cross-reference the code.** When the user's claim contradicts what you read, say so plainly: *"You said partial cancel is possible, but `orders.cancel:42` only cancels the whole order - which is right?"*
- **Pin down vague language.** *"By 'account' do you mean the Customer or the User? They are different here."*
- **Fold each answer into `SPEC.md` right after the round that produced it**, and clear the markers that round settles. This keeps the spec correct mid-interview, so an interview the user stops early leaves nothing living only in chat.

**When a round does not fit the question tool**, ask it with an HTML page instead, as `references/html-questions.md` defines.
Use the page when the round has many questions, when the options of one question outgrow the tool, or when you have no question tool at all.

Check these categories for question candidates, most important first:

- functional scope and non-goals
- domain and data (shapes and contracts)
- UX flow
- non-functional qualities (permissions, tenant scope)
- integrations
- edge cases and failures (empty, loading, error states)
- constraints and trade-offs
- terminology
- completion signals (how success is measured)

For user-facing UI work, always pin down theme support (dark, light, both, or one fixed theme) and target devices (desktop only, responsive, or mobile-first).
The user answers this once; do not guess it.
Whatever stays unresolved becomes a plainly labeled assumption or open question in `SPEC.md`, or a `[NEEDS CLARIFICATION: ...]` marker when it clears the bar set in `references/spec-guide.md`.
The implementer must know what was confirmed and what was assumed.

## Research

Run this stage for work that needs knowledge beyond the codebase: a protocol, a library, an algorithm, or a domain.
Size the research to the work.
Propose the type and depth through a question: for example, a quick focused check against a thorough survey, and which sources are available to you (web search and fetch, when present).
Mark your pick "(Recommended)".
Then research as agreed, and write `research/RESEARCH.md`: what you learned, the options you compared, a recommendation, and sources with links.
Write a finding that decides something as **Decision / Rationale / Alternatives**: what was chosen, why, and what was rejected, with the reason.
When the work involves a real technical choice, such as a stack, a package, or an algorithm, compare the options in the write-up, and use a table when the comparison has more than two axes.
Keep the volume sized to the work: the format is the discipline, not the length.
The choices themselves land in the `Decisions` section of `SPEC.md`, as `references/spec-guide.md` defines.
Consider a visual beside the write-up, as **Visuals** above says.
Then gate on the findings:

```question
Question: <summary of what the research found>. The write-up is in <path to the spec directory>; run `npx cospec` in your project to read it in your browser and comment on it section by section. Is that enough to go on?
Header: Research
- That's enough (Recommended)
  I write the findings up and we move on.
- I sent my feedback
  I read the comments you sent, look into what you asked, and come back.
- Dig deeper into <the area worth more digging>
  I keep looking into that one area and come back with more.
```

## Codebase analysis

Map the parts of the code that the work touches: entry points, data shapes, conventions and existing patterns to follow, and anything that constrains the design.
Use the `Explore` agent for broad searches, and write your findings into `spec/SPEC.md` with `path:line` references.
This stage has no gate of its own; it feeds the following stages.
A contradiction it finds becomes an interview question, a labeled assumption, or a `[NEEDS CLARIFICATION: ...]` marker when it clears the bar set in `references/spec-guide.md`.

## Technical specs

This is the core writing stage.
Fill `spec/SPEC.md` by following `references/spec-guide.md`, and use everything the earlier stages produced.

First, offer a solution sketch:

```question
Question: Should the spec suggest how to build this?
Header: Sketch
- Yes, sketch an approach (Recommended)
  I look at your code and suggest a direction, with a rough idea of which files it touches. It stays a suggestion - whoever builds it can choose differently.
- No, skip the sketch
  The spec says what to build and leaves how to build it open.
```

When the user says yes, scan the codebase as if you were the agent about to build this.
Then offer 2-3 distinct high-level approaches, when the solution space has that many.
Give each approach a short label, and describe the approach and its rough file layout in the description.
Mark your pick "(Recommended)".
Keep the sketch high-level: give a clear starting point and a rough file tree, not a detailed design.

Consider a visual beside the spec, as **Visuals** above says.
Then gate on the finished spec, and loop until the user approves it:

```question
Question: <what the spec says, summarized>. It is in <path to the spec directory>; run `npx cospec` in your project to read it in your browser and comment on each section. Does that look right?
Header: Spec review
- Looks good (Recommended)
  I move on to the next step.
- I sent my feedback
  I read the comments you sent, revise, and ask again.
- I want changes
  Tell me what to change, I revise, and I ask again.
```

With imagination mode on, and with UI mocks in the protocol, this stage runs after the UI mocks stage.
A mocks checkpoint can then follow the gate above, and `references/imagination-guide.md` states when it is offered.

## UI mocks

Run this stage only for work that has a user interface.
Mock screens are web pages that the user opens in a browser.
Start building as soon as the stage starts, and ask nothing first.

With imagination mode on, the stage opens with a fan-out instead: many deliberately different candidate screens, and the user chooses among them.
`references/imagination-guide.md` defines the fan-out, its one question round, the gallery, and the selection.
That question round is the one exception to "ask nothing first".
Every other rule of this section applies to every mock the mode produces.

Each mock is a complete standalone HTML document at `<cospec root>/<slug>/mocks/<mock-id>.html`, where `<mock-id>` is a kebab-case name for the screen.
Use inline styles, no external resources, and images as data URLs.
Standalone HTML lets the agent who builds the work later open the mock on its own.
When both themes are in scope, style both `[data-theme="dark"]` and `[data-theme="light"]` on the root element in the mock's CSS.
When the user chose one theme, or theming is not relevant, generate single-theme mocks.
Make each mock honor the interview's theme and device answers: style the chosen themes, and lay out the screen so it reviews well at the target device widths.
The web interface shows each mock in a frame at desktop, tablet, and mobile width.

List each mock in the `Mocks` section of `SPEC.md`, as soon as the first one exists, following `references/spec-guide.md`.
`README.md` gets nothing beyond the stage checkbox and the log lines that every stage has.

The loop:

1. Build or revise the mock files.
2. Gate with the review question.
3. On submitted feedback: apply it as **The web interface** above defines, and revise each mock file in place. Feedback given in chat drives the same round of changes, minus the file step.
4. On approval: add the approval date to the `Mocks` section in `SPEC.md`. Approval ends the stage.

```question
Question: What do you think of the screens? They are in <path to the mocks directory>; run `npx cospec` in your project to view each one in your browser and comment on it.
Header: Mocks
- They are good - approve them (Recommended)
  These become the screens to build, and this step ends.
- I sent my feedback
  I read the comments you sent and build the next round of screens from them.
- I'll give my comments here
  Tell me what to change and I build the next round of screens from that.
```

## Execution plan

First, unless `principles.md` already saves the answer, ask whether the run commits its work as it goes.
Two more questions shape how the run behaves: the pauses and the review checkpoints.
Ask those later in this stage, once the phase list exists, because their options name concrete phases.

The settings in `principles.md`, read at bootstrap, may answer the commit questions in advance:

- `commit_mode: current-branch`, `new-branch`, or `no-commits` answers the commits question. `commit_mode: prompt` keeps the question exactly as written.
- `commit_grouping: per phase` or `single` answers the grouping follow-up. `commit_grouping: prompt` keeps that question.
  With `commit_mode: no-commits` there is no grouping, so the grouping follow-up is skipped either way.
- With `commit_mode: new-branch`, `branch_naming` names the branch, with `<slug>` replaced by this spec's slug. The branch-name follow-up is then skipped.

A saved answer skips its question silently, and the recording rules below hold, whatever the source of a line.
The plan-review gate still shows the whole setup, so the user can type a per-spec exception there, which changes this plan only, never `principles.md`.

The commits:

```question
Question: Should the run save its work with git commits as it goes?
Header: Commits
- Yes, on the branch I am on now (Recommended)
  Finished work is committed to the branch you are on, so nothing is ever left as unsaved changes.
- Yes, on a new branch made for this work
  The same, but the commits go to a branch of its own, created before the work starts. Merging it back is your call, and I never push.
- No commits
  Every change is left unsaved in your working folder for you to handle.
```

When the user picks either "yes" option, ask a follow-up about how the commits are grouped:

```question
Question: How should those commits be grouped?
Header: Commit size
- One commit per phase (Recommended)
  Each phase is committed as soon as its checks pass. After an interruption, finished means committed, and anything unsaved belongs to the phase that was cut off.
- A single commit for the whole work
  Nothing is committed until the last phase is done, and then it all lands in one commit. If reviewers find something afterwards, their fixes come as a second commit.
```

When the user picks the new branch, ask a follow-up for its name:

```question
Question: What should the new branch be called? You can also type a name of your own.
Header: Branch name
- cospec/<slug> (Recommended)
  Names the branch after this work, and keeps every branch cospec makes together in your branch list.
- <slug>
  The plain name of the work, with no prefix.
```

You may ask both follow-ups in one `AskUserQuestion` call, so the user is not asked twice in a row.
Write the recorded lines once `PLAN.md` exists, either way.

Record the answers as `Commits: none | single | per phase` and `Branch: current | <branch name>` lines in `PLAN.md`:

- "One commit per phase" gives `Commits: per phase`. "A single commit for the whole work" gives `Commits: single`.
- "No commits" gives `Commits: none` with `Branch: current`.
- The current branch gives the chosen grouping with `Branch: current`.
- The new branch gives the chosen grouping with `Branch:` holding the confirmed name.
- Answers saved in `principles.md` record the same way: `current-branch`, `new-branch`, and `no-commits` behave like their matching options; the saved grouping behaves like its matching option; and a name derived from `branch_naming` behaves like a confirmed name.

Then break the work into phases.
**Each phase must fit one session and must leave the repo in a working state.**
Write `plan/PLAN.md` as the overview: the goal, how the run behaves, and the phase list with status checkboxes. Give each phase its goal and a **definition of done**.
Decide the phase boundaries, goals, and definitions of done now, for all phases, since these are cheap to get right in advance.

When you write a plan, do not give much weight to development cost or to output size.
Instead, prefer quality, simplicity, robustness, scalability, and long-term maintainability.
When something has grown unwieldy, restructure it by judgment: refactor, split, or extract. Never restructure by a number set in advance.

Before the plan-review gate, check the plan against the principles that bootstrap read from `principles.md`.
Record the outcome in `PLAN.md` as a `## Principles check` section: write one line per principle that the work touches, saying how the plan honors it.
When a plan must break a principle, record the break in a deviation table with the three columns `Deviation | Why needed | Simpler alternative rejected because`.
Before you record a deviation, look for the simpler alternative, and say in that column why you rejected it.
A deviation is an exception that the user decides on at the gate, and it is not a way to soften the principle, so the fix for a conflict is normally a different plan.

When `SPEC.md` carries requirement IDs, end every phase entry with a `Covers: FR-03, FR-04` line.
Every ID in `SPEC.md` must appear in at least one phase's `Covers` line, though a requirement may span several phases.
An ID that no phase covers means either a missing phase, or scope that belongs in the non-goals.
Add the phase, or move the requirement to the non-goals, before the gate, and ask the user when the call is not yours to make.

**Have `plan/PLAN.md` on disk, with its goal and its full phase list, before you ask the next two questions.**
Both questions name concrete phases, so the user reads the phases before answering, and this file is what they read.
Add the `Pauses:` and `Review checkpoints:` lines to it as their answers arrive.

Then ask the two questions that steer the run: where it stops for the user, and where its work is reviewed.
Ask both in one `AskUserQuestion` call.

**The pauses.**

```question
Question: The plan has <count> phases, and it is in <path to PLAN.md>; run `npx cospec` in your project to read them in your browser. Should the run stop along the way so you can look at what came out?
Header: Stops
- No stops
  I run every phase through to the end and report once.
- Yes, after phase <N> - <phase name>
  I finish that phase, show you the result, and wait for your go-ahead before carrying on.
- Yes, after every phase
  I stop after each phase and wait for your go-ahead, so nothing is built on top of a result you have not seen.
```

A stop lets the user look at the result, or weigh in, before later phases build on it.
The three options stay in this fixed order.
Append "(Recommended)" in place to the one you propose: no stops for a small, low-risk plan; a named phase when one phase is risky, user-visible, or a natural point for feedback; every phase when the user wants to steer the work closely all the way through.
An answer that names several phases, such as "after phases 2 and 4", fits through the free-text "Other" choice.
Record the answer as a `Pauses:` line in `PLAN.md`: `Pauses: none`, `Pauses: after phase 2, after phase 4`, or `Pauses: every phase`.

**The review checkpoints.**
A review checkpoint is a point in the run where fresh reviewers, who did not do the work, judge what has been built so far.
Propose concrete checkpoints, and for each one, say how many reviewers it needs and give a short focus for each reviewer.
Focuses such as correctness against the spec, security, performance, or repo rules and docs consistency are examples, not a fixed menu, so tailor them to the work.

Where to put them:

- **Include the final checkpoint, after the last phase, in every recommendation.** It judges the finished work as a whole.
- Recommend a mid-run checkpoint only under the **dependency-risk principle**: the one risk that justifies pausing for reviewers mid-run is a phase whose incorrect implementation could send later phases wrong.
  Review a complicated phase with no effect on later phases at the end, not mid-run.
  A five-phase plan with no such dependency risk gets only the final checkpoint.
  Postpone reviewers to the final checkpoint whenever dependency risk is absent, since this is the default and it cuts overhead and latency.
- Say why each checkpoint sits where it does, and name the phases: for example, "after phases 3 and 5 - later phases build on what they get wrong".

```question
Question: Who should check the work while it is being built? The phases are in <path to PLAN.md>; run `npx cospec` in your project to read them in your browser.
Header: Review
- <the proposed checkpoints, in a few words> (Recommended)
  <each checkpoint in plain words: where it sits, how many reviewers, what each looks at, and why it is there>.
  (only when Commits: single was chosen) A check before the end reads your working folder, since nothing is committed until the last phase is done.
- No review
  Nothing is checked by anyone but the agent doing the work, and mistakes reach the end of the run unnoticed.
```

Custom setups fit through the free-text choice, or through an added note such as "3 reviewers: security, performance, correctness".
The user's pick is final, so a user who declines every checkpoint gets none.

Record the answer as a `Review checkpoints:` bullet in `PLAN.md`, with one indented sub-bullet per checkpoint that says where it sits, how many reviewers, their focuses, and why it is there.
With no review at all, the line is `Review checkpoints: none`.
Execution reviewers read `principles.md` alongside the spec and the plan, and they treat the deviations that the plan's principles check records as approved exceptions, not as findings.

**Write no phase files now.**
Each `plan/phase-NN-<slug>.md` file has a `Status:` line at the top, tasks as checkboxes, and a **Verify** section stating how to prove the phase done.
The executing agent writes this file just before its phase runs, against the code as it exists after the earlier phases.
A detailed plan for a later phase, written this early, would mostly be guessing.

An executing agent loads `PLAN.md` plus its one phase file, and never the whole plan.

`PLAN.md` follows this layout.
The opening note is copied roughly as written, and the rest adapts to the work.
Include the deviation table only when the plan breaks a principle, and include the `Covers:` bullets only when `SPEC.md` carries requirement IDs:

```markdown
# <Title of the work>

> **For the executing agent - read this first.** Read `spec/SPEC.md` before any phase.
> This plan was written before the work started; check each phase against the actual code before building, and raise anything that looks off instead of pushing through.

- Commits: none | single | per phase
- Branch: cospec/<slug> | <another branch name> | current
- Pauses: none | after phase 2, after phase 4 | every phase
- Review checkpoints:
  - after phase 3: 2 reviewers - correctness vs spec; docs consistency. Later phases build on this one.
  - final: 3 reviewers - correctness vs spec; docs consistency; simpler shapes.

## Goal

<what the work achieves, in a line or two>

## Principles check

<a line per principle the work touches, saying how the plan honors it - or one line saying the plan breaks none>

| Deviation | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| <the principle the plan breaks> | <why the plan needs to> | <the simpler alternative, and why it was rejected> |

## Phases

- [ ] Phase 1 - <name>
  - Goal: <what this phase achieves>
  - Definition of done: <how to tell it is complete>
  - Covers: <the requirement IDs this phase covers>
- [ ] Phase 2 - <name>
  - Goal: <what this phase achieves>
  - Definition of done: <how to tell it is complete>
  - Covers: <the requirement IDs this phase covers>
- [ ] Phase 3 - <name>
  ...
```

Consider a visual beside the plan, as **Visuals** above says.
Then gate on the plan, and loop until the user approves it:

```question
Question: <the phases in a line each, how the work will run, how the plan honors your principles, and any deviation with its reason>. The plan is in <path to the plan directory>; run `npx cospec` in your project to read it in your browser and comment on it section by section. Does that look right?
Header: Plan review
- Looks good (Recommended)
  The plan is set, and /cospec-execute can run it.
- I sent my feedback
  I read the comments you sent, revise, and ask again.
- I want changes
  Tell me what to change, I revise, and I ask again.
```

## Quality review

This is the last stage before finalize.
It reviews everything the spec produced: `spec/SPEC.md`, `research/RESEARCH.md`, the plan, and the mocks that the spec lists, and it also checks whether these documents agree with each other.
Read `references/review-guide.md` when the stage starts, since it holds the reviewer briefs, the detection lenses, the severity levels, and the report format.

**The panel.**
Ask who should review the work.
Propose a concrete panel, sized to the work and to its risk, with one reviewer per focus.
Mark your proposal "(Recommended)", and give a short line saying what each reviewer looks at.
The default proposal has three reviewers: consistency and completeness, principles alignment, and better ways to do this.
Include the "better ways to do this" reviewer in every proposal.
Bigger or riskier work may add a focus of its own, such as security, performance, or the work's own subject, while small work may run with two reviewers.
Always offer an option that turns the review off, labeled exactly **"Skip the review"**. Say in its description that nothing gets checked independently, and that the spec goes straight to finalize.
Custom panels fit through the free-text choice, or through an added note such as "4 reviewers: add security".
On "Skip the review": tick the stage in `README.md` with a log line saying it was skipped, write no `review/REVIEW.md`, and move on. A skipped stage counts as not run, so finalize still keeps its full read-through.

**Running it.**
Run one reviewer per confirmed focus, each as a subagent with a brief from `references/review-guide.md`.
The reviewers work with no shared context: each gets its own prompt, none of them sees this conversation, and none is told what the others found.
An agent with no subagent tool at all runs the same passes itself, one lens at a time, and writes each pass's findings into `review/REVIEW.md` before it starts the next pass.
The report's mode line then says that the review ran inline, and that the fresh-context guarantee did not hold, because the session that wrote the spec is the same session that reviewed it.
An agent that has the capability but cannot make it work stops and asks, and it never downgrades quietly:

```question
Question: This step needs helper agents that look at the work with fresh eyes, and I cannot start them here: <why, in a line>. How should I go on?
Header: Blocked
- Stop here (Recommended)
  I change nothing else. Sort it out when you can, then run /cospec again and it picks up at this step.
- I review it myself instead
  I run the same checks myself, one at a time, and the report says plainly that the review was not independent.
```

**Handling the findings.**
Merge the findings and remove duplicates.
Dismiss any finding you disagree with, and say why in the report.
Fix the findings that are plainly right, apply the fix to the artifacts, and mark those findings applied.
Escalate the taste and scope findings, including "better ways" suggestions, to the user at the gate, with the reviewer's reasoning.
Also bring a finding to the user when it is right but the fix is not obvious, or when acting on it would undo something the user approved at an earlier gate.
Resolve a conflict with a principle by changing the work, not the principle.

**The report and the gate.**
Write `<spec dir>/review/REVIEW.md` in the format that `references/review-guide.md` defines.
Consider a visual beside the report, as **Visuals** above says: where the findings fall across the artifacts is the kind of thing a figure shows faster than a list.
Then gate.

Decide every finding waiting on the user here, in chat.
Name the finding, give the reviewer's reasoning and its options, and take the decision through the question tool: one question per finding, or one call carrying several, as the tool allows.
Ask the gate below in the same round, after those questions.

```question
Question: <what the review found, in a line or two, then a line per finding waiting on you with the reviewer's reasoning>. The full report is in <path to the review directory>; run `npx cospec` in your project to read it in your browser. Ready to move on?
Header: Quality review
- That's settled - move on (Recommended)
  I record what you settled in the report, and we go to the last step.
- I sent my feedback
  I read the comments you sent, apply them, and ask again.
- I want to go over the findings again
  Tell me which findings to act on and how, I apply that, and I ask again.
```

Applying what the user decided updates the artifacts and the report in the way that `references/review-guide.md` defines, then asks the gate again.
A comment the user sent on a finding's section is input to that finding, and it is applied the same way as what the user said in chat.
A user who asks for another round in free text gets one, and there is no automatic re-review loop.
