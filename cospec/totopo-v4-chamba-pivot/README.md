# Totopo v4 cleanup and the chamba pivot

- Created: 2026-08-22
- Status: executing
- Mode: imagination

## Protocol

- [x] High-level exploration
- [x] Interview
- [x] Codebase analysis
- [x] UI mocks
- [x] Technical specs
- [x] Execution plan
- [x] Quality review

## Log

- 2026-08-22: protocol confirmed, imagination mode on
- 2026-08-22: the user reads the spec in the web interface (npx cospec page is open)
- 2026-08-22: high-level exploration complete (ideal + feasibility pass written into SPEC.md)
- 2026-08-22: interview complete (decisions and assumptions folded into SPEC.md)
- 2026-08-22: codebase analysis complete (audio surface, session flow, migrations, webterm and statusline plumbing mapped into SPEC.md)
- 2026-08-22: UI mocks approved (side split chosen from 4 candidates, revised with pagination bar + draggable/collapsible pane)
- 2026-08-22: technical specs approved (29 requirements; web pane naming, persistent per-session artifacts, file+nudge feedback)
- 2026-08-22: execution plan approved (9 phases, per-phase commits on v4.0.0-rc-development, no pauses, reviews after phase 4 and final)
- 2026-08-22: quality review complete (4 fresh-context reviewers, 36 findings all applied; gate decisions: sandboxed frames with no key inside, never-auto-select arrival, conversation-id keyed artifacts, security checkpoint after phase 6; user added FR-30, the single v3.16-to-v4 migration)
- 2026-08-22: spec finalized - Status: ready
- 2026-08-23: revision - the work splits into two products and stages: totopo v4.0.0 (cleanup-only major, this repo) and chamba 0.4.0 (the web-first pivot, renamed and continued in the private chamba repo after a user checkpoint that releases the RC and force-pushes the branch onto chamba's main). New FR-31..34 (rename sweep, bare-minimum release, schema via npm CDN, coexistence); FR-30 narrowed to the audio tidy-up; strip and terminal-statusline-removal are chamba-only; chamba gets a minimal personal README; plan recut into 11 phases across the two stages.
- 2026-08-23: user feedback applied - the refuse message names totopo v3.16.0 exactly (`npx totopo@3.16.0`); the spec directory renamed from v4-web-first to totopo-v4-chamba-pivot with titles aligned
- 2026-08-23: revision finalized - Status: ready
- 2026-08-23: second quality review over the revised artifacts (1 fresh-context reviewer, revision-residue focus): 11 findings RV-37..RV-47, 9 applied directly, 2 decided by the user and applied (chamba drops the Help/README URL entirely; stage 1's reviews consolidate into one 3-reviewer checkpoint after phase 4)
- 2026-08-23: finalized after the second review - Status: ready
- 2026-08-23: execution started on `v4.0.0-rc-development` (branched from `main`)
- 2026-08-23: phase 1 done - audio retirement (FR-07, FR-08): audio-host module, constants, .lock flag, global setting, dev wiring, menus, settings submenu, Dockerfile packages, context bullet and README voice sections all removed; `IS_MACOS` and `connectedSessionCount` dropped with their last callers; 584 tests pass. The migration chain's own audio migrations survive here by design - phase 2 deletes the whole file.
- 2026-08-23: phase 2 done - migrations out (FR-09, FR-10, FR-11, FR-30): the 712-line chain and its tests deleted, `isImageStale` moved into `dockerfile-builder.ts`, new `legacy-check.ts` refuses four pre-v3.16 markers with the `npx totopo@3.16.0` message and writes nothing, `.lock` now carries `version=4` stamped by the canonical writer, and the single tidy-up drops the dead audio settings host-wide and idempotently; 23 new tests
