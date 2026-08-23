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
- 2026-08-23: phase 3 done - webterm frontend module split (FR-23): the 2633-line `app.js` is gone, replaced by 16 ES modules under `public/app/` (largest 480 lines) loaded by `app/main.js`; shared state is a live binding with one owning module, and the two things with an order to them (`mountTerminal`, `installClipboard`) run from the entry, which also removes the one import cycle that would have bitten. Drift tests now read the whole client via `readWebtermClient()`; one OSC 52 regex was tightened after it started matching past its own file. 562 tests pass; real-browser behavior is a host step at the stage-1 checkpoint.
- 2026-08-23: phase 4 done - totopo docs, sweep, and release prep (FR-25, FR-26, FR-27, FR-29): README gained a "Coming from v3" section (v3.16 needs nothing, the first v4 run tidies, older setups run `npx totopo@3.16.0` once) and an accurate `.lock` line; the sweep repointed the migration convention in `AGENTS.md` and the `/release` skill at `legacy-check.ts`, dropped the two constants orphaned with the chain, and fixed the stale `pnpm rc` names; the advanced demo scenario lost its host-audio-server beats and both scenarios show v4.0.0; `package.json` at `4.0.0-rc-1`. The FR-29 greps are clean apart from the named carve-outs and 562 tests pass. Host steps left for the user: render both GIFs, try the RC in a container, `/release` for the changelog entry, then `pnpm release`.
- 2026-08-23: stage-1 review checkpoint after phase 4 (3 fresh-context reviewers: webterm parity and module structure, the audio/migration removals against the spec, the docs). No behavior regression found in the split. Fixed: the retired-yaml-key check matched at any indentation, so a `dockerfile_hook` writing `project_id:` would have been refused forever with no way out (now anchored at column 0, like the v3 migrations); the tidy-up rewrote a lock from a newer totopo, rolling its version back and dropping its keys on every start (now only an older shape is brought forward); the tidy message no longer claims v3/voice for a generic rewrite; the refusal says to run v3 from the same directory, since one marker is workspace-scoped; the README owned up to the container rebuild every v3.16 user gets and dropped the "same containers" claim, plus the settings list, the `~/.totopo/` tree, the retired-key case and one-sentence-per-line; `main.js` now imports every module so a side-effect-only one cannot be orphaned by an unrelated edit, and the socket URL is no longer built at load time; new tests pin the page's entry script and that every module is reachable from it, and `blockAfter()` replaced two lazy regexes that could match past the file they meant. Also swept: the divider-line count in AGENTS.md (140, not 141), the em dash in the check banner, and three stale `v3.1.0-rc-development` examples. Accepted, not fixed: the host-wide tidy touches a workspace the check would refuse when visited (harmless, v3.16 rewrites it again); the lock writer keeps only the keys this version knows (that is the mechanism FR-30 rests on, so unknown keys cannot be carried); the RC-era `yaml=` lock shape falls into re-onboarding rather than the refusal (FR-10 names only the positional shape); `drafts.js` staying one module and no bar-slot seam in `tabs.js` (both shape for chamba features that land in the other repo, and phase 3 was a no-behavior-change split - the reviewer agreed on re-check). 567 tests pass.
