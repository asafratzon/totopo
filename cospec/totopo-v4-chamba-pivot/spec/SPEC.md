# Totopo v4 cleanup and the chamba pivot

> **For the implementing agent - read this first.** This spec was written during planning with limited knowledge of the code.
> Before building anything, review it carefully against the actual codebase and **plan first** (in plan mode, where your environment has one).
> Treat nothing here as settled: if the spec turns out misaligned with the code, or you see a better path, **push back and raise it** rather than building something you can tell is off.

## Goal

Ship the web-first direction as two products in two stages (revised with the user on 2026-08-23).
Stage 1, **totopo v4.0.0**, is a cleanup-only major in this repo: the audio server and the migration layer are removed outright, and the webterm frontend is split into modules - totopo stays a terminal-first tool, its web interface and settings unchanged in behavior.
Stage 2, **chamba 0.4.0**, is the pivot, built on top of the totopo v4 base in the separate chamba repo: everything is renamed totopo -> chamba, the web interface becomes the default with the browser opening on session start, and it gains the web pane (published HTML pages with a feedback channel back) and the status strip.
The two tools coexist: totopo keeps its terminal-first identity, chamba is the web-first one, and a workspace can be managed by either.

## Products and stages

- **Stage 1 - totopo v4.0.0**, executed in this repo on `v4.0.0-rc-development`: audio retirement (FR-07, FR-08), migrations out with the refuse-check and the single audio tidy-up (FR-09, FR-10, FR-11, FR-30), the frontend module split (FR-23), totopo's own doc pass and demo re-record (FR-25, FR-27), released as v4.0.0 through the standard RC process (FR-26).
  The repo-wide cleanup rule (FR-29) applies to everything this stage touches.
- **The checkpoint** between the stages is a user step, not a phase.
  The user tests the RC on the host, releases it, then force-pushes the branch to `https://github.com/asafratzon/chamba` as its new `main` (a one-off push by URL from the host; no remote is added to this repo, and no extra branch is created here), and switches to the local chamba clone (`git fetch` + `git reset --hard origin/main` there, since the histories are unrelated).
  Totopo's RC-to-stable promotion continues in this repo independently; a fix landed here after the push reaches chamba only by hand-cherry-pick.
- **Stage 2 - chamba 0.4.0**, executed in the chamba repo directly on its `main`: the rename sweep and release simplification first (FR-31, FR-32, FR-33, FR-34), then web by default (FR-01..FR-06), the web pane and feedback channel (FR-12..FR-19, FR-28), the status strip (FR-20..FR-22), agent awareness, and chamba's minimal docs (FR-24).
  Chamba has no old shapes to meet - FR-10 and FR-30 do not exist on this side - and it is a private personal tool: no tags, no RC process, no public-facing docs baggage.

Every requirement below is tagged with its stage in its group heading (or on the requirement itself where a group is mixed).

## North star

The ideal (written when this was one product; it is now chamba's north star, while totopo keeps the terminal-first identity): the web interface is the product.
One command gives one address, and the browser tab is the whole workspace - agents, sessions, files, settings.
The terminal stream carries the rhythm of the work, and anything worth reading lifts itself out of the stream into a proper document: the agent publishes long answers, plans, and explanations as real HTML beside the terminal, navigable at the reader's own pace, with earlier ones a flip away.
The status line is not in the terminal at all: its data is state, and the page renders it as a crisp live strip beside the composer - context bar, energy bar, model, git - per session, never garbled by a TUI redraw.
Voice costs totopo nothing, because the OS already does dictation into any focused field.
And v4 owes nothing to the past: no migrations, no compatibility branches, a codebase that reads as if written for this shape from day one.
The raw terminal stays as a service hatch, not a product surface.

Chosen: almost all of the ideal survives.
The web pane is a document viewer over per-session HTML files on disk, not a live canvas: pages the user reads (plus forms that submit back), never agent-written code running inside the chamba page.
Live app previews and interactive widgets are deferred, because running agent-generated code in the UI reopens the isolation questions the product exists to close; a later version can add a sandboxed canvas without undoing this.
The status strip is a mirror of the status data Claude Code already emits (the per-session snapshots the statusline script writes), not a live probe - exactly as fresh as the terminal status line was.
Settings stay in the terminal menu: they are host-side operations the container's web server cannot perform, so the browser does not pretend to own them.

What shaped the candidates: Jupyter's outputs-beside-code, AI chat artifact panels (versioned documents in a side panel), the DevTools bottom drawer (minimizable, never steals the page), lightbox pagers, Warp's discrete output blocks, and the density conventions of VS Code's status bar and the tmux status line.

## Scope

Five work areas, confirmed with the user on 2026-08-22, recut across the two stages on 2026-08-23:

1. **Web interface by default** (stage 2, chamba) - no toggle, server starts with the container, opening a session opens the browser.
2. **Audio retirement** (stage 1, totopo) - all voice/audio code removed; macOS dictation (F5) covers the need.
3. **Migrations removed** (stage 1, totopo) - `migrate-to-latest.ts` deleted; a cheap detection check refuses old shapes with a clear message, and one single migration survives: current v3 (v3.16) workspaces get their obsolete audio settings tidied in place on first contact.
4. **Web pane** (stage 2, chamba) - agents publish standalone HTML pages into a per-session pane in the web interface, with history and a feedback channel back to the agent.
5. **Status strip** (stage 2, chamba) - Claude's status data rendered as a web component above the composer; chamba's terminal status line stops rendering, while totopo keeps its terminal status line untouched (to each his own, per the user).

Plus, added in the recut: the rename sweep totopo -> chamba, chamba's release simplification, and coexistence of the two tools (stage 2); the frontend module split, totopo's doc pass, and demo re-record (stage 1); the repo cleanup rule applies in both stages.

### Non-goals

- No settings UI in the web interface; the terminal menu keeps that job.
- No live previews or interactive canvas in the pane; published pages are documents. Scripts inside a page run only within its sandboxed frame (see the sandbox model under Data and contracts), never with access to the interface or its key.
- No light theme; the web interface stays dark-only with the per-workspace hue.
- No mobile-first design; desktop first, degrading gracefully on small screens.
- No status strip for codex and opencode sessions (no data source exists); nothing fake is shown.
- No migration of any pre-v4 structure, and no compatibility branches for old layouts, lock formats, or yaml shapes.
- Webterm's browser-side dictation (Web Speech API, the mic button) is unrelated to the audio server and stays.
- No behavior change in totopo beyond the cleanup: totopo keeps `web_enabled`, the auto-start setting, the `webterm` start step, the printed URL, and its terminal status line exactly as today. Everything web-first is chamba's.
- No migration or version detection in chamba: every chamba workspace onboards fresh, and chamba does not read `totopo.yaml`.
- No deeper chamba simplifications in 0.4.0 (docker volumes instead of host dirs, dropping the shell interface, and similar): the first release is this spec plus the rename, verifiable against a known-good base; the playground opens after it.

## Requirements

### Web by default (stage 2 - chamba)

- **FR-01**: The `web_enabled` setting is deleted; the web interface has no off switch anywhere (config, menu, code paths).
  AC: no `web_enabled` key is read or written anywhere; the Settings menu has no Web interface toggle; the web port is resolved on every session start.
- **FR-02**: The webterm server starts when the container starts, without any user step.
  AC: after Open session on a fresh container, `GET /status` on the workspace's web port answers without `webterm <agent>` ever having been run.
- **FR-03**: Opening a session opens the web URL (with its key) in the host's default browser, and the terminal continues into the plain container shell.
  AC: Open session on a host with a browser lands the user in a working web interface tab without typing a URL; the terminal still gets a shell.
- **FR-04**: On a host that cannot open a browser, the session prints the URL prominently and continues; the web interface never blocks a session.
  AC: with the opener command unavailable, Open session still reaches the shell and the URL is printed in the session banner.
- **FR-05**: The `webterm <agent>` command remains only to switch which agent new web sessions start with, and that choice survives container restarts (recorded host-side or in the workspace cache, not only in the container's `/tmp` state file), because it also names the agent whose conversation the unconditional resume marker resumes.
  AC: running `webterm codex` in the container changes the default agent for new sessions without restarting the server or ending existing sessions, and the choice still holds after a container recreate.
- **FR-06**: The auto-start-agent setting is deleted, along with its menu entry, env var, container label, and `.bashrc` branches.
  AC: no `auto_start_agent` key, autostart env var (under its post-rename name), or autostart label exists; a terminal session always lands in a shell.

### Audio retirement (stage 1 - totopo)

- **FR-07**: All audio server code is removed: `audio-host.ts`, the audio constants, the `.lock` audio flag, the `audio_mode` global setting, the dev.ts wiring, the menu notice, the settings submenu, and the SoX/PulseAudio packages in the Dockerfile.
  AC: `grep -ri "pulse\|sox\|audio" src/ templates/ bin/` returns no functional hits, with three exceptions: webterm's browser dictation, the unrelated `AudioContext` chime code, and the FR-30 tidy-up plus its tests, where the old `audio` key names are deliberate hardcoded literals per the migration convention (the same carve-out FR-29's stage-1 AC carries); all tests pass.
- **FR-08**: User-facing docs and injected agent context no longer mention voice/audio setup.
  AC: README has no Voice Mode section, troubleshooting entry, or security paragraph about the mic bridge; `templates/context/baseline.md` has no voice bullet.

### Migrations removed, one survivor (stage 1 - totopo)

- **FR-09**: `src/lib/migrate-to-latest.ts` is deleted and `bin/totopo.js` no longer calls `runMigration`. `isImageStale` survives by moving to a live module.
  AC: the file is gone, startup runs no migration, and the stale-image prompt still works.
- **FR-10**: totopo v4 detects a pre-v4 workspace shape cheaply and refuses with a message telling the user to run totopo v3.16.0 once (named exactly, e.g. `npx totopo@3.16.0` - the last v3 with the full migration chain), then return to v4.
  AC: a workspace with a v2 `~/.totopo/projects/` dir, a `meta.json` hash dir, an RC-era `.lock` (first line without `=`), or a `totopo.yaml` containing `project_id:`/`env_file:`/`schema_version:` gets the refusal message and no changes on disk; a v3-current workspace passes.
- **FR-11**: v4 writes an explicit version marker into `.lock` so future majors do not have to infer shapes.
  AC: a fresh or adopted workspace's `.lock` carries a version key, and `parseLockFile` reads it.
- **FR-30**: One single migration survives, from current v3 (v3.16) to v4 (decided at the quality review gate, 2026-08-22; narrowed to audio-only in the 2026-08-23 recut, since totopo now keeps `web_enabled` and auto-start): on first v4 contact with a workspace that passes the FR-10 check, v4 tidies the dead audio leftovers in place - the `audio=` key is dropped from `.lock` when the version marker is stamped, and the audio-mode key is removed from the host-global config. Nothing else changes, there is no migration framework, and the lock parser tolerates unknown keys so the step is safe to re-run. The migration convention holds: the old key names are hardcoded string literals, the destinations use constants.
  AC: a v3.16 workspace opens in v4 with no manual step; after the first run its `.lock` has the version key and no `audio` key, the global config has no audio-mode key, and everything else is byte-identical; running v4 again changes nothing.

### Web pane (stage 2 - chamba)

- **FR-12**: A CLI helper inside the container (`webpane`) publishes a standalone HTML file as a page of the calling session's pane, usable by any process (claude, codex, opencode, a shell).
  AC: running the helper with an HTML file inside a webterm session makes the page appear in that session's pane without a refresh.
- **FR-13**: Published pages are files in a per-session artifacts directory; the webterm server watches it and pushes to the attached browser window over the existing websocket.
  AC: a file placed in the artifacts directory by hand appears in the pane; killing and reopening the browser tab shows the same history.
- **FR-14**: The pane renders per the approved mock `../mocks/pages-pane.html`: docked right of the terminal, a horizontal pagination bar of page chips (title, age, unread badge) above the content, a draggable divider for width, and a collapse below ~150px into a thin vertical "Web pane" spine with an unread count, click to reopen. A new page never auto-selects: it gets an unread badge on its chip (and ticks the spine's counter when collapsed), and the pane switches only on click - except an empty pane, which selects its first page on arrival. The chips bar is pane chrome rendered by the interface itself, outside the page's frame, so a published page can never fake which session and page the user is looking at.
  AC: each listed behavior works in the browser as in the mock; a page arriving while another is open changes nothing but the badge; the pane state (width, collapsed) survives switching session tabs.
- **FR-15**: Pages are per session - switching tabs switches the pane's contents, and two parallel sessions never mix - but the files are persistent: closing a session or restarting the container deletes nothing, and there is no age-based sweep. Artifacts are keyed by the agent's own conversation id (decided at the quality review gate, 2026-08-22), so ANY session that resumes a conversation - the marker-driven auto-resume after a container restart, or a manual resume the server never saw coming - adopts that conversation's page history, for all three agents.
  AC: two sessions publish pages and each tab shows only its own; after a container restart, the auto-resumed session's pane lists the pages published before the restart; a manual `claude --resume <id>` (and the codex/opencode equivalents) in a new web session brings that conversation's pages back; no cleanup timer touches the artifacts.
- **FR-16**: A Claude skill (baked into the image like the other built-in skills) teaches when and how to publish well: long answers, plans, explanations, tables, diagrams; standalone HTML, dark theme matching the interface.
  AC: the skill is present in a claude session and its instructions produce pages that render correctly in the pane.
- **FR-28**: The publish helper is part of the injected agent context for all three agents, so every agent is aware of it, and the guidance tells agents to prefer publishing a page when a question has more options or structure than their built-in question tooling allows (rich choice lists, tables of options, forms).
  AC: the injected context for claude, codex, and opencode names the helper and this guidance; asking any agent "how can you show me something rich?" gets an answer that names the pane.
- **FR-17**: The artifacts route is key-gated and path-contained like the rest of the interface: containment resolves real paths (symlinks followed and checked), symlinks and non-regular files are refused outright, and pages are served as `text/html; charset=utf-8` with `X-Content-Type-Options: nosniff`.
  AC: fetching an artifact URL without the key is rejected; path traversal outside the artifacts root is rejected; a symlink inside the artifacts root pointing at any file outside it (workspace files, the key file) is refused.

### Feedback channel (stage 2 - chamba)

- **FR-18**: A published page can carry a form; submitting it saves the answers as a feedback file on disk in the container, where the agent reads it as data submitted from the page. The endpoint is bounded and bound: a body size cap and a per-page debounce, with the target session, page id, and filename derived server-side from the artifact being served, never taken from the request body.
  AC: submitting the mock-style form writes a JSON file containing the page id, a timestamp, and the named field values; an oversized or rapid-fire submission is refused; a crafted request cannot write into another session's directory or nudge another session's agent.
- **FR-19**: A submission also nudges the session's terminal: a short line typed into the agent's PTY saying feedback arrived and where it is.
  AC: after a submit, the agent's terminal receives one line naming the feedback file path; busy detection does not flag the echo as agent output (reuse the existing typed/paste path).

### Status strip (stage 2 - chamba)

- **FR-20**: A claude session's tab shows a status strip above the composer rendering the session's snapshot data: model + effort, context tokens/window with a bar, quota remaining with a bar and recharge countdown, and Claude Code version - per session, live-updated as snapshots change.
  AC: two claude sessions show their own differing values; the strip updates within a few seconds of the snapshot changing; codex/opencode sessions show no strip.
- **FR-21**: Snapshots are matched to sessions by pid ancestry: the server records each session's PTY leader pid and accepts a snapshot whose `claude_pid` is that pid or a descendant of it (walked via `/proc`), with `claude_pid_start` as the recycled-pid tiebreak. Plain equality is not assumed, because wrappers or shells between the PTY leader and the claude process would break it; the exact process shape is verified on the host during implementation.
  AC: with two concurrent claude sessions, each strip shows its own session's data, never the other's; the join still works when claude is not the direct PTY leader.
- **FR-22**: In chamba, the terminal status line stops rendering everywhere; the statusline script keeps running invisibly and keeps writing the per-session snapshots. Totopo is untouched: it keeps its visible terminal status line as today.
  AC: in chamba, no status line is visible in any claude session (web or plain terminal); snapshot files keep appearing and the `context-usage` helper keeps working.

### Cleanup and release (mixed - each requirement carries its stage)

- **FR-23** (stage 1 - totopo): The webterm frontend is split into ES modules (terminal, tabs, composer, connection, and similar; the pane and strip modules arrive in stage 2 on this structure) with no build step, loaded via `<script type="module">`.
  AC: `app.js` as a monolith is gone; each module is under roughly 600 lines; the interface works unchanged in the browser.
- **FR-24** (stage 2 - chamba): Chamba gets a minimal personal README (decided 2026-08-23; chamba is private, so no public docs baggage): what chamba is, `npx chamba`, the web-first flow, and the web pane with its feedback file in a few lines. No demo GIFs, no marketing structure; totopo's full README does not carry over.
  AC: the chamba README is short, current, and mentions no totopo-only concepts (web toggle, `webterm` start step, voice, auto-start); no demo assets exist in the chamba repo.
- **FR-25** (stage 1 - totopo): The advanced demo GIF is re-recorded, since it currently stars the audio server (host-side task; the plan marks it as a user step). Totopo's README keeps its current structure, minus the voice sections (FR-08).
  AC: totopo's README demos show no audio server output.
- **FR-26** (stage 1 - totopo): Totopo's release ships as v4.0.0 through the standard RC process on an RC branch; chamba's release is FR-32.
  AC: `pnpm check` is green and the version boundary is a major bump.
- **FR-29** (both stages): The whole repo - tests, comments, docs, scripts - is adapted to each stage's shape as that stage lands: tests covering removed features are removed, tests touching changed behavior are updated, and the new pieces (refuse-check, browser open, web pane server and client, status strip, helper) get tests in the repo's existing style (`tests/webterm*.test.ts` as the model for webterm code); no dead code, orphaned constants, or stale comments referring to the old shape remain.
  AC: `pnpm check` is green in each stage; after stage 1, grepping for `audio` and `runMigration` finds no functional hits outside the FR-30 tidy-up and its tests, where the old names are deliberate hardcoded literals per the migration convention; after stage 2, grepping for `web_enabled`, `auto_start`, and `totopo` in the chamba repo finds no functional hits (the FR-31 rename AC carries the full list); each new module has a test file.
- **FR-27** (stage 1 - totopo): The README carries a "Coming from v3" section for a v3.16 user: a v3.16 workspace just works - the first v4 run tidies the dead audio settings itself (FR-30) - and the section says what changes on that first run (voice is gone; everything else behaves as in v3.16). Only older shapes need a step: run totopo v3.16.0 once (`npx totopo@3.16.0`) to bring the workspace to the v3.16 shape - that run performs any previously needed migration - then return to v4.
  AC: a v3.16 user can follow the section alone to a working v4 workspace, without reading code or release notes; the run-v3-once instruction is presented as the path for pre-v3.16 shapes only.

### Chamba identity (stage 2 - chamba)

- **FR-31**: Everything is renamed totopo -> chamba, as the first work of stage 2 so every later phase builds already-branded: package name and bin (`chamba`, published as the existing `chamba` npm package, version 0.4.0), config file `chamba.yaml`, host cache `~/.chamba/`, container names `chamba-<id>`, docker labels `chamba.*`, env vars `CHAMBA_*`, the agent context text, skill names, webterm branding, repo rule files, and code identifiers where the name is load-bearing.
  The tag-pinned GitHub README URL is dropped, not renamed (decided 2026-08-23): the CLI's Help entry loses its URL line and the injected `readme_url` context line is removed, because the chamba repo is private and tags are gone, so no such URL can resolve.
  AC: `grep -ri totopo` across the chamba repo finds no functional hits (historical mentions in the README's provenance line and the git history excepted); no GitHub URL is printed by Help or injected into agent context; onboarding writes `chamba.yaml`; the container and cache paths carry the new name; `npx chamba` works end to end.
- **FR-32**: Chamba's release process is the bare minimum (decided 2026-08-23): bump the version in `package.json` and `npm publish`. The RC branch process, git tags, `scripts/changelog.yaml`, the generated `CHANGELOG.md`, and the release skill are all removed; the git log is the history.
  AC: no changelog files, release scripts, or tag references remain in the chamba repo; a release is exactly a version bump plus a publish.
- **FR-33**: The generated `chamba.yaml` gets an editor-schema header (`# yaml-language-server: $schema=...`) pointing at the schema inside the published npm package via a public npm CDN (for example `unpkg.com/chamba@<version>/schema/...`).
  Note for the implementer: no schema line exists in generated files today - v3 deliberately removed the header (v3.2.1 migration) because hand-maintained tag URLs went stale, and validation is in-process via ajv, which stays.
  This requirement reintroduces the header, now safe because the URL is pinned by the package's own version, and it exists because the repo is private and tags are gone, so no GitHub URL can work.
  AC: editor validation of a generated `chamba.yaml` resolves the schema; no GitHub or tag URL exists in generated files.
- **FR-34**: Chamba and totopo coexist: separate config file, cache directory, container names, and labels mean the two tools can manage workspaces side by side on one host (including the same directory, each with its own config file), and neither reads the other's state. Port allocation stays dynamic as today, so the two tools draw from the pool without stepping on each other.
  AC: a host with live totopo workspaces onboards and runs a chamba workspace with no interference in either direction; a directory holding both `totopo.yaml` and `chamba.yaml` opens correctly in each tool.

## Data and contracts

These shapes are the spec's proposal; the implementer may adjust details that do not change behavior, and must keep the file-on-disk nature of both channels.
All the contracts in this section belong to stage 2 and are written with totopo-era paths; once the FR-31 rename lands (which happens before any of this is built), read `~/.totopo/` as `~/.chamba/`, `totopo.yaml` as `chamba.yaml`, and so on.

**Artifacts directory** (persistent, host-mounted, session-scoped):

```
~/.totopo/workspaces/<id>/agents/webpane/   on the host, bind-mounted at ~/.webpane in the container
  <session-key>/
    <NN>-<slug>.html        one published page; NN increments per session
    feedback/
      <NN>-<slug>-<epoch>.json   one file per submission on that page
```

The `<session-key>` is the agent's conversation id, which is what makes adoption work for every kind of resume: the resumed conversation has the same id, so it lands in the same directory.
Per-agent id discovery, all from stores the product already reads or mounts:
- claude: the session id in the statusline snapshot matched to the PTY by the FR-21 ancestry join, with the cwd-matched transcript scan (`webterm.ts:257-338`) as the fallback - both exist today.
- codex: the id in the newest rollout file (`~/.codex/sessions/.../rollout-<timestamp>-<uuid>.jsonl`) whose recorded cwd matches the session's, the same newest-matching rule the claude scan uses.
- opencode: the current session id from opencode's local store, matched the same way.
A session whose id is not yet known (the agent has not written its first record) or never discoverable (a plain shell, an unknown agent) writes under a server-generated provisional key; when the id appears, the server renames the provisional directory to the id key, and the pane follows.
The exact discovery code per agent is implementation work; what is binding is the key's identity (the conversation id), the provisional-then-rename behavior, and the never-mix rule.
Artifacts are never swept by age and never deleted on session close.
The host directory sits under `agents/`, which is exactly what Advanced > Clear agent memory removes (`src/commands/advanced.ts:118-119`), so that menu item is the one thing that clears it - true against the code, not just intended.
Growth is bounded without deleting anything: a per-file size cap and a per-workspace total cap are enforced server-side (not only in the helper, which a direct writer can bypass); past the total cap, new publishes are refused with a plain error, and nothing existing is removed.

**Publish helper**: `webpane <file.html> [--title "..."]` - copies the file into the calling session's artifacts directory and exits 0; exits non-zero with a plain message when it cannot resolve a session.
Session resolution is the server's job, not the helper's: the helper passes its own pid, and the server walks `/proc` ancestry from that pid up to a PTY leader pid it independently knows - the helper never names a session key directly, because a key passed as an argument would be a value the server has to trust.
A caller whose ancestry reaches no known session is refused, and nothing is written.
Any process in a webterm session's tree can publish.

**Naming and discoverability**: the feature is called the **web pane** everywhere - the UI (the collapsed spine already reads "Web pane"), the README, the injected context, the skill name (`web-pane`), and the helper (`webpane`).
One name is what lets a user say "put that in the web pane" without naming a skill, and what makes those words match the skill's trigger description.
Two layers drive agent auto-use: the always-on injected context carries the short standing rule (FR-28), and the skill's description lists the natural trigger phrases ("show me", "as a page", "in the pane", "publish", long plan, rich question, more options than the question tool holds).
The session greeting names the pane, and every feedback nudge shows the pattern in action.

**Feedback file** (written by the server on form submit):

```json
{
  "page": "03-plan-publish-ports-rework",
  "submittedAt": "2026-08-22T09:41:12Z",
  "fields": { "q1": "Fail the whole start when a port is taken" },
  "text": "the user's free-text box, when the form has one"
}
```

**The nudge** (typed into the PTY via the existing paste path):

```
[web pane] Feedback submitted on "Plan: publish-ports rework" - read ~/.webpane/<session-key>/feedback/<file>.json
```

The nudge is built from server-controlled text only: the title is sanitized (control and escape characters stripped, length capped, single line) and the path is one the server generated itself, so published content can never smuggle raw keystrokes into a PTY through the nudge.

**New websocket frames** (joining the existing `msg.t` router):

- `pages` - the artifact list for the attached session: `[{ id, title, mtime, unread }]`.
- `page` - one artifact's content on selection (or the client fetches it over the key-gated artifacts route; implementer's choice).
- `snapshot` - a claude session's latest snapshot fields: `model`, `effort`, `context_tokens`, `context_window_size`, `context_used_pct`, `quota_left_pct`, `quota_resets_at`, `version`. ("snapshot", not "status", to avoid colliding with any existing status wording in the protocol.) Today's snapshot files carry neither `context_window_size` nor the Claude Code version; the statusline script is extended to write both, since it already parses them from Claude Code's stdin JSON.

**Sandbox model** (decided at the quality review gate, 2026-08-22): the pane shell - trusted interface code - fetches a page's content over the already key-gated channel and renders it into an iframe via `srcdoc` or a blob URL, with `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`.
The frame therefore has an opaque origin and no URL of its own carrying the key: agent-authored scripts run, but nothing they can reach holds the key or the parent's DOM.
This is what makes the north-star claim ("never agent-written code running inside the chamba page") true by construction rather than by stripping.

**Form wiring in published pages**: the pane shell injects a small script into the page content before rendering it that wires any `<form data-feedback>` to a `postMessage` to the parent shell; the shell, which alone holds the key, forwards the submission to the key-gated submit endpoint. Pages stay plain HTML; the agent writes no networking code, and no key ever appears inside the frame.

## Edge cases and errors

- Host cannot open a browser (SSH, headless, no opener command): print the URL, continue (FR-04).
- Artifacts directory missing or unreadable: the pane shows its empty state; the helper recreates the directory on publish.
- A published file that is not valid HTML: rendered as-is in the sandboxed frame (per the sandbox model in Data and contracts); the pane does not crash.
- Oversized artifacts: cap per-file size (reuse the upload cap's spirit) and refuse in the helper with a plain message.
- Feedback submitted while the agent is mid-work: the nudge line lands in the PTY like any user keystroke; no special casing.
- Feedback submitted twice: each submission is its own file; nothing is overwritten.
- Session closed while its page is open in the pane: the pane empties for that tab, but the files stay on disk (FR-15); a later resume of the same conversation brings them back.
- Snapshot stale or absent (claude not yet rendered a prompt, or statusline never ran): the strip shows nothing or a quiet "waiting" state, never stale data presented as fresh - snapshots older than the session's start are ignored via the pid start-time check.
- Two live sessions claiming the same artifacts key (a second session resuming a conversation whose key is already attached to a running session): the server refuses the adoption for the second session, which starts with an empty pane and a plain notice - two writers on one directory would interleave page numbering.
- Feedback submitted after the session's agent has exited: the file is still written (it is the durable channel); the nudge is skipped because there is no PTY to type into.
- Old workspace shapes: refused with the v3-first message, nothing written (FR-10); a current v3.16 shape is not "old" - it is tidied in place (FR-30).
- Port range exhausted or server down: the same behavior totopo has today - say so, open the session without the web interface; the browser-open step is skipped.

## Decisions

- **Pane transport: files on disk, server watches.** Chosen for robustness (history survives restarts and reconnects by construction) and universality (anything that writes a file publishes). Rejected: HTTP POST to the server - needs the server reachable at publish time and still has to persist somewhere; adds a failure mode without adding capability.
- **Pane is a document viewer, not a canvas.** Chosen to keep v4's isolation story intact and the design small. Rejected: live previews/interactive content - reopens sandboxing questions; can be revisited later.
- **Status strip mirrors the statusline snapshots.** Chosen because the data source already exists and matches the terminal line's freshness. Rejected: probing Claude Code directly - no supported interface for it.
- **Terminal status line stops rendering everywhere in chamba.** For chamba, the web is the product; the raw terminal is a service hatch. Totopo is out of scope for this bullet - the later coexistence bullet gives totopo its line. Rejected: per-session-type visibility within chamba - more states for a surface chamba no longer treats as primary.
- **Refuse-check instead of migrations, plus one surviving migration.** One cheap detection (shape markers listed in the codebase analysis) replaces 712 lines, and a single v3.16-to-v4 tidy-up (FR-30, decided at the quality review gate) keeps current workspaces opening with no manual step. Rejected: silent re-onboard - confuses v3 users; keeping the migration chain - the very thing v4 sheds.
- **Frontend split into ES modules, no build step.** Keeps the no-bundler simplicity while making the pane and strip reviewable additions. Rejected: appending to the monolith (a ~3,500-line file), or adopting a bundler (a build step webterm has deliberately avoided).
- **Settings stay in the terminal menu.** Host-side operations need the host; the web does not pretend otherwise in v4.
- **Published pages render in a sandboxed frame with no same-origin and no key inside.** Decided at the quality review gate. Chosen so agent scripts can run without any path to the interface key; forms talk to the shell by postMessage. Rejected: a key-gated iframe URL (the key rides into agent-readable territory) and blocking scripts outright (kills page interactivity and reinvents form handling).
- **Artifacts are keyed by the agent's conversation id.** Decided at the quality review gate. Chosen so any resume - marker-driven or manual, any agent - finds its pages by identity rather than by a channel the server had to witness. Rejected: a server-generated key handed through the resume marker (misses manual resumes) and cwd keying (mixes parallel sessions).
- **A new page never steals the pane.** Decided at the quality review gate. The unread badge invites the click; only an empty pane auto-selects its first page.
- **Two products, two stages.** Decided with the user on 2026-08-23, after the spec was first finalized. The pivot ships as chamba (the user's separate npm package, private, no users) so totopo stays a stable terminal-first tool in its own right; the shared cleanup lands in totopo first so the fork diff is only the pivot plus the rename. The checkpoint between the stages is the user's: test the RC, release it here, force-push the branch by URL onto chamba's `main` (no remote added here, no extra branch here), and continue stage 2 in the chamba repo on its `main`. Rejected: doing the whole pivot inside totopo (breaks a working daily tool), and forking without the shared-cleanup stage (every cleanup line would need porting by hand across diverging repos).
- **Chamba drops the release baggage.** Bare-minimum releases (version bump + npm publish), no tags, no changelog machinery - it is a private personal tool built for quick iteration. The schema line in generated `chamba.yaml` points at the npm package via a public CDN, which needs no tags and no public repo.
- **Totopo keeps its terminal status line; the strip is chamba-only.** To each his own: the terminal-first tool keeps the terminal line, the web-first tool renders the strip and silences the line.

## Solution sketch

> **This solution sketch is non-binding.** It is a suggested direction formed with limited knowledge during spec-writing, not a fixed instruction.
> The implementing agent is free - and expected - to find the better design while building, and must flag any noticeable departure so the user stays informed.

Rough shape of the change, by area (the audio/migration removals and the module split are stage 1 in totopo; everything web-default, pane, and strip is stage 2 in chamba, built after the FR-31 rename):

- **Removals first** (audio, migrations, `web_enabled`, auto-start): mostly deletion guided by the codebase analysis below; `isImageStale` moves into `src/lib/` proper (e.g. a small `image-stale.ts` or into `dev.ts`'s orbit); the refuse-check becomes a small `src/lib/legacy-check.ts` called early in `bin/totopo.js`.
- **Web default**: `dev.ts` loses the `readWebEnabled()` branch; the webterm launch moves from the once-per-start hook into the container start path unconditionally; a tiny cross-platform opener (`open`/`xdg-open`/`start`, best-effort) fires after the whole once-per-start block - not only after `startWebtermAndVerify`, since the connected-path branch with a healthy server never calls it - keyed on a resolved port plus a successful key read, before the blocking `docker exec`. The key is validated against its known shape (32 hex characters) before use, the URL is built host-side from validated parts only, and the opener is spawned argv-style with no shell, because the key file is writable by every container process and must not become a container-to-host command path. The resume marker is planted unconditionally (it no longer depends on the deleted auto-start setting), using the webterm default agent.
- **Server side** (`templates/webterm/`): `artifacts.js` (watcher + list + serve + feedback endpoint + nudge via the existing `paste()` machinery), `status.js` (snapshot poller + pid join), both feeding new frames through the existing `send()`; `server.js` gains the key-gated routes.
- **Client side** (`templates/webterm/public/`): `app.js` becomes `main.js` importing `terminal.js`, `tabs.js`, `composer.js`, `connection.js`, plus new `pane.js` and `status-strip.js`; `index.html` gains the pane container and strip element per the approved mock.
- **Container image**: the `webpane` helper baked like `context-usage`; the publish skill added under `templates/skills/`; statusline script silenced (keeps snapshot writes, stops printing).
- **Docs**: README rewrite, `templates/context/` updates, demo re-record marked as a host/user step.

## Mocks

- `pages-pane` - The web pane and status strip in the web interface - ../mocks/pages-pane.html

The chosen direction is the side split (candidate 01 of 4), revised per the user's feedback: history as a horizontal pagination bar of chips above the page, and a draggable pane width that collapses to a thin vertical "Web pane" spine below ~150px. The rejected candidate pages (bottom drawer, overlay projector, notebook feed) were deleted at the user's direction when the spec was finalized; the log in the README records the fan-out.

Approved: 2026-08-22

## Decisions from the interview

Confirmed by the user on 2026-08-22.
This section is the record of what the user confirmed, in interview order; where a bullet overlaps the Decisions section above, the Decisions section carries the design rationale and this one carries the confirmation.
The bullets predate the 2026-08-23 two-product split: the web-first bullets now describe chamba (read `npx totopo` as `npx chamba` in them), while the audio and migration bullets describe totopo v4.

- **The pane is a document viewer, plus feedback.** No live previews or arbitrary interactive canvas in v4. One addition to the pure viewer: a page can submit data back - the submission is saved as a special feedback file on disk in the container, which the agent reads as a response or as data submitted from the page. This makes published pages usable as forms and question sheets, not just reading material.
- **The terminal status line stops rendering everywhere.** The web is the product; a raw terminal session is a service hatch and gets no status line. The statusline script still runs invisibly to collect the per-session data the web strip mirrors.
- **The `web_enabled` setting is deleted.** v4 has no off switch for the web interface; it is part of the product like the container itself.
- **Submit nudges the terminal.** A page submission is saved to the feedback file, and the web server also types a short notification line into that agent's terminal, so the agent reacts immediately. The file holds the data; the nudge only says feedback arrived.
- **Theme: dark only.** The new pieces (pane, published pages, status strip) inherit the existing webterm dark look and per-workspace hue.
- **Devices: desktop first, usable on mobile.** The pane and strip degrade gracefully on a phone (pane as full-screen overlay, strip wraps); no mobile-specific features.
- **Old workspace layouts are refused with a clear message.** v4 keeps one cheap detection check that recognizes a pre-v4 shape and says: run totopo v3.16.0 once to bring this workspace up to date, then return to v4. No migration code.
- **The web server starts with the container.** No enable step, no `webterm` start step; every session banner prints the URL. The `webterm <agent>` command stays only to switch which agent new sessions start with.
- **Opening a session opens the browser.** `npx totopo` -> Open session starts the container, brings up the web server, and opens the URL in the host's default browser. The terminal the user ran totopo in becomes a plain container shell (the service hatch). The auto-start-agent setting is deleted; the browser picks its agent per session.
- **README rewritten web-first.** (Superseded by the 2026-08-23 recut: neither product gets this README. Chamba gets a minimal personal README instead - FR-24 - and totopo's README keeps its structure, losing only the voice sections - FR-08, FR-25.) The original confirmation: the web interface moves up into core features and the quick start shows the browser; the Voice Mode section, its troubleshooting entry, and the voice paragraph under "what totopo protects against" go.
- **Demo GIFs re-recorded** for the v4 flow (the advanced demo currently stars the audio server).
- **The status strip appears for claude sessions only.** Its data comes from Claude Code's statusline hook; codex and opencode sessions have no strip (nothing fake, nothing half-empty).
- **Publishing works for all agents.** A small CLI helper inside the container (`webpane <file.html>`) publishes a page from any process; Claude additionally gets a skill that teaches it when and how to use the helper well. The feature is named "web pane" across UI, docs, context, skill, and helper, so users can refer to it naturally and the name itself triggers the skill.
- **Settings stay in the terminal menu.** `npx totopo` still shows the workspace menu; Open session is what opens the browser. Git mode, shadow paths, rebuild, and reset remain terminal-menu operations - they are host-side and the container's web server cannot perform them. No settings UI in the web in v4.
- **Settings menu slimmed.** (Split by the 2026-08-23 recut: the Voice / audio entry goes in stage 1 - totopo loses it too, FR-07 - while the Web interface and auto-start entries go only in chamba, stage 2 - totopo keeps both, per the Non-goals.) The original confirmation: the Voice / audio and Web interface entries go; the auto-start entry goes with its setting; agent context and injected docs stop mentioning voice and webterm setup.

## Codebase analysis

What the code says about each piece of the work, with the references the implementer needs.

### Audio removal surface

- Delete whole files: `src/lib/audio-host.ts` (204 lines) and `tests/audio-host.test.ts`. Caution: `IS_MACOS` is exported from `audio-host.ts:22` and imported by `menu.ts`, `dev.ts`, `settings.ts` - today all three use it only for audio, so it goes with the file; re-check at build time.
- Constants: `src/lib/constants.ts:28` (`PULSE_COOKIE_FILE`), `:66` (`LABEL_AUDIO`), `:106-124` (audio bridge block + `AUDIO_MODE`). The `GLOBAL_DIR` comment at `:16` mentions the cookie - edit, keep the constant.
- The `.lock` audio flag: `src/lib/workspace-identity.ts:38` (key), `:94`, `:122`, `:154-163` (`readAudio`/`writeAudio`), `:195-200` (`initWorkspaceDir` audio param). Removing the key changes the on-disk lock format.
- Host-global mode: `src/lib/global-config.ts:74-86` (`readAudioMode`/`writeAudioMode`) and the `audio_mode` key at `:28`.
- Container wiring in `src/commands/dev.ts`: imports (`:12-41`), the `countdown()` helper at `:82-90` (its only caller is the audio warning at `:699` - delete both), container-info label slot (`:132-152`), `audioStateLabel`/`shouldStopHostAudioServer` (`:176-202`), start options (`:237-271`), run args (`:326`, `:342-360`, `:488-498`), recreate-on-change (`:367-398`), session start auto-start (`:686-706`), session exit auto-stop (`:823-830`), stale-mount hint (`:539-547`).
- `src/lib/sessions.ts:45-47`: `connectedSessionCount()` exists for the audio auto-stop; decide delete or keep when its last caller goes.
- Menu and CLI: `src/commands/menu.ts:10-15`, `:21-30`, `:71-81` (audio notice), `:98` (settings hint text); `bin/totopo.js:18`, `:175-178`; `src/commands/settings.ts:200-291` (whole `audioMenu`), `:489`, `:511-512`.
- Image and context: `templates/Dockerfile:34-35` (drop `sox libsox-fmt-pulse pulseaudio-utils`); `templates/context/baseline.md:10` (voice bullet).
- Tests that go or shrink: `tests/dev.test.ts` (mostly audio - only `resolveWorkdir` remains), `tests/docker/session-lifecycle.test.ts:358-412` (five audio tests plus fixtures), `tests/workspace-identity.test.ts` (audio-flag tests), `tests/global-config.test.ts:42-95` (audio-mode tests).
- Docs: `README.md:50-52`, `:102`, `:297-305`, `:348`, `:375`; `BACKLOG.md:9` (the item requesting this).
- NOT audio: webterm's browser dictation (`app.js:2534-2624`, Web Speech API, the `#mic` button) is independent of PulseAudio and stays; so do the unrelated `AudioContext` chime and pulse-animation code in `app.js`.

### Web-by-default and the session open flow

- `web_enabled`: defined `src/lib/global-config.ts:27-32`, accessors `:107-116`; read at `src/commands/dev.ts:618`, `src/commands/onboard.ts:249-251`, `src/commands/settings.ts:296`, `:343` (toggle write), `:490` (menu hint). Deleting the setting makes `dev.ts:612-647` (port resolution) unconditional. The `web_range` setting stays (the port range is still real); it needs a home once the Web interface settings submenu (`settings.ts:294-395`) is slimmed.
- Auto-start: `auto_start_agent` accessors `global-config.ts:92-102`; read at `dev.ts:311`, `:797`, `:807`; menu `settings.ts:398-429`; `TOTOPO_AUTOSTART` env + label `dev.ts:327-339`; the `.bashrc` auto-start branches baked by `src/lib/dockerfile-builder.ts:25-80` (web-URL print at `:50-56`, shell auto-start at `:59-77`); tests `tests/dockerfile-builder.test.ts:49-66`, `tests/docker/session-lifecycle.test.ts:328-351`.
- Browser-open hook: the natural place is `src/commands/dev.ts:785-816`, after the interface is verified up and before the blocking `docker exec` at `:819` - the only host-side point where the port, the verified server, and the key are all known. The URL is `http://localhost:<webPort>/?k=<key>` with the key read fresh from the container via `readWebKey` (`src/lib/webterm.ts:161-166`); nothing on the host stores the key, and no browser-opening helper exists in the repo yet.
- The `webterm <agent>` launcher (`templates/webterm.sh`) is gated on `TOTOPO_WEB_URL` (`:14-20`) and prints the URL on success (`:158`); `TOTOPO_WEB_URL` is injected at `dev.ts:486`.

### Migrations and the v4 refuse-check

- `src/lib/migrate-to-latest.ts` (712 lines) has exactly one caller: `bin/totopo.js:60-66`, non-fatal, before everything else. It registers 11 migrations (v1 artifacts through v3.12.2 `env_file:` rename).
- `isImageStale` (`migrate-to-latest.ts:705-712`) is NOT a migration - it is used by `dev.ts:42,736` and must survive the file's deletion (relocate it).
- Neither `totopo.yaml` nor `.lock` carries a version field (`schema_version` was deliberately removed in v3.2.1), so the refuse-check keys off shape markers, all cheap: `~/.totopo/projects/` exists (v2), `meta.json` in any `~/.totopo/workspaces/<dir>/` (v2 hash dirs), a `.lock` whose first non-empty line lacks `=` (RC-era), `project_id:`/`env_file:`/`schema_version:` present in `totopo.yaml` (old yaml shapes). FR-11 adds an explicit version marker to `.lock` so future majors do not have to infer.

### Webterm internals (where the pane and strip land)

- Sizes: `templates/webterm/server.js` 773 lines, `sessions.js` 515, `config.js` 198, `public/app.js` 2633, `index.html` 63.
- Layout: `body` is a flex column (`styles.css:34-38`) of `#tabbar`, `#termwrap { flex: 1 }`, and `#composer` (`index.html:23-52`, the strip below the terminal with the textarea, attach, mic, send). A pane is a new flex child; the status strip sits with the composer.
- Protocol: server frames go through `send()` (`server.js:350`) / `broadcastSessions()` (`:356`); the client routes on `msg.t` in `onFrame` (`app.js:1710`). A new frame type (pages, status) is one branch on each side.
- Sessions know what the pane needs: `sessions.js:381-410` - each session carries `id`, `agent`, `cwd` (absolute), and `term` (the PTY). Lifecycle hooks for cleanup: `close()` (`:436`), `onExit()` (`:360`).
- Writing into a session's terminal already exists: `paste()` (`server.js:592-612`) wraps text in bracketed paste and submits, and goes through `registry.typed()` so busy detection ignores the echo - the feedback nudge should reuse it (via `registry.get(sid)` for a server-initiated write).
- No fs watcher exists today (no chokidar; sync fs only). An artifacts watcher joins the existing timers next to `registry.tick()` (`server.js:733`).
- Serving artifacts: model on the uploads pattern (`POST /upload`, `server.js:287-310`; containment check `isInsideUploadRoot` `:72`) but note uploads have no read route today and static mounts are deliberately ungated (`:237-241`) - an artifacts route must be key-gated (`requirePage`/`requireKey`, `:242-256`) with a containment check.

### Status strip plumbing

- The statusline script (`templates/claude-statusline.sh`) parses Claude Code's stdin JSON (`:77-100`) and, after rendering, atomically writes a snapshot to `~/.claude/context-usage/<session_id>.json` (`:327-340`) with fields: `session_id`, `claude_pid`, `claude_pid_start`, `updated_at`, `context_tokens`, `context_used_pct`, `model`, `effort`, `quota_left_pct`, `quota_resets_at`.
- Wiring: `agent-context.ts:176-187` writes `statusLine: { type: "command", command: CLAUDE_STATUSLINE_PATH }` into the workspace's claude `settings.json` only when unset; the script is baked at `templates/Dockerfile:131-134`; `~/.claude` in the container is the workspace cache's `agents/claude` on the host (bind mount, `agent-context.ts:40-45`).
- Matching snapshot to webterm session: webterm spawns the agent directly as the PTY leader (`server.js:486-499`), so `session.term.pid` is expected to equal the snapshot's `claude_pid` - but FR-21 joins by ancestry rather than assuming equality, in case a wrapper sits between. `claude_pid_start` (`/proc/<pid>/stat` field 22) is the recycled-pid tiebreak - the same rule `context-usage.sh:85-93` already uses. Nothing in webterm reads `term.pid` today.
- Caveats: only claude sessions produce snapshots; a snapshot appears only after the status line renders at least once; the snapshot dir is bind-mounted so stale files from earlier container runs can carry recycled pids (hence the start-time check). Cleanup exists at `templates/startup.mjs:73-90` (7-day sweep).
- Making the terminal line invisible while keeping the snapshot: the script keeps parsing and writing the snapshot but stops printing the rendered line (or prints an empty line) - the exact technique is checked against Claude Code's behavior during implementation. The `context-usage` helper (`templates/context-usage.sh`) and the totopo-statusline skill (`templates/skills/totopo-statusline/`) read the same snapshots and script - both need a pass when the script changes.

## Assumptions

Guesses taken below the clarification bar, labeled so the implementer knows what was assumed rather than confirmed:

- **Headless hosts degrade gracefully.** When the host cannot open a browser (SSH, no display), the session prints the URL prominently and continues - the web interface never blocks a session, as in v3.
- **The per-agent conversation-id discovery details** (the key's identity is decided - the conversation id - but the exact codex/opencode store reads and the rename timing are implementation work), as long as parallel sessions never mix and a resumed conversation reclaims its history.
- **How the terminal status line is made invisible** (empty statusline output vs removed statusLine config plus a separate snapshot hook) is an implementation detail, chosen during implementation against how Claude Code behaves.
- **The publish helper's session resolution** (pid ancestry against the server's PTY pids) may be refined during implementation, as long as any process in a session's tree can publish and a process outside any session gets a plain error.
- **Success means**: `pnpm check` green in both repos; totopo v4.0.0 released through the standard RC process with the cleanup verified on the host; the chamba flow demonstrated end to end on the host (session opens browser, pane and strip work) and published as 0.4.0 with the bare-minimum release.

## Constraints

- The repo rules in `AGENTS.md` bind all of this work: ESM `.js` imports, plain ASCII comments, Biome formatting, 141-char dividers, no commits without instruction, `scripts/changelog.yaml` only during release.
- Docker is not available inside the dev container: `pnpm start`, container rebuilds, docker tests, and demo recording are host-side steps for the user.
- Container isolation is the product; nothing here may weaken the git-mode blocks, the non-root user, or the key-gating of the web interface.

## Success criteria

- Stage 1: totopo v4.0.0 releases with no audio code and no migration chain beyond the single v3.16 tidy-up, behaves exactly as v3.16 otherwise, and every remaining test passes.
- Stage 1: a v3 user with an old workspace gets one clear sentence telling them what to do, and nothing breaks silently.
- Stage 2: a user runs `npx chamba`, opens a session, and is working with an agent in the browser without reading any setup docs.
- Stage 2: an agent asked for a plan publishes it as a page; the user answers the page's questions; the agent reacts to the answers - all without leaving the browser tab.
- Stage 2: the chamba repo carries no totopo naming, no web-interface toggle, and no release baggage, runs side by side with totopo on the same host, and every test passes.
