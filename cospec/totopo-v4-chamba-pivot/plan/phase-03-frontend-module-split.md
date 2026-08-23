# Phase 03 - Webterm frontend module split

Status: done

Covers FR-23.
`templates/webterm/public/app.js` is 2633 lines in one file, and stage 2 lands two new features in it (the web pane and the status strip).
This phase splits it into ES modules with no behavior change, so those features have somewhere to go.

## Shape

The modules live in `templates/webterm/public/app/`, and `index.html` loads `app/main.js` as a module.
`express.static` already serves the whole `public/` tree, and the image bakes the whole `webterm/` directory, so a subdirectory needs no plumbing.

One rule holds the graph together and is written into `main.js`: a module defines things and hooks up its own listeners at import time, and never calls into another module while the page is loading.
The graph has cycles - the frame router talks to every feature and every feature answers back - and a module that ran another module's code at import time would find it half-built.
Everything with an order to it happens in `main.js`.

Shared mutable state stays assignable in exactly one module and is read everywhere else as an imported live binding, so every read site reads the way it did before the split.

## Tasks

- [x] `app/state.js` - what the server last told this window (`sessions`, `attachedSid`, `maxSessions`, `defaultAgent`, `agents`, `workspaceName`, `defaultCwd`), the URL key, `labelOf`; written only by `adoptSessionsFrame` and `setAttachedSid`
- [x] `app/dom.js` - the page's controls, and the SVG namespace the drawn icons need
- [x] `app/theme.js` - the palette, the workspace's slot in it, and the session colours
- [x] `app/note.js` - the status pill over the terminal
- [x] `app/terminal.js` - the terminal, the fit, the repaint, focus, raw keystrokes, and the resize observer
- [x] `app/tabs.js` - the session bar: ages, the two animations that outlive a render, renaming, a tab, reordering, the power button, `renderBar`
- [x] `app/new-session.js` - the panel behind the chevron that asks which agent and which directory
- [x] `app/alerts.js` - the browser tab (title and drawn favicon) and the chime, with the bell
- [x] `app/cards.js` - the overlay cards
- [x] `app/connection.js` - the socket, the reconnect loop, the curtain, and telling the server the user is here
- [x] `app/frames.js` - the frame router, `applySessions`, and the message a dead screen is replaced with
- [x] `app/composer.js` - the box: placeholder and border state, growth, image tokens, upload, send, keys
- [x] `app/drafts.js` - the two per-session stores this window keeps: the unsent message and what was already sent
- [x] `app/clipboard.js` - copy and paste, the OSC 52 handler, and the replay gate
- [x] `app/dictation.js` - the microphone button
- [x] `app/main.js` - the header that explains the whole page, and the boot order
- [x] Delete `public/app.js`; point `index.html` at `/app/main.js` with `type="module"`
- [x] Add `readWebtermClient()` to `tests/helpers.ts` - the client's source, all modules concatenated - and repoint every drift test in `tests/webterm.test.ts` and `tests/webterm-sessions.test.ts` at it
- [x] Update the comments that name `app.js`: `styles.css` (three), `index.html`, `templates/webterm/README.md` (the ungated-assets line and the `public/` line), and the `dockerfile-builder` drift fixture

## Verify

- `pnpm lint:fix` then `pnpm check` green, with every webterm drift test still asserting the same thing
- No module is over 600 lines, and `public/app.js` is gone
- Read through against the old file: every behavior the plan names is still wired - the tab busy trace and the finished glow, the browser-tab count and the favicon working bar / waiting dot, the chime and its mute, per-session drafts, sent-message history, OSC 52 clipboard, dictation
- No module reads or calls another module's exports at import time (only definitions and its own DOM listeners), so the cycles in the graph cannot bite
- Behavior in a real browser is a host step for the user at the stage-1 checkpoint - Docker is not available in the container

## Notes

Sixteen modules, none over 600 lines: `alerts.js` 480, `tabs.js` 475, `connection.js` 337, `drafts.js` 244, `clipboard.js` 229, `composer.js` 226, `new-session.js` 188, `frames.js` 145, `cards.js` 123, `terminal.js` 102, `dictation.js` 98, `main.js` 57, `state.js` 47, `theme.js` 46, `note.js` 24, `dom.js` 20.

Design calls made while splitting:

- The curtain and the socket went into one module. They are the same subject from two ends: the curtain is what the page shows about the connection, and splitting them would have left two modules calling each other constantly.
- Shared state is an `export let` live binding with a single owning module and small setters (`adoptSessionsFrame`, `setAttachedSid`, `setImageCounter`). Read sites did not change at all, which is also why almost every source-text drift test survived the split unedited.
- Two boot functions carry everything with an order to it: `mountTerminal()` opens the terminal and fits it, and `installClipboard()` registers the OSC 52 handler and the key handler. Registering those at import time was the one real hazard in the graph - `clipboard.js` would have read `term` from `terminal.js` before it was assigned, through the cycle terminal -> connection -> frames -> clipboard. Deferring them to `main.js` removes it, and the "nothing calls into another module at import time" rule keeps it removed.
- `alerts.js` gained one seam it did not need before: `forgetChime(sid)`, so `tabs.js` can clear a session's chime when it arrives without reaching into the chime's own set.
- The drift tests read `readWebtermClient()` - every module concatenated in filename order - so a test pins what the page does, not which file a function sits in. One of them, the OSC 52 handler test, passed for the wrong reason after the move: its lazy `[\s\S]*?` ran out of `clipboard.js` and matched a `});` in the next file. Tightened to require the handler's own four-space closer.
- Browser behavior was checked with a throwaway DOM/Terminal/WebSocket stub outside the repo, driving real frames through the loaded modules: tab states, the trace layer, the arrival flash, the title count, the bell, replay, send, paste, history recall, tab click, the close card, the idle message, the OSC handler, Shift+Enter, and a raw keystroke. It is not a substitute for a real browser, which stays a host step.
