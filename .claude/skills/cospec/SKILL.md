---
name: cospec
description: Build a work specification in cospec/<slug>/ through a protocol of stages confirmed with the user, or resume one in progress. The question tool drives the skill. User-invoked only.
disable-model-invocation: true
argument-hint: "[description of the work, or the slug of a spec to resume]"
version: 0.11.0
---

# Cospec - build a work specification

This skill runs only when the user types `/cospec`. It never starts on its own.

The skill turns work into a spec directory at `cospec/<slug>/`, one that a fresh agent can open and implement without asking the user a single question, even if that agent never saw this conversation.
All state stays on disk, so the work can stop at any point and continue in a later session, with any agent.

**This skill plans only.**
Do not edit application code while this skill runs, even if the request asks you to build or fix something.
The agent implements the spec through `/cospec-execute` after the spec is ready.

## The one hard rule

**Every interaction with the user goes through `AskUserQuestion`.**
When that tool is not available, ask the question as a normal message that ends your turn.
Interactions include asking, requesting input, offering a choice, and gating a stage.
While you have the tool, never ask the user anything in a normal message.

Uniform gates keep the protocol resumable and easy to follow, because a question asked in a normal message is easy to miss and leaves no state on disk.

- After each question, stop and wait for the result before you do anything else.
- Never advance to the next stage until the user picks an option that moves it forward. The stage gate *is* a question.
- The user can always type a free-text answer or add a note to their selection. Plan for both. Word each option so either one still fits.
- Every question must follow the rules in the section below.

Reading code, searching, and running the `Explore` agent between questions is normal work.
None of this counts as an interaction with the user.

You may write to the user without asking a question in exactly four places:
- The **init flow's intro line** (when the bootstrap runs the one-time setup of the principles file).
- The **collect invitation** (one short line that asks what to work on and invites the user to share everything).
- The **exploration stage** (thinking out loud is its whole point).
- The **closing line** that ends step 7.

**Raise a doubt. Never guess at it.**
While a spec is being built, do not settle any doubt on your own, however small.
This rule applies at every stage, gate, and round of feedback, because a fresh agent builds from the spec without asking anything, and if this session swallows a doubt, the later build will be wrong.

Raise a doubt in one of three ways. The place it comes up decides which way to use.

- Outside a stage that writes `SPEC.md`: ask it right away, as a question under the rules above.
- Inside a stage that writes `SPEC.md`: queue it in place as a `[NEEDS CLARIFICATION: ...]` marker. Ask it at the next round or gate, once it clears the bar set in `references/spec-guide.md`.
- When that bar says the doubt does not earn a question: write it to disk as a plainly labeled assumption, and name the guess you made.

The same rule covers any other guess that has to stand: label it on disk, so no choice stays silent.
`references/spec-guide.md` holds the bar, the limit on how many markers can stay open at once, and the priority order among candidates.
This paragraph and that file state one rule, not two.

**Waiting is a hard stop.**
When you invite the user to type freely, or they say they are about to, end your turn and wait for their message.
Do not ask another question in the meantime.
Do not start the next stage.
This rule applies at every wait point in this skill: once you ask or invite, the turn is over until the user replies.

**A question asked as a normal message still states the options and marks your recommendation.**
The gates and the waiting rule still apply.
`AskUserQuestion` is simply the preferred way to ask.
The same goes for the `Explore` agent: use it when it is available, and search directly when it is not.

**A round of questions that outgrows the question tool goes on an HTML page.**
`references/html-questions.md` defines this technique: when to use it, the page, the answer format, how you hand the page over, and where the page lives.
The page is a way to ask, not a way to gate: every gate stays in chat, under the rules above.

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

When you read a block:

- Copy the question text, the header, the option labels, the descriptions, and their order exactly as they stand.
- Angle brackets mark the only parts you fill in, for example `<slug>`, `<phase name>`, `<count>`.
- A line in a block may mark an option as conditional (`only when ...`) or repeated (`one per ...`). Every other line is always present.
- Never reword anything to fit the moment, and never add options.
- One substitution is allowed: a user who reads the files directly gets file paths in place of the `npx cospec` sentence. `references/stages.md` states this rule once, in its "The web interface" section, and it is the only change any block ever takes.
- `AskUserQuestion` appends its own free-text choice, so a block never needs an option that only means "something else".
- A block does carry a named alternative when a typed answer leads somewhere real.

Every question, block or not, follows these wording rules:

- Write for someone who has never used cospec.
- Do not use internal terms - spec directory layout, phase files, stage names - unless the option explains them in the same breath.
- The recommended option comes first, and its label ends with `(Recommended)`.
- When the order is fixed for another reason, such as the stage list, append the marker in place instead of reordering.
- Keep labels short.
- Put reasoning and trade-offs in the descriptions.

## What a finished spec is

A complete spec lets a fresh agent open the directory with no other context and know what to build.
The agent learns where the edges are, how to tell when the work is done, and roughly where the code goes.
No questions for the user remain.
Aim for a production-grade spec every time.

## State on disk

Find all cospec state under the **cospec root** - a `cospec/` directory next to the project the skills are installed for.
`../cospec-config/SKILL.md` resolves the cospec root location.

Use one directory per stage that produces a document.
Each directory holds that document in uppercase, plus any lowercase artifacts beside it.
`README.md` sits alone at the root, above them.

```
cospec/
  principles.md          the user's settings and principles, owned by /cospec-config
  <slug>/
    README.md            confirmed stages and their status - the resume point, read first
    spec/                the specification, grown by every stage that writes into it
      SPEC.md
      *.md, *.svg, ...   inputs the user shared, and visuals written beside the spec
    research/            written by the research stage, if selected
      RESEARCH.md
    mocks/               written by the ui-mocks stage, if selected
      <mock-id>.html     one standalone page per mock screen, revised in place
      candidates/        imagination mode's candidate screens; those not chosen stay here as a record
    plan/                written by the execution-plan stage, if selected
      PLAN.md            overview: goal, commits and branch, pauses, review checkpoints, principles check, phases with definitions of done and the requirements they cover
      phase-NN-<slug>.md one per phase: status, tasks, verify steps (written during execution, just before its phase)
    review/              written by the quality review stage, if selected
      REVIEW.md
  archive/
    YYYY-MM-DD-<slug>/   completed and signed-off specs
```

A stage directory appears once its stage produces its document, and nothing is created empty.
The web interface renders the directory as it finds it.
This layout is a convention of these skills, not something a program depends on.

### README.md format

```markdown
# <Title of the work>

- Created: YYYY-MM-DD
- Status: specifying | ready | executing | complete
- Mode: imagination        (only while imagination mode is on)

## Protocol

- [x] Codebase analysis
- [ ] Technical specs
- [ ] Execution plan

## Log

- YYYY-MM-DD: protocol confirmed
- YYYY-MM-DD: codebase analysis complete
```

The protocol list holds only the stages the user confirmed, in the stage order set in step 4 of the flow.
The list itself is the order of the run, so follow the list, not the default order, wherever the two differ.
The mode line is present only while the mode is on, and `references/imagination-guide.md` states what the mode does.
Update `README.md` the moment a stage completes: tick its checkbox and add a dated log line.
This file is the single source of truth for where the spec stands, and it is the first file any resuming agent reads.

### The web interface

The files are the whole product: agents read and write them, and the user reads the same files in a browser by running `npx cospec`.
This command renders the spec directory as it stands and takes comments on any part of it.
Nothing is generated for the web interface, and nothing has to be kept in step with it.
`references/stages.md` defines how the web interface names steps at the gates and how it applies the feedback it writes, in its "The web interface" section.

## Flow

Before step 1, run the bootstrap defined in `../cospec-config/SKILL.md` (its "The bootstrap" section).
The bootstrap does the following:
- Resolve the cospec root.
- Read `<cospec root>/principles.md` when it exists, and take what parses from it.
- Offer the one-time setup when no file exists at all.
- Apply the settings and the principles for the rest of the run.

When the file cannot be found at its sibling path, run on the built-in defaults and say so in the closing message.

### 1. Start

If the user passed text with `/cospec`, treat it as their opening input.
If that text names a directory under `cospec/`, or clearly points to an existing spec, go to Resume.

With no input, and no spec directories under the cospec root other than `archive/`, there is nothing to pick up.
Skip the start question below and go straight to the collect invitation in step 3.

With no input, but with a spec to pick up, ask:

```question
Question: What do you want to work on?
Header: Work
- Something new
  Tell me what you have in mind, in as much or as little detail as you like.
- <title of the spec> (one per directory under cospec/, ignoring archive/)
  Pick up where we stopped: <what is done so far, in a few words>.
```

### 2. Resume (existing spec only)

Read `README.md` and every artifact that exists in the spec directory.

A `- Mode: imagination` line in `README.md` means the work runs in imagination mode.
Read `references/imagination-guide.md` then, and run every stage still ahead in the mode.

The log in `README.md` also holds how the user reads the artifacts.
Honor that record at every gate of this run, as the "The web interface" section of `references/stages.md` states.

A `.cospec/user-feedback.json` file there holds feedback the user sent that no session has applied yet.
A `.cospec/user-feedback.applying.json` file holds a round an earlier session was interrupted while applying.
Apply what is there first, following the definition in `references/stages.md`.
Put what it changed into the question below, in its `<where it stands>` part.

Then ask:

```question
Question: <title> is at <where it stands, in a few words>. What now?
Header: Resume
- Continue (Recommended)
  Pick up at the next unfinished step: <name of that step>.
- Change something we already did
  Tell me what to redo, and we go back over it before continuing.
- Change the steps themselves
  Add or drop steps from the list we agreed for this work.
```

Revising loops back through this question until the user chooses to continue.
If the steps change, re-run the protocol question from step 4 and update `README.md` before you move on.

### 3. Collect

Let the user share everything they have, in their own words, before you start asking questions.

Send this invitation as one short normal message, with this fixed wording:

> Tell me about the work. Paste everything you have - notes, links, screenshots, file paths, snippets, examples, prior art - in one go, and I'll take it from there.

Use this wording whether the user picked "Something new" in step 1 or came straight here because there was nothing to pick up.
Then end your turn and wait. Skip the invitation when their opening input already covers this.

Once their input is in, run a gate loop with `AskUserQuestion`:

```question
Question: Anything else before I start asking questions?
Header: Your input
- That's everything - continue (Recommended)
  I have what I need to get started.
- I have more to add
  Send it in your next message and I'll wait for it.
```

"More to add" means they type again. Wait, then ask the gate again.
Note any files or images they shared. You save them into `spec/` in step 5.

### 4. Choose the protocol

First, quickly read what the input points to in the codebase, enough to judge the shape and size of the work.

Then deduce which stages this work needs, and confirm them with the user in **one `AskUserQuestion` call that contains both of these questions**.
(These are two separate questions because the tool limits each question to four options.)

```question
Question: Which steps should we run before writing anything down?
Header: Discovery
Multi-select: yes
- High-level exploration
  We think the problem through together first - directions to take, risks, and what is still unclear.
- Interview
  I ask you focused questions until nothing important is left open.
- Research
  I look outside your code - a library, a protocol, an algorithm, a subject area - and write up what I find.
- Codebase analysis
  I read the parts of your code this work touches and note what shapes the design.
```

```question
Question: And what should this work produce?
Header: Deliverables
Multi-select: yes
- Technical specs
  A written specification another agent can build from without asking you anything.
- UI mocks
  Mock screens you open in your browser and comment on before anything is built.
- Execution plan
  The work split into phases, each with a goal and a way to tell it is done, ready to run with /cospec-execute.
- Quality review
  Fresh helper agents review everything we wrote - the spec, the research, the plan, the screens - and I fix what is plainly wrong and bring the judgment calls to you.
```

The stage order in both blocks is fixed, whatever order the run itself takes.
Append "(Recommended)" in place to each stage you propose, rather than moving it to the front.
Append one sentence to that stage's description, saying why it suits this work.

Use these rough rules to decide what to recommend:

- Bug fix: codebase analysis plus execution plan.
- Small feature or chore: interview plus codebase analysis plus execution plan.
- New user-facing feature: exploration plus interview plus codebase analysis plus technical specs plus UI mocks plus execution plan.
- Work that touches a subject you or the user do not know well: add research.
- Pure thinking, or a decision to make: exploration, maybe research, and no plan.
- Large or risky work: add quality review. (Many phases, several stages feeding one spec, or anything that touches security, data, or money.)

The confirmed selection becomes the protocol.
The selection only decides which stages run.
The stage order stays as listed above, unless imagination mode reorders it.

**Then offer imagination mode**, in a follow-up `AskUserQuestion`, once the protocol answers are in.
Offer it when, and only when, the confirmed protocol includes high-level exploration or UI mocks.
`references/imagination-guide.md` holds the offer question, and the whole mode.
Read that file when you offer the mode, when the user asks for it by name, and when `README.md` records it.
A run that reaches none of those three points reads nothing there.

### 5. Create the spec directory

Propose a kebab-case slug for the intent, through a question.
Put your suggestion first, and end it with "(Recommended)".
On confirmation, create `<cospec root>/<slug>/` and write `README.md` there, with the confirmed protocol and Status: specifying.
With imagination mode on, write the `- Mode: imagination` line there too, and write the protocol list in the stage order that `references/imagination-guide.md` sets.
Save any files or images the user shared into `spec/`, under lowercase names of their own.
Everything the early stages learn flows into `SPEC.md` beside them.

**Then tell the user there is something to read.**
This is the first moment the work has files, so it is the moment to get the user reading them.
Ask this question:

```question
Question: Your work has its own files now, in <path to the spec directory>, and you can read them in your browser as I write them. Run `npx cospec` in your project directory, and open the address it prints. Run it on your own machine when I am working on a remote machine or inside a container. Is the page open?
Header: Reading
- Yes, it is open (Recommended)
  Every time I ask you to look at something, I point you at that page, where you can comment on any part of it.
- It does not work
  Tell me what happened, and I help you until it runs.
- I read the files myself
  I give you the file paths instead of the page, every time I ask you to look at something.
```

On "it does not work": help the user until the page runs, then ask this question again.
The user may give up on it, and that answer counts as "I read the files myself".

Record the outcome in the `README.md` log, in one line: the page is open, or the user reads the files directly.
`references/stages.md` states what that record changes at every later gate, in its "The web interface" section.

### 6. Run the stages

Run the stages in the order the protocol list in `README.md` shows.
`references/stages.md`, next to this file, defines each stage.
When a stage starts, read its section there and run the stage from that definition, because that definition carries gates and rules the stage name alone does not state.

Every stage that writes into `SPEC.md` also uses `references/spec-guide.md`.
This file defines what goes into `SPEC.md`.
The technical specs stage writes the whole file from it.
Every stage ends at a question gate, except codebase analysis: it feeds the next stage directly and has no gate of its own.

Every stage gate also clears the open markers.
Before you ask a gate, read `SPEC.md` for open `[NEEDS CLARIFICATION: ...]` markers.
Ask them there, whichever stage opened them.
Take them in the priority order set in `references/spec-guide.md`, within its limit.
Use the same `AskUserQuestion` call as the gate where the tool has room for them.
Use a separate call before the gate where it does not.

Each answer replaces its marker in `SPEC.md` in the same round.
The gate is then asked against a spec that no longer carries that marker.
This is what makes every marker reach the user.
Codebase analysis has no gate of its own, so what it opens is asked at the gate of the stage that follows it.
The interview stage asks its open markers during its own rounds, because those rounds are its question spots.

When a stage completes, tick it in `README.md` and add a log line before you start the next one.

### 7. Finalize

When the last stage is done, read every file in the spec directory from start to end, and check the following:
- Every assumption and open question is labeled as such.
- No two files disagree.
- Each requirement carries its own acceptance criterion, where the spec carries requirement IDs.
- (Where the protocol includes the execution plan stage) Every ID appears in some phase's `Covers` line.

Skip `mocks/candidates/` in this read-through: it holds directions nobody chose, and `references/review-guide.md` states why it stays out of a review.

When the quality review stage has left a `review/REVIEW.md` in the spec directory, the read-through covers less ground.
Read only the parts no reviewer saw: the fixes the stage made to the artifacts, and the edits that came from the user's finding decisions at the review gate.
Run the same checks over those parts.
Treat the rest as covered, because the stage already ran the deeper version of this check over it.

With no `review/REVIEW.md` in the directory, the read-through covers every file, as written above.
Ask any `[NEEDS CLARIFICATION: ...]` marker still left in `SPEC.md` before the gate.
Each answer replaces its marker there.
The gate below does not pass while a marker stays open.

Then ask:

```question
Question: <what the spec covers, in a sentence or two>. It is all in <path to the spec directory>. Run `npx cospec` in your project to read it in your browser. Ready to finalize?
Header: Finalize
- Looks good - finalize (Recommended)
  I mark the spec ready and stop changing it.
- I sent my feedback
  I read the comments you sent, revise, and ask again.
- I want changes
  Tell me what to change, I revise, and I ask again.
```

On "changes", the user tells you what to change, you revise the files, and you ask again. Loop until they finalize.
Apply feedback the user sent from the web interface the same way, then ask the gate again.

After they finalize: set Status: ready in `README.md` and add a log line.

Then ask one more `AskUserQuestion`:

```question
Question: Should I commit the spec to git?
Header: Commit spec
- Commit the spec (Recommended)
  I commit only the files of this spec, with the message "<the message composed from the commit style in principles.md>". I never push. You can also just type a different message.
  (only when the working tree holds unrelated changes) Everything else you have changed is left exactly as it is.
- Don't commit
  The files stay in your working folder for you to handle.
```

On "commit": stage `<cospec root>/<slug>/` by path and commit it with a one-line message.
Compose the message from the commit style in `principles.md`, with "spec ready" as its descriptive part.
Only commit. Never push.
Staging by path leaves every other change in the working tree untouched.

Close with one short message after this gate.
State the path to the spec directory, that `npx cospec` opens it in a browser, whether it was committed, and, when a plan exists, that `/cospec-execute` will run it.
