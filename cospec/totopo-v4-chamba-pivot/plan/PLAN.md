# Totopo v4 cleanup and the chamba pivot

> **For the executing agent - read this first.** Read `spec/SPEC.md` before any phase.
> This plan was written before the work started; check each phase against the actual code before building, and raise anything that looks off instead of pushing through.

- Commits: per phase, in both stages
- Branch: stage 1 on `v4.0.0-rc-development` in this repo; stage 2 on `main` in the chamba repo (`https://github.com/asafratzon/chamba`, private)
- Pauses: none within a stage; the checkpoint between the stages is a hard stop that only the user can perform
- Review checkpoints:
  - after phase 4 (stage 1 ends, before the checkpoint - the user chose one end-of-stage review over a mid-stage one, 2026-08-23): 3 reviewers - behavior parity with the old app.js (tab lights, busy trace, chime, favicon animation, drafts, clipboard, dictation all intact) and module structure, which stage 2 builds on; correctness of the audio removal, refuse-check, and v3.16 tidy-up against the spec; the "Coming from v3" README section and docs consistency. Everything totopo's users get ships reviewed from totopo's own repo.
  - after phase 8: 1 security reviewer - the sandbox attributes as built (no same-origin, key unreachable from any rendered page), path containment and symlink refusal on the artifact routes, the feedback endpoint's bounds and server-side binding, and the nudge sanitization. Added at the quality review gate (REVIEW.md RV-36; recorded there as "after phase 6" in the pre-recut numbering - the same point in the work, which the 11-phase recut renumbered to phase 8), because this is the point where the whole new attack surface exists and is still cheap to change.
  - final, after phase 11: 3 reviewers - correctness against the spec; security of the new web surface (artifact routes, feedback endpoint, key gating); repo rules and docs consistency.

## Goal

Ship the web-first direction as two products: totopo v4.0.0 (this repo) - a cleanup-only major with the audio server and migration chain removed and the webterm frontend split into modules, totopo staying terminal-first and otherwise unchanged - and chamba 0.4.0 (the chamba repo) - the pivot built on that base: everything renamed, web interface on by default with the browser opening on session start, the web pane with its feedback channel, the status strip, and the release baggage dropped.

## Principles check

The cospec principles file has no principles written, so the plan breaks none.
Its settings were honored: `commit_mode: prompt` and `commit_grouping: prompt` were asked at the plan gate (per-phase commits chosen), and the stage-1 branch name follows the repo's own RC convention (`v4.0.0-rc-development`) at the user's direction, which is the intent behind `branch_naming: cospec/<slug>` being overridable by the user.
Stage 2 commits land directly on the chamba repo's `main` at the user's direction - it is a private personal repo with a single author and no branch policy.
The spec's Constraints section binds the plan to the repo rules in `AGENTS.md` (ESM imports, ASCII comments, Biome, divider lines, no changelog edits during feature work), and every phase's definition of done includes `pnpm lint:fix` + `pnpm check`.
The rule files travel with the branch into the chamba repo and are adapted by the rename phase; the same conventions (including no AI attribution in commits) bind stage 2. The changelog rule ends where FR-32 deletes the changelog machinery.
Docker is not available inside the container: every phase verifies by unit tests and `pnpm check`; behavior that needs a real container (browser open, pane, strip) is verified by the user on the host at the checkpoints and at the end.

## Stage 1 - totopo v4.0.0 (this repo, `v4.0.0-rc-development`)

- [x] Phase 1 - Audio retirement
  - Goal: remove every trace of the voice/audio feature (module, constants, lock flag, global setting, dev wiring, menus, Dockerfile packages, context bullet, README voice sections, tests).
  - Definition of done: no functional audio/pulse/sox references outside webterm's browser dictation and the unrelated chime; `pnpm check` green.
  - Covers: FR-07, FR-08
- [x] Phase 2 - Migrations out, refuse-check and tidy-up in
  - Goal: delete `migrate-to-latest.ts`, relocate `isImageStale`, add the cheap old-shape detection that refuses with the "run totopo v3.16.0 once" message (the exact version named, so the user installs the right one: npx totopo@3.16.0), add the version marker to `.lock`, and add the one surviving migration - the v3.16-to-v4 audio tidy-up (drop `audio=` from `.lock`, remove the audio-mode key from the global config, old key names as hardcoded literals per the migration convention).
  - Definition of done: startup runs no migration chain; old-shape fixtures get the refusal and untouched disk; a v3.16-shape fixture opens, is tidied, and is unchanged on a second run; fresh `.lock` carries the version key; `pnpm check` green.
  - Covers: FR-09, FR-10, FR-11, FR-30
- [x] Phase 3 - Webterm frontend module split
  - Goal: split `public/app.js` into ES modules (terminal, tabs, composer, connection, chime/favicon, clipboard, dictation) loaded via `<script type="module">`, with no behavior change - the platform the stage-2 pane and strip land on.
  - Definition of done: the monolith is gone, modules are each under roughly 600 lines, drift tests still pin the agent lists, `pnpm check` green. Explicitly preserved, none lost: the tab busy light and finished glow, the browser-tab title count and favicon working bar / waiting dot, the chime and its mute, per-session drafts, sent-message history, OSC 52 clipboard, and dictation.
  - Covers: FR-23
- [x] Phase 4 - Totopo docs, sweep, and release prep
  - Goal: the "Coming from v3" README section (v3.16 just works, first run tidies; older shapes run totopo v3.16.0 once), the stage-1 repo sweep for dead names and stale comments, the advanced demo re-record listed as a host step for the user, and the version bumped to the v4.0.0 RC shape for the standard release flow.
  - Definition of done: FR-27's AC holds on a full README read; the stage-1 FR-29 greps are clean (`audio`, `runMigration` - FR-30 and its tests excepted); `pnpm check` green; the host steps (demo, `pnpm release`, smoke tests) are written out for the user.
  - Covers: FR-25, FR-26, FR-27, FR-29 (stage-1 close-out; FR-29 is also standing work in every phase)

**Checkpoint (user step, hard stop).** Test the RC on the host, release totopo v4.0.0-rc through the standard flow, and when it holds: force-push this branch onto chamba's `main` by URL (`git push --force https://github.com/asafratzon/chamba.git v4.0.0-rc-development:main` - no remote added, no extra branch here), then switch to the local chamba clone (`git fetch origin && git reset --hard origin/main` there; the histories are unrelated, so a plain pull will not work). Stage 2 continues in the chamba repo; totopo's RC-to-stable promotion continues here independently, and any fix landed here afterward reaches chamba only by hand-cherry-pick.

## Stage 2 - chamba 0.4.0 (the chamba repo, on `main`)

- [ ] Phase 5 - Rename and release simplification
  - Goal: the full totopo -> chamba sweep (package name and bin, `chamba.yaml`, `~/.chamba/`, container names, labels, env vars, agent context, skills, webterm branding, rule files), the release baggage removed (RC process, tags, changelog machinery, release skill - a release becomes version bump + `npm publish`), the tag-pinned GitHub Help/README URL dropped (Help loses its URL line, the injected `readme_url` context line goes), the editor-schema header reintroduced pointing at the npm package via a public CDN, and coexistence with totopo verified by tests on the separated names and paths.
  - Definition of done: the FR-31 grep is clean (`grep -ri totopo` - provenance line and git history excepted); no changelog or tag machinery remains; no GitHub URL is printed by Help or injected into agent context; a generated `chamba.yaml` resolves its schema; `pnpm check` green.
  - Covers: FR-31, FR-32, FR-33, FR-34
- [ ] Phase 6 - Web by default
  - Goal: delete `web_enabled` and the auto-start setting (env var, label, bashrc branches, menus); start the webterm server with the container unconditionally; open the host browser after the server verifies (URL printed as fallback); slim the settings menu and give `web_range` its home; `webterm <agent>` keeps only the default-agent job, persisted across container restarts.
  - Definition of done: no web-toggle or autostart references; the open-session path resolves the port, launches the server, and calls the opener; `pnpm check` green.
  - Covers: FR-01, FR-02, FR-03, FR-04, FR-05, FR-06
- [ ] Phase 7 - Web pane, server side
  - Goal: persistent artifacts directories keyed by conversation id (host bind mount under `agents/webpane/`, per-agent id discovery with the provisional-then-rename fallback, adoption on any resume), the watcher, the key-gated artifact routes and `pages`/`page` frames, the sandboxed-frame serving model (srcdoc/blob, no same-origin, postMessage form wiring), the feedback endpoint writing the JSON file plus the terminal nudge via the existing paste path, and the `webpane` helper baked into the image.
  - Definition of done: registry/server unit tests cover publish, list, serve, containment, feedback write, and nudge; `pnpm check` green.
  - Covers: FR-12, FR-13, FR-15, FR-17, FR-18, FR-19
- [ ] Phase 8 - Web pane, client side
  - Goal: the pane per the approved mock `mocks/pages-pane.html` - side split, pagination chips with unread badges, never-auto-select arrival, draggable width, collapse to the "Web pane" spine, per-session contents, form wiring injection for feedback pages.
  - Definition of done: pane module implements every mock behavior; pane state survives tab switches; `pnpm check` green.
  - Covers: FR-13, FR-14, FR-15
- [ ] Phase 9 - Status strip
  - Goal: snapshot-to-session matching by pid ancestry (+start-time tiebreak), `snapshot` frames, the strip component above the composer for claude sessions, the statusline script extended to write `context_window_size` and the Claude Code version and silenced while it keeps writing snapshots (context-usage helper and statusline skill adjusted).
  - Definition of done: matching and frame emission unit-tested; strip renders the four segments from snapshot data; no visible terminal status line in chamba; `pnpm check` green.
  - Covers: FR-20, FR-21, FR-22
- [ ] Phase 10 - Agent awareness
  - Goal: the `web-pane` skill for claude, the web-pane bullet in every agent's injected context with the "prefer a page for rich output/questions" rule, and the session greeting naming the pane.
  - Definition of done: context templates and skill in place with trigger-rich wording; agent-context tests updated; `pnpm check` green.
  - Covers: FR-16, FR-28
- [ ] Phase 11 - Chamba docs, sweep, and 0.4.0 publish
  - Goal: the minimal personal README, the stage-2 repo sweep for dead names and stale comments, and the first chamba release (version 0.4.0, bare `npm publish` - a host step for the user).
  - Definition of done: FR-24's AC holds; the stage-2 FR-29 greps are clean (`web_enabled`, `auto_start`, `totopo`); `pnpm check` green; the host steps (publish, smoke test with `npx chamba`) are written out for the user.
  - Covers: FR-24, FR-29 (stage-2 close-out; FR-29 is also standing work in every phase)

FR-29 (tests and cleanup) is standing work in every phase of both stages: each phase adapts the tests it touches and adds tests for what it builds.
