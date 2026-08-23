# Quality review - totopo v4 cleanup and the chamba pivot (reviewed under its earlier title, "v4 - web-first totopo")

- Run: 2026-08-22
- Mode: fresh-context subagents
- Panel: consistency and completeness | principles alignment | better ways to do this | security of the new web surface
- Findings: 36, of which 36 applied, 0 dismissed, 0 waiting on you

Eight findings folded into four decisions the user took at the gate on 2026-08-22: the sandbox model for published pages (RV-02, RV-12, RV-26, RV-27), arrival behavior in the pane (RV-06, RV-25), the scope of resume adoption (RV-17), and a mid-run security checkpoint (RV-36). All four are applied to the artifacts.

## Consistency and completeness

- [ ] Inconsistency between artifacts (spec vs plan vs mock, and within the spec)
- [x] Coverage: every spec requirement ID appears in some phase's Covers line (FR-01..FR-29 all covered; FR-13 and FR-15 intentionally split across phases 5 and 6)
- [x] Coverage: every ID named in a Covers line exists in spec/SPEC.md (no phantom IDs)
- [ ] Missing detail and unhandled edge cases (empty, error, limit)
- [x] No open [NEEDS CLARIFICATION] markers
- [x] Every requirement carries an acceptance criterion
- [x] Every requirement can be called pass or fail (with a note: FR-16/FR-28 ACs depend on agent behavior and are flaky, but a human can call them)
- [ ] Duplication and overlap that can drift
- [ ] Terminology drift

### RV-01 - Nudge example points at an ephemeral /tmp path that contradicts the persistent artifacts contract

- Severity: CRITICAL
- Points at: SPEC.md, Data and contracts, "The nudge" vs "Artifacts directory"
- State: APPLIED
- Reasoning: the contract says pages live host-side, bind-mounted, never swept; the nudge example read `/tmp/webterm-artifacts/<sid>/...` - a different root, ephemeral by convention, and the only container-side path in the whole document. Both cannot be true; it looked like a leftover from an earlier ephemeral design.
- Note: the contract now names the container mount point (`~/.webpane`) once, and the nudge example uses it.

### RV-02 - The script/sandbox policy for published pages is ambiguous, and the feedback wiring depends on the answer

- Severity: HIGH
- Points at: SPEC.md, Non-goals + FR-17/FR-18 + Edge cases
- State: APPLIED
- Reasoning: the non-goals forbid scripts "beyond the feedback form wiring", an edge case mentions a "sandboxed frame" whose attributes are defined nowhere, and the form-wiring contract requires a server-injected script to run - so scripts must execute, and nothing forbids agent-authored ones. The choice of sandbox attributes decides whether a malicious page can reach the interface key. This is the user's call, not a plain fix.
- Note: the user chose the recommended sandboxed frame at the gate. The spec now defines the sandbox model under Data and contracts (srcdoc/blob, sandbox="allow-scripts allow-forms", no allow-same-origin, postMessage form wiring, no key in the frame), and the non-goal is reworded to match.

### RV-03 - Terminology drift on the feature's own name, against the spec's explicit one-name rule

- Severity: MEDIUM
- Points at: SPEC.md Goal/Scope/Requirements heading; mocks/pages-pane.html title and axis
- State: APPLIED
- Reasoning: the naming section mandates one name, "web pane", everywhere - yet the Goal said "illustration pane", the Scope item and requirements heading were headed "Illustration pane", and the mock said "Pages pane". Three names for one idea inside the artifacts that define it.
- Note: all renamed to "Web pane" in the spec and the mock.

### RV-04 - The helper is called `totopo-show` in the solution sketch but `webpane` everywhere else

- Severity: MEDIUM
- Points at: SPEC.md, Solution sketch, container-image bullet
- State: APPLIED
- Reasoning: a stale name from an earlier draft, in exactly the artifact an implementer reads against the code.
- Note: the sketch now says `webpane`.

### RV-05 - The collapsed spine's badge shows the total page count where the spec says unread count

- Severity: MEDIUM
- Points at: mocks/pages-pane.html spine badge vs SPEC.md FR-14
- State: APPLIED
- Reasoning: FR-14 says the spine carries an unread count; the mock showed "3" (the total) while exactly one page carried the "new" badge. FR-14's AC is "as in the mock", so the two must agree or the AC is uncheckable.
- Note: the mock's badge now shows 1, with a comment naming it the unread count.

### RV-06 - "Newest selected on arrival only via a quiet badge (no focus steal)" conflicts with itself and cannot be called pass or fail

- Severity: HIGH
- Points at: SPEC.md, FR-14
- State: APPLIED
- Reasoning: the clause reads two opposite ways, and the mock (newest chip both selected and badged) supports the auto-select reading while "(no focus steal)" supports the gentler one. An implementer cannot test the requirement as written.
- Note: the user chose never-auto-select at the gate. FR-14 now states it: a new page badges its chip (and the spine counter), the pane switches only on click, and only an empty pane auto-selects its first page; the AC covers arrival-while-reading.

### RV-07 - The same choices are stated twice, in "Decisions" and "Decisions from the interview", and can drift apart

- Severity: MEDIUM
- Points at: SPEC.md, Decisions vs Decisions from the interview
- State: APPLIED
- Reasoning: at least five decisions appear in both sections with independent phrasing; a future edit to one quietly leaves the other stale.
- Note: the interview section now states its role - it is the record of what the user confirmed, and where a bullet overlaps, the Decisions section owns the rationale. The bullets stay, because they are the interview record.

### RV-08 - Resume adoption can bind two live sessions to one key, and feedback on a dead session has no nudge target

- Severity: MEDIUM
- Points at: SPEC.md, FR-15 + Artifacts directory + Edge cases
- State: APPLIED
- Reasoning: nothing forbade a second session resuming the same conversation while the first was attached (two writers, mixed panes, ambiguous nudge target), and the feedback endpoint's behavior after the session's agent exits was unspecified.
- Note: two edge cases added - a second live claim on a key is refused (empty pane plus a plain notice), and feedback after the agent exits writes the file and skips the nudge.

### RV-09 - Name collision between the `GET /status` HTTP check and the new `status` websocket frame

- Severity: LOW
- Points at: SPEC.md, FR-02 AC vs New websocket frames
- State: APPLIED
- Reasoning: two different things named `status` on one server; nothing failed, a wording improvement to prevent confusion in code and tests.
- Note: the frame is renamed `snapshot`, in the spec and the plan.

## Principles alignment

- [x] AGENTS.md coding conventions (ESM `.js` imports, ASCII, capitals, Biome, 141-char dividers) - the spec's Constraints bind the work to them
- [ ] AGENTS.md security boundaries (one ambiguous security attribute, RV-12)
- [x] AGENTS.md release process (RC branch, main stays stable, changelog as source of truth, host-side publish)
- [x] Changelog rule - no changelog edit scheduled during feature phases
- [ ] Commit rules and the principles-file settings (commit_mode, commit_grouping, branch_naming)
- [x] Workflow rule - `pnpm lint:fix` + `pnpm check` per phase; host-only verification routed to the user
- [ ] Markdown one-sentence-per-line rule
- [ ] Internal consistency (two small points, RV-13 and RV-14)

### RV-10 - The plan's principles check reads only the empty Principles section and misses the Settings

- Severity: CRITICAL
- Points at: PLAN.md, Principles check
- State: APPLIED
- Reasoning: the settings say `commit_mode: prompt` and `commit_grouping: prompt`, and the plan sets per-phase commits with no pauses, without recording the deviation. The reviewer noted the README log shows the user approved this and recommended writing the exception down rather than changing the plan.
- Note: the prompt did happen - the commit-mode and grouping questions were asked at the plan gate and the user chose per-phase commits, which is what `prompt` means. The principles check now records this explicitly.

### RV-11 - Branch name ignores `branch_naming: cospec/<slug>` without recording a deviation

- Severity: HIGH
- Points at: PLAN.md, header block
- State: APPLIED
- Reasoning: the settings say `cospec/<slug>`; the plan uses `v4.0.0-rc-development`, following the repo's own RC convention - probably rightly, but unrecorded. The reviewer recommended keeping the RC name and recording it.
- Note: the branch question was asked at the plan gate and the user directed the RC convention; the principles check now records the deviation and its reason.

### RV-12 - The sandbox model for published pages is ambiguous, and isolation is the product

- Severity: HIGH
- Points at: SPEC.md, Edge cases + Data and contracts (form wiring)
- State: APPLIED
- Reasoning: nothing specifies whether agent-authored scripts execute, whether the frame shares an origin with the key-carrying page, and whether a page's script could read the key or drive the submit endpoint. AGENTS.md makes isolation non-negotiable, so this attribute must be pinned, not left to the implementer.
- Note: decided with RV-02/RV-26; see RV-26's note for the applied model.

### RV-13 - The helper is `webpane` everywhere except the sketch, which calls it `totopo-show`

- Severity: MEDIUM
- Points at: SPEC.md, Solution sketch vs FR-12 and Naming and discoverability
- State: APPLIED
- Reasoning: duplicate of RV-04, raised independently.
- Note: fixed with RV-04.

### RV-14 - The nudge's example path contradicts the persistence story

- Severity: MEDIUM
- Points at: SPEC.md, The nudge vs Artifacts directory
- State: APPLIED
- Reasoning: duplicate of RV-01, raised independently; also noted the container-side mount point was never named.
- Note: fixed with RV-01; the mount point is now `~/.webpane`.

### RV-15 - "Illustration pane" survives in the spec's own headers

- Severity: LOW
- Points at: SPEC.md, Scope item 4 and the Requirements heading
- State: APPLIED
- Reasoning: an improvement offer - renaming the headers removes the last place the old name survives.
- Note: fixed with RV-03.

### RV-16 - A few paragraphs pack multiple sentences onto one physical line, against the AGENTS.md Markdown rule

- Severity: LOW
- Points at: SPEC.md, the north-star "Chosen" paragraph, the artifacts-directory paragraph, Naming and discoverability
- State: APPLIED
- Reasoning: style only; most of the spec follows the rule.
- Note: the named paragraphs are split to one sentence per line.

## Better ways to do this

- [x] Browser open (placement point verified against `dev.ts`; one LOW note, RV-24)
- [x] Refuse-check (all four shape markers verified against the code; the A-paths-hardcoded convention carries over)
- [ ] Web pane transport and storage
- [ ] Session-key durability and resume adoption
- [x] Feedback channel (reuses `paste()` and `registry.typed()` - exactly the right existing machinery)
- [ ] Status strip matching
- [x] Frontend module split (matches the repo's no-bundler stance; split-before-features ordering is right)
- [ ] Helper and skill design (naming drift; otherwise sound)

The reviewer verified the spec's codebase claims against the source and found nearly every line reference accurate; the findings below are the places where it is not.

### RV-17 - Resume adoption promises more than any mechanism in the code can see

- Severity: HIGH
- Points at: SPEC.md FR-15 + Assumptions; PLAN.md Phase 5
- State: APPLIED
- Reasoning: the only resume the server can observe is the host-planted marker, consumed once by the first session after a container start. A user who resumes manually (`claude --resume` in a shell, or claude's own `/resume` picker) is invisible to webterm, so FR-15 as written is untestable beyond its own AC, which quietly narrows to the auto-resumed session. The hardest design problem in the feature currently has no design.
- Note: the user went past both offered options and chose conversation-id keying for ALL agents, so manual resumes adopt too. FR-15 and the artifacts contract now key directories by the agent's conversation id, with per-agent discovery (claude: snapshot/transcript scan; codex: rollout files; opencode: its session store), a provisional-then-rename fallback while the id is unknown, and the plan's phase 5 carries the design.

### RV-18 - The Clear-agent-memory claim is false against the code

- Severity: MEDIUM
- Points at: SPEC.md, Data and contracts, artifacts directory
- State: APPLIED
- Reasoning: Clear agent memory removes only `agents/` (`src/commands/advanced.ts:118-119`); a sibling `webpane/` directory would never be cleared by anything, leaving artifacts with no removal path at all.
- Note: the host directory moved under `agents/webpane/`, where the existing mount wiring pattern also applies and the spec's sentence becomes true as written.

### RV-19 - The snapshot does not carry two fields the strip requires

- Severity: MEDIUM
- Points at: SPEC.md, FR-20 + the frame contract vs the codebase analysis
- State: APPLIED
- Reasoning: the frame lists `version` and FR-20 renders "context tokens/window", but the snapshot the script writes contains neither the Claude Code version nor the context window size - both are parsed in the script but stay out of the JSON.
- Note: the frame contract and the plan's phase 7 now state the script is extended to write `context_window_size` and the version, with the `context-usage` consumers passed over as already scheduled.

### RV-20 - The nudge's example path contradicts the artifacts layout

- Severity: MEDIUM
- Points at: SPEC.md, Data and contracts, the nudge
- State: APPLIED
- Reasoning: duplicate of RV-01, raised independently.
- Note: fixed with RV-01.

### RV-21 - The helper has two names in the same document

- Severity: MEDIUM
- Points at: SPEC.md, Solution sketch vs Naming and discoverability
- State: APPLIED
- Reasoning: duplicate of RV-04, raised independently.
- Note: fixed with RV-04.

### RV-22 - Auto-resume's survival is implied but unowned once auto-start dies

- Severity: MEDIUM
- Points at: SPEC.md, FR-06/FR-15 and the Solution sketch
- State: APPLIED
- Reasoning: today the resume marker is planted only when auto-start is on, and takes the deleted setting as its agent; no FR said marker planting becomes unconditional, or noted that `webterm <agent>`'s choice lives in a `/tmp` file that dies with the container.
- Note: the sketch now plants the marker unconditionally using the webterm default agent, and FR-05 requires that choice to survive container restarts because the marker depends on it.

### RV-23 - "term.pid IS the claude_pid" is asserted, not verified, and equality is the fragile form of the join

- Severity: MEDIUM
- Points at: SPEC.md, FR-21 + the codebase analysis
- State: APPLIED
- Reasoning: the snapshot's `claude_pid` is found by walking ancestors; if the npm bin ever wraps or re-execs, the PTY leader and the found pid differ by a level and equality silently never matches. A descendant check costs a few lines and cannot be wrong in that direction. Flagged as a judgment call.
- Note: FR-21 now joins by ancestry, keeps the start-time tiebreak, and marks the process shape for verification on a real container.

### RV-24 - The opener's stated firing point misses the already-running-server branch

- Severity: LOW
- Points at: SPEC.md, Solution sketch, web default bullet
- State: APPLIED
- Reasoning: an improvement offer - "after `startWebtermAndVerify`" never runs on the connected path with a healthy server, while FR-03 wants every Open session to open the browser.
- Note: the sketch now fires the opener after the whole once-per-start block, keyed on a resolved port plus a successful key read.

### RV-25 - FR-14's arrival clause reads two ways

- Severity: LOW
- Points at: SPEC.md, FR-14
- State: APPLIED
- Reasoning: duplicate of RV-06, raised independently at lower severity.
- Note: decided with RV-06; see its note.

## Security of the new web surface

- [ ] Artifacts serving route - key gating, origin rules, path containment
- [ ] Feedback submit endpoint - authentication, binding to a session/page, limits
- [ ] Server-injected script in served pages - what it carries, how it lands in untrusted HTML
- [ ] `webpane` publish helper callable by any container process - session resolution, caps, bypass
- [ ] Host-mounted persistent artifact storage - containment, symlinks, growth limits
- [ ] Browser-open step on the host - container-controlled data reaching a host-executed command
- [ ] PTY nudge typed into the agent's terminal - sanitization of attacker-influenced content

### RV-26 - The pane's isolation claim does not hold as specified: agent-written HTML with scripts renders with no defined sandbox model

- Severity: CRITICAL
- Points at: SPEC.md, North star + Edge cases + Data and contracts (form wiring)
- State: APPLIED
- Reasoning: the sandbox attributes are load-bearing. With `allow-same-origin` (or no sandbox), a malicious published page reads the key from the parent and - because the origin check accepts any localhost origin - opens the relay with full mission control over every session. Even with an opaque origin, the key leaks if the frame's own URL is the key-gated artifacts route, and the page can `fetch()` it out. The spec leaves "iframe over the route vs fetch over the socket" as implementer's choice without noting the two have different security outcomes.
- Note: the user chose the recommended sandboxed frame at the gate. The spec now defines the sandbox model under Data and contracts (srcdoc/blob, sandbox="allow-scripts allow-forms", no allow-same-origin, postMessage form wiring, no key in the frame), and the non-goal is reworded to match.

### RV-27 - The injected script's authentication and injection method are unspecified

- Severity: HIGH
- Points at: SPEC.md, Data and contracts (form wiring) + FR-18
- State: APPLIED
- Reasoning: either the injected script embeds the key (readable and exfiltratable by any agent-authored script in the same document) or the submit endpoint is reachable without the key. Neither branch is stated, nor is how the injection lands in arbitrary untrusted HTML. Collapses into RV-26 if its recommended option is taken, since postMessage needs no key in the frame.
- Note: resolved by the RV-26 decision: the wiring posts by postMessage to the parent shell, which alone holds the key, so no key or gated endpoint is reachable from inside the frame; the injection point (shell injects before rendering) is now stated.

### RV-28 - Attacker-influenced text is typed into the agent's PTY with no sanitization rule

- Severity: HIGH
- Points at: SPEC.md, The nudge + FR-19
- State: APPLIED
- Reasoning: the nudge embeds the page title, controlled by whatever published; a title containing the bracketed-paste end sequence breaks out of the paste and the rest becomes raw keystrokes - server-mediated keystroke injection.
- Note: the contract now states the nudge is built from server-controlled text only, with the title sanitized (control and escape characters stripped, length capped, single line) and the path server-generated.

### RV-29 - Container-written data (the key) flows into a host-executed opener command with no validation requirement

- Severity: HIGH
- Points at: SPEC.md, codebase analysis (browser-open hook) + FR-03
- State: APPLIED
- Reasoning: `/tmp/webterm.key` is writable by every container process; if the opener is invoked through a shell or the value is unvalidated, this is a container-to-host command path - the exact boundary AGENTS.md marks as the product. v3 only printed the key; executing a host command with it is new.
- Note: the sketch now requires validating the key against its known shape (32 hex characters), building the URL host-side from validated parts only, and spawning the opener argv-style with no shell.

### RV-30 - The feedback endpoint has no size, rate, or field-count limit, and no rule binding a submission to its session or page

- Severity: MEDIUM
- Points at: SPEC.md, FR-18 + Data and contracts (feedback file)
- State: APPLIED
- Reasoning: every existing write endpoint is bounded; this one inherited nothing, and if the page and session ids ride in the request body, a page in session A can write into session B's directory and nudge B's agent - cross-session influence FR-15 forbids.
- Note: FR-18 now specifies a body cap, a per-page debounce, and server-side derivation of the target session, page id, and filename, with ACs covering each.

### RV-31 - Path containment is asserted but unspecified, and symlinks in host-mounted storage are not covered

- Severity: MEDIUM
- Points at: SPEC.md, FR-17 + Data and contracts (artifacts directory)
- State: APPLIED
- Reasoning: the existing containment model does not resolve symlinks - fine where only the server writes, wrong here: any container process can plant a symlink inside the artifacts root pointing at workspace files or the key file, and the route would serve it. Content type and nosniff were also unstated.
- Note: FR-17 now requires realpath-based containment, refusal of symlinks and non-regular files, and fixed `text/html; charset=utf-8` with nosniff, with a symlink AC.

### RV-32 - The helper's session resolution has no stated failure-closed behavior

- Severity: MEDIUM
- Points at: SPEC.md, FR-12 + the publish-helper contract
- State: APPLIED
- Reasoning: if the helper (rather than the server) resolves the session, the session key becomes an argument the server trusts, which is the mechanism by which one session's agent publishes a phishing page into another session's pane.
- Note: the contract now makes resolution the server's job from a pid it independently walks, forbids the helper from naming a key, and refuses unresolvable callers with no write.

### RV-33 - Host-mounted, never-swept storage has no growth bound

- Severity: MEDIUM
- Points at: SPEC.md, Data and contracts (artifacts directory) + FR-15
- State: APPLIED
- Reasoning: the per-file cap was enforced only in the helper, which a direct writer bypasses; a runaway agent fills the user's host disk through a bind mount. The reviewer recommended a server-side bound while keeping the user's persistence decision.
- Note: the contract now enforces a per-file cap and a per-workspace total cap server-side; past the total, new publishes are refused with a plain error and nothing existing is deleted - the bound without the sweep the user rejected.

### RV-34 - Nothing addresses a published page impersonating totopo itself

- Severity: MEDIUM
- Points at: SPEC.md, FR-14/FR-16/FR-28 vs the phishing surface
- State: APPLIED
- Reasoning: the design teaches the user to trust the pane, and the mock's attribution ("Published by claude 1") lives inside the document body a malicious page fully controls. Flagged as a judgment call on how far to go.
- Note: FR-14 now states the chips bar is pane chrome rendered by the interface itself, outside the page's frame, so a page cannot fake which session and page the user is looking at.

### RV-35 - The nudge's example path contradicts the storage location

- Severity: LOW
- Points at: SPEC.md, The nudge vs Data and contracts
- State: APPLIED
- Reasoning: duplicate of RV-01, raised independently.
- Note: fixed with RV-01.

### RV-36 - The security review lands only after phase 9, though every new attack surface is built in phases 5 and 6

- Severity: LOW
- Points at: PLAN.md, review checkpoints
- State: APPLIED
- Reasoning: nothing failed - an improvement offer. By the time the final security reviewer arrives, the sandbox decision will already be implemented and load-bearing for phases 7-9.
- Note: the user chose to add it. The plan now has a security-only checkpoint after phase 6, scoped to the sandbox attributes, key reachability, containment, endpoint bounds, and nudge sanitization.

# Quality review, run 2 - after the 2026-08-23 two-product recut

- Run: 2026-08-23
- Mode: one fresh-context subagent, all lenses, with a special focus on revision residue (sentences still describing the pre-split single-product world, requirements on the wrong stage, claims made false by totopo keeping its web toggle and terminal status line, stage-2 statements that wrongly assume this repo)
- Findings: 11 (RV-37..RV-47), of which 11 applied (2 via user decisions at the gate on 2026-08-23: RV-40 - chamba drops the Help/README URL entirely; RV-43 - stage 1's reviews consolidate into one 3-reviewer checkpoint after phase 4), 0 dismissed, 0 waiting on you

Verified clean by the reviewer, for the record: spec and plan stage assignments agree everywhere; every Covers ID exists; no open clarification markers; every FR has an AC; the FR-30 key names, the `npx totopo@3.16.0` instruction, and the kept `web_enabled`/`auto_start_agent`/status-line claims all verify against the code; `cospec/` is git-tracked, so the spec and mock travel with the force-pushed branch into the chamba repo.

### RV-37 - Decisions bullet "Terminal status line stops rendering everywhere" survived the recut unscoped

- Severity: MEDIUM
- Points at: SPEC.md, Decisions
- State: APPLIED
- Reasoning: revision residue - the bullet contradicted the recut's own "Totopo keeps its terminal status line" bullet three lines later. FR-22, Scope, and Non-goals were already scoped correctly.
- Note: the bullet now reads "stops rendering everywhere in chamba" and points at the coexistence bullet for totopo's side.

### RV-38 - FR-07's audio grep AC forbids the code FR-30 requires

- Severity: MEDIUM
- Points at: SPEC.md, FR-07 AC vs FR-30
- State: APPLIED
- Reasoning: FR-30 (narrowed in the recut) hardcodes the old `audio` key names as string literals, which the FR-07 grep would flag; FR-29's stage-1 AC already carried the right carve-out, FR-07's did not.
- Note: FR-07's AC now carries the same FR-30 exception as FR-29's.

### RV-39 - Interview bullets "README rewritten web-first" and "Settings menu slimmed" superseded by the recut, and the section preamble does not save them

- Severity: MEDIUM
- Points at: SPEC.md, Decisions from the interview
- State: APPLIED
- Reasoning: read as chamba (per the preamble), the README bullet contradicts FR-24; read as totopo, it contradicts FR-25 and the Non-goals. The settings bullet mixes both stages.
- Note: both bullets now open with a superseded/split annotation naming the FRs that replaced them, with the original confirmation preserved after it.

### RV-40 - Chamba's tag-pinned Help/README URL is a dead link after the rename, and nothing covers it

- Severity: MEDIUM
- Points at: SPEC.md FR-31/FR-33; code: GITHUB_README_URL (src/lib/totopo-yaml.ts:115), injected at agent-context.ts:145, printed by bin/totopo.js:214
- State: APPLIED
- Reasoning: the URL pattern is `github.com/asafratzon/totopo/blob/v<version>/README.md`; in chamba the repo is private and FR-32 deletes tags, so after the rename the Help entry and the injected `readme_url` point nowhere. FR-33 covers only the schema line.
- Note: the user chose to drop the URL entirely (2026-08-23). FR-31 now says Help loses its URL line and the injected `readme_url` context line is removed, with a matching AC and phase-5 definition-of-done check.

### RV-41 - FR-33 repoints a schema line that does not exist in generated files today

- Severity: MEDIUM
- Points at: SPEC.md, FR-33; code: writeTotopoYaml (src/lib/totopo-yaml.ts:134-160), the v3.2.1 header removal (migrate-to-latest.ts:589,602)
- State: APPLIED
- Reasoning: v3 deliberately removed the `yaml-language-server` header (stale tag URLs); validation is in-process via ajv. As written, an implementer greps for a schema line to change and finds nothing.
- Note: FR-33 now says what it is - reintroducing the editor-schema header, safe because the npm-CDN URL is pinned by the package version - with an implementer note on the history.

### RV-42 - FR-29 appears in no phase's Covers line

- Severity: LOW
- Points at: PLAN.md, Covers lines
- State: APPLIED
- Reasoning: convention breach, not a coverage hole - the plan's closing line makes FR-29 standing work in every phase, and phases 4 and 11 already carry its stage greps in their definitions of done.
- Note: FR-29 added to the Covers lines of phases 4 and 11 as each stage's close-out.

### RV-43 - Stage 1 releases totopo v4.0.0 with no correctness review before the checkpoint

- Severity: MEDIUM
- Points at: PLAN.md, review checkpoints
- State: APPLIED
- Reasoning: an improvement offer, nothing failed. The recut kept the phase-3 parity review but moved everything else past the checkpoint into the chamba repo, so the refuse-check, the FR-30 tidy-up, and the "Coming from v3" docs - the parts with real users - ship as a public major with only the host smoke test, and a stage-1 problem found by the final reviewers reaches totopo only by hand-cherry-pick.
- Note: the user chose one end-of-stage review instead of a mid-stage one (2026-08-23): the phase-3 checkpoint moved to after phase 4 and widened to 3 reviewers (parity + module structure, correctness of the stage-1 changes, docs), before the user checkpoint.

### RV-44 - Residual pre-split wording in chamba-scoped passages

- Severity: LOW
- Points at: SPEC.md - the sandbox model's "inside the totopo page" (twice), the "same as v3" edge case, FR-16's "existing totopo skills"
- State: APPLIED
- Reasoning: none changed meaning, all read as the single-product world.
- Note: now "the chamba page", "the same behavior totopo has today", and "baked into the image like the other built-in skills".

### RV-45 - The mock's expanded and collapsed states disagree on the unread count

- Severity: LOW
- Points at: mocks/pages-pane.html - spine badge "1" vs no chip carrying the `.new` badge (the CSS rule was defined and unused)
- State: APPLIED
- Reasoning: FR-14's AC is "as in the mock", so the one static document should be self-consistent.
- Note: a fourth, newest chip now carries the `new` badge and is not selected (matching never-auto-select); the spine's 1 counts it.

### RV-46 - The plan cites RV-36 for a checkpoint "after phase 8" while RV-36's record says "after phase 6"

- Severity: LOW
- Points at: PLAN.md review checkpoints vs REVIEW.md RV-36
- State: APPLIED
- Reasoning: pre-recut numbering; the point in the work is the same, but a reader could think the checkpoint moved without authority.
- Note: the plan's citation now says the recut renumbered that point from phase 6 to phase 8.

### RV-47 - Revision-added prose packs several sentences per physical line, against the AGENTS.md Markdown rule

- Severity: LOW
- Points at: SPEC.md - Products and stages bullets, FR-30, FR-24/FR-27, the FR-31..FR-34 block
- State: APPLIED (in part)
- Reasoning: the Products-and-stages bullets were the longest offenders and are prose, so they were reflowed one sentence per line. The multi-sentence FR bullets were left as they are: the pre-existing requirement bullets share that style and the first panel accepted it (RV-16 applied the rule to paragraphs, not to requirement bullets), so reflowing only the new FRs would split the artifact's idiom.
