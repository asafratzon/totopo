# What goes in SPEC.md

The technical specs stage of `/cospec` uses this guide, and every other stage that writes into `SPEC.md` uses it too.

**No fixed template.**
Write the sections that the work needs, and name and order them to fit the work.
A small chore may need only a few lines, and a large feature may need many sections.
Common sections are: goal, context or background, scope and **non-goals**, requirements or behavior, edge cases and errors, data and contracts, constraints, and acceptance criteria.
For constraints, follow the repo rules in `CLAUDE.md` or `AGENTS.md`.
Drop each section that does not apply.
Label anything left open as an **assumption** or an **open question**.
Write each date as an absolute date.
Reference code as `path:line`.

**Mark each ambiguity that is worth the user's time.**
Write the mark where the ambiguity sits, in this form: `[NEEDS CLARIFICATION: <the specific question>]`.
Add a mark when a choice changes the scope or the behavior by a large amount, when more than one reading is reasonable, or when no reasonable default exists.
For every ambiguity below that bar, write a labeled assumption that states the guess taken, so that no choice stays silent.
**At most 3 markers stay open at one time.**
When more candidates pass the bar than that, keep the markers in this order of priority: scope first, then security and privacy, then user experience, then technical detail.
Turn the rest into labeled assumptions.
To clear a marker, ask the user, and the answer then replaces the marker in `SPEC.md`, in the same round where the user gave the answer.
The stages that write `SPEC.md` follow this rule: raise a doubt, do not guess at it.
A marker is the queued form of that rule inside those stages: the doubt waits, and the agent asks it at the next round or gate.
A doubt anywhere else in the flow does not wait, and the agent asks it right away.
The finalize gate does not pass while a marker stays open.

**Requirements carry IDs and acceptance criteria when the work's protocol includes the execution plan stage or the quality review stage.**
When the protocol includes neither stage, write the requirements in plain language instead.
Number each ID in the order written, as `FR-01`, `FR-02`, and so on.
Never renumber an ID after you write it, so that a phase or a finding that names an ID still points at the same requirement later.
Give each ID exactly one requirement.
Phrase each requirement so that a reviewer can call it a pass or a fail.
Under each requirement, write its acceptance criterion on its own line, in the form `AC: <how to tell it holds>`.
The spec also states overall success criteria: the measures that show the work is done.
Write each success criterion so that you can measure it, and write it without naming a specific technology where the work allows this.
Success criteria carry no IDs.

```markdown
- **FR-01**: the cart banner shows the discount total on every page of the checkout flow.
  AC: a cart with a discount shows that total on cart, address, and payment.
- **FR-02**: an expired discount code is rejected with a message naming its expiry date.
  AC: submitting an expired code leaves the total unchanged and shows that date.
```

**Add a `Decisions` section to any work that picks a stack, a package, or an algorithm.**
Write one entry per choice.
Each entry states the choice, the reason for the choice, and the alternatives that the work rejected, with the reason for each rejection.
The research stage produces the comparison that supports each decision, and the spec records the outcome of that comparison.

**Add a `Mocks` section when the UI mocks stage runs.**
Write one line per mock screen.
Each line states the screen's id, its title, and the path to its page, relative to `SPEC.md`.
After the user approves the mocks, add a line in the form `Approved: YYYY-MM-DD`.

```markdown
## Mocks

- `cart-banner` - Cart banner - ../mocks/cart-banner.html
- `discount-field` - Discount field - ../mocks/discount-field.html

Approved: 2026-08-14
```

**Add a `North star` section when the run ran in imagination mode.**
Add it under no other condition: a run without the mode has no such section.
The section holds the ideal experience the run reached for, written beside what the work actually chose.
Write it in three parts:

- The ideal, in a few lines: what the best possible version of this work does for the user.
- What the work chose, and what the choice gives up against the ideal.
- A short note on what shaped the candidates: the prior art and the patterns the creative research pass found.

The executing agent steers its small decisions by this section, so write the ideal in terms of what the user gets, not in terms of files.

```markdown
## North star

The ideal: the reader answers a comment where they are reading, and never loses their place.
A comment that needs a second pair of eyes reaches that person in the same breath, with no copied link.

Chosen: the comment box opens in place, under the paragraph it belongs to.
The ideal also wanted the second reader pulled in from the box itself, which the chosen shape gives up, because the work has no way to reach a second reader yet.

What shaped the candidates: the in-place comment threads of document editors, and the review queues of code hosts, which showed how far a reader will follow a comment before they lose their place.
```

**Add a visual to a section only where the visual earns its place.**
Put the visual in the markdown file itself: an inline SVG diagram for a flow or an architecture, or an HTML table or figure where markdown cannot show the same thing.
This way the agent that reads `SPEC.md` and the user who reads it in the web interface see the same content.
The same rule applies to `PLAN.md` and `RESEARCH.md`.
Place a visual that stands on its own beside the document instead, as stated in `stages.md` under **Visuals**.
In both cases, keep the visual self-contained: use no external image and no script.

**Every spec must contain these two items.**

**1. This note at the top of the spec, copied close to as written:**

> **For the implementing agent - read this first.** This spec was written during planning with limited knowledge of the code.
> Before building anything, review it carefully against the actual codebase and **plan first** (in plan mode, where your environment has one).
> Treat nothing here as settled: if the spec turns out misaligned with the code, or you see a better path, **push back and raise it** rather than building something you can tell is off.

**2. When the spec contains a solution sketch, add this note inside that section, copied close to as written:**

> **This solution sketch is non-binding.** It is a suggested direction formed with limited knowledge during spec-writing, not a fixed instruction.
> The implementing agent is free - and expected - to find the better design while building, and must flag any noticeable departure so the user stays informed.
