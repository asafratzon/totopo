# v4 - web-first totopo

> **For the executing agent - read this first.** Read `spec/SPEC.md` before any phase.
> This plan was written before the work started; check each phase against the actual code before building, and raise anything that looks off instead of pushing through.

- Commits: per phase
- Branch: v4.0.0-rc-development
- Pauses: none
- Review checkpoints:
  - after phase 4: 2 reviewers - behavior parity with the old app.js (tab lights, busy trace, chime, favicon animation, drafts, clipboard, dictation all intact); module structure. Phases 5-7 build on this structure.
  - after phase 6: 1 security reviewer - the sandbox attributes as built (no same-origin, key unreachable from any rendered page), path containment and symlink refusal on the artifact routes, the feedback endpoint's bounds and server-side binding, and the nudge sanitization. Added at the quality review gate (REVIEW.md RV-36), because this is the point where the whole new attack surface exists and is still cheap to change.
  - final, after phase 9: 3 reviewers - correctness against the spec; security of the new web surface (artifact routes, feedback endpoint, key gating); repo rules and docs consistency.

## Goal

Ship totopo v4: web interface on by default with the browser opening on session start, audio and migration code removed outright, the web pane (published pages + feedback channel) and the status strip added to the web interface, and the repo, docs, and demos brought to the v4 shape.

## Principles check

The cospec principles file has no principles written, so the plan breaks none.
Its settings were honored: `commit_mode: prompt` and `commit_grouping: prompt` were asked at the plan gate (per-phase commits chosen), and the branch name follows the repo's own RC convention (`v4.0.0-rc-development`) at the user's direction, which is the intent behind `branch_naming: cospec/<slug>` being overridable by the user.
The spec's Constraints section binds the plan to the repo rules in `AGENTS.md` (ESM imports, ASCII comments, Biome, divider lines, no changelog edits during feature work), and every phase's definition of done includes `pnpm lint:fix` + `pnpm check`.
Docker is not available inside the container: every phase verifies by unit tests and `pnpm check`; behavior that needs a real container (browser open, pane, strip) is verified by the user on the host at the pauses and at the end.

## Phases

- [ ] Phase 1 - Audio retirement
  - Goal: remove every trace of the voice/audio feature (module, constants, lock flag, global setting, dev wiring, menus, Dockerfile packages, context bullet, README voice sections, tests).
  - Definition of done: no functional audio/pulse/sox references outside webterm's browser dictation and the unrelated chime; `pnpm check` green.
  - Covers: FR-07, FR-08
- [ ] Phase 2 - Migrations out, refuse-check in
  - Goal: delete `migrate-to-latest.ts`, relocate `isImageStale`, add the cheap old-shape detection that refuses with the "run v3 once" message, add the version marker to `.lock`, and add the one surviving migration - the v3.16-to-v4 tidy-up (drop `audio=` from `.lock`, remove `web_enabled`/`auto_start_agent` from the global config, old key names as hardcoded literals per the migration convention).
  - Definition of done: startup runs no migration chain; old-shape fixtures get the refusal and untouched disk; a v3.16-shape fixture opens, is tidied, and is unchanged on a second run; fresh `.lock` carries the version key; `pnpm check` green.
  - Covers: FR-09, FR-10, FR-11, FR-30
- [ ] Phase 3 - Web by default
  - Goal: delete `web_enabled` and the auto-start setting (env var, label, bashrc branches, menus); start the webterm server with the container unconditionally; open the host browser after the server verifies (URL printed as fallback); slim the settings menu and give `web_range` its home; `webterm <agent>` keeps only the default-agent job.
  - Definition of done: no `web_enabled`/`auto_start_agent`/`TOTOPO_AUTOSTART` references; the open-session path resolves the port, launches the server, and calls the opener; `pnpm check` green.
  - Covers: FR-01, FR-02, FR-03, FR-04, FR-05, FR-06
- [ ] Phase 4 - Webterm frontend module split
  - Goal: split `public/app.js` into ES modules (terminal, tabs, composer, connection, chime/favicon, clipboard, dictation) loaded via `<script type="module">`, with no behavior change - the platform the pane and strip land on.
  - Definition of done: the monolith is gone, modules are each under roughly 600 lines, drift tests still pin the agent lists, `pnpm check` green. Explicitly preserved, none lost: the tab busy light and finished glow, the browser-tab title count and favicon working bar / waiting dot, the chime and its mute, per-session drafts, sent-message history, OSC 52 clipboard, and dictation.
  - Covers: FR-23
- [ ] Phase 5 - Web pane, server side
  - Goal: persistent artifacts directories keyed by conversation id (host bind mount under `agents/webpane/`, per-agent id discovery with the provisional-then-rename fallback, adoption on any resume), the watcher, the key-gated artifact routes and `pages`/`page` frames, the sandboxed-frame serving model (srcdoc/blob, no same-origin, postMessage form wiring), the feedback endpoint writing the JSON file plus the terminal nudge via the existing paste path, and the `webpane` helper baked into the image.
  - Definition of done: registry/server unit tests cover publish, list, serve, containment, feedback write, and nudge; `pnpm check` green.
  - Covers: FR-12, FR-13, FR-15, FR-17, FR-18, FR-19
- [ ] Phase 6 - Web pane, client side
  - Goal: the pane per the approved mock `mocks/pages-pane.html` - side split, pagination chips with unread badges, draggable width, collapse to the "Web pane" spine, per-session contents, form wiring injection for feedback pages.
  - Definition of done: pane module implements every mock behavior; pane state survives tab switches; `pnpm check` green.
  - Covers: FR-13, FR-14, FR-15
- [ ] Phase 7 - Status strip
  - Goal: snapshot-to-session matching by pid ancestry (+start-time tiebreak), `snapshot` frames, the strip component above the composer for claude sessions, the statusline script extended to write `context_window_size` and the Claude Code version and silenced while it keeps writing snapshots (context-usage helper and totopo-statusline skill adjusted).
  - Definition of done: matching and frame emission unit-tested; strip renders the four segments from snapshot data; no visible terminal status line; `pnpm check` green.
  - Covers: FR-20, FR-21, FR-22
- [ ] Phase 8 - Agent awareness
  - Goal: the `web-pane` skill for claude, the web-pane bullet in every agent's injected context with the "prefer a page for rich output/questions" rule, and the session greeting naming the pane.
  - Definition of done: context templates and skill in place with trigger-rich wording; agent-context tests updated; `pnpm check` green.
  - Covers: FR-16, FR-28
- [ ] Phase 9 - Docs, sweep, and release prep
  - Goal: README rewritten web-first with the "Coming from v3" manual migration section; final repo sweep for dead names and stale comments; demo re-recording listed as a host step for the user; version bumped to v4.0.0 RC shape for the standard release flow.
  - Definition of done: FR-24/FR-27 ACs hold on a full README read; the FR-29 greps are clean; `pnpm check` green; the host steps (demos, `pnpm release`, smoke tests) are written out for the user.
  - Covers: FR-24, FR-25, FR-26, FR-27, FR-29

FR-29 (tests and cleanup) is also standing work in every phase: each phase adapts the tests it touches and adds tests for what it builds.
