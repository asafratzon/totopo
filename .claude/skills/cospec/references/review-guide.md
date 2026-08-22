# The quality review

This file gives the reviewer briefs, the detection lenses, the severity levels, and the report format for the quality review stage of `/cospec`, whose definition is in `stages.md`.
Read this file when the stage starts, not before.

**The reviewer brief.**
Every reviewer subagent gets this brief, with the angle-bracket parts filled in.
An agent that runs the review inline acts as both the reviewer and the assembler, and the stage section in `stages.md` tells you what that agent writes.

```markdown
You are reviewing a written specification you did not help write.
Your focus is <the reviewer's one focus>, and the lenses that belong to it are <the lenses of that focus>.

Read every file in the spec directory at <path to the spec directory>, in this order, whichever of them exist: `README.md` first, since it tells you which stages this work ran, then `spec/SPEC.md`, `research/RESEARCH.md`, `plan/PLAN.md` and the phase files beside it, and every page directly under `mocks/`.
Skip `mocks/candidates/`: it is a creative record of directions nobody chose, and it is not part of the work under review.
The screens to build are the mocks that the `Mocks` section of `spec/SPEC.md` lists.
Read `<cospec root>/principles.md`.
Read the repo's own rule files, `CLAUDE.md` and `AGENTS.md`, wherever they exist.

Judge the artifacts as written.
Do not take the conclusions of the session that wrote them as settled: you were not in that session, and judging this work with fresh eyes is exactly your value.
You share no context with the other reviewers, you are not told what they found, and you must not ask another agent for context.
The deviations recorded in the plan's principles check are exceptions the user already approved, so raise one only when the reason written next to it does not hold.

Before you read anything, turn your lenses into a checklist: one check per lens, split further where a lens covers several things.
Then run every check, and return that checklist in your reply, with a pass or fail line per check.
Return every failed check in your reply as a finding, carrying its severity from the severity levels below, the artifact and the section it points at, a one-line title, and the reasoning behind it.
When a check fails on a decision that is the user's to make rather than a plain fix, say so, list the options, and name the one you would pick.
A check that passes can still leave you with something better to propose - a simpler shape, a design choice you would make differently, code the repo already ships that does part of the work.
Report that as a finding in the same form, and in its reasoning, say that nothing failed and this is an improvement you are offering.
Give it the severity of what it would be worth.
Give your findings no id and no state, and write no header block: the agent running the review assembles the report and fills those in.
A finding you are unsure about is still reported, and you say in its reasoning that it is a judgment call, rather than dropping it.

Change no file and write nothing to disk.
Your reply is everything you produce.

<the severity levels of this file, copied into the brief>
```

**The detection lenses.**
Each lens has one line below, so a brief can name the lenses that belong to its focus.

- Inconsistency between artifacts - reads `spec/SPEC.md`, `research/RESEARCH.md`, `plan/PLAN.md` and the mocks against each other for two statements that cannot both be true.
- Coverage of the requirements - see the block below.
- Missing detail and unhandled edge cases - reads the requirements and the flows for the empty, error, and limit cases nobody wrote down.
- Ambiguity and untestable requirements - reads `spec/SPEC.md` for an open `[NEEDS CLARIFICATION: ...]` marker, a requirement with no acceptance criterion, and a requirement nobody could call pass or fail.
- Duplication and overlap - reads the artifacts for the same thing stated twice, in two places that can drift apart.
- Terminology drift - reads every artifact for one idea under several names, or one name over several ideas.
- Principles alignment - reads the artifacts against `principles.md` and the repo's own rule files.
- Better ways to do this - reads the design against the codebase for a simpler shape, and for code the repo already ships that does part of the work.

The consistency-and-completeness reviewer takes every lens except principles alignment and better ways to do this, which go to the reviewers of those names, and a focus outside the default set takes the lenses that touch it.
Every lens goes to exactly one reviewer on the confirmed panel, so a panel that drops a focus hands that focus's lenses to the reviewer nearest to it.

**The coverage lens.**
When the work's protocol includes the execution plan stage, the coverage lens runs two checks.
It checks that every requirement ID in `spec/SPEC.md` appears in some phase's `Covers` line in `plan/PLAN.md`, and it also checks that every ID named in a `Covers` line exists in `spec/SPEC.md`.
A requirement with no plan coverage is a CRITICAL finding.
The reviewer states which of two causes it looks like: a missing phase, or scope that belongs in the non-goals.
When the protocol has no execution plan stage, the lens checks instead that every requirement carries its own acceptance criterion, and is phrased so a reader can call it pass or fail.

**The severity levels.**

- **CRITICAL** - a principles violation, a contradiction between artifacts, or a requirement with no plan coverage.
- **HIGH** - a conflicting or untestable requirement, an ambiguous security or performance attribute.
- **MEDIUM** - terminology drift, an edge case with missing detail.
- **LOW** - style and wording.

Fix a conflict with a principle by changing the work.
Never resolve it by softening the principle.

**The report format** for `<spec dir>/review/REVIEW.md`:

```markdown
# Quality review - <title of the work>

- Run: YYYY-MM-DD
- Mode: fresh-context subagents | inline - the session that wrote the spec
- Panel: <one focus per reviewer>
- Findings: <total>, of which <n> applied, <n> dismissed, <n> waiting on you

## <the first reviewer's focus>

- [x] <a check this reviewer ran and passed>
- [ ] <a check it ran and failed>

### RV-01 - <the finding in one line>

- Severity: HIGH
- Points at: SPEC.md, the Requirements section, FR-04
- State: FOR YOUR DECISION
- Options: <first option> | <second option>
- Reasoning: <why the reviewer raised it>
- Note: <the fix that was applied, the reason it was dismissed, or what the reviewer recommends when it is waiting on the user>

### RV-02 - <the finding in one line>

- Severity: MEDIUM
- Points at: SPEC.md, the Data section
- State: APPLIED
- Reasoning: <why the reviewer raised it>
- Note: <the fix that was applied>

## <the second reviewer's focus>

...
```

The running agent assembles this report from the reviewers' replies.
It writes the header block, and it puts each reviewer's checklist and findings under that reviewer's focus.
It assigns the ids and the states there.
The focus is the area name, and the report also shows which reviewer raised each finding.
Finding ids run `RV-01`, `RV-02`, and so on, in writing order across the whole report.
An id never changes later, so a decision or a comment that names a finding still points at the same finding.
`State:` holds one of three values: `APPLIED`, `DISMISSED`, or `FOR YOUR DECISION`.
A finding that waits on the user carries an `Options:` line, with the recommended option first.
A finding in any other state leaves that line out.
The report keeps every finding, including the applied ones and the dismissed ones.
A finding the user decides on at the gate keeps its id, and gains the outcome in its `Note:` line.
Applying that decision changes its `State:` line.
The state moves to `APPLIED` when the decision changed the artifacts, and it moves to `DISMISSED` when the user chose to leave the artifacts as they are.
Either way, the agent drops the `Options:` line and updates the counts in the header block.
Those same ids are what a decision refers to.
The user decides findings that wait, in chat, at the gate.
A comment the user sent on a finding's section is input to that finding, named the way plain writing names it.
</content>
