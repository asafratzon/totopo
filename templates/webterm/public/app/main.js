// main.js - xterm.js terminal, the session bar, and the rich composer, all over one WebSocket.
//
// The session bar is mission control for this container: every live agent is a tab, this window drives
// one of them at a time, and none of them ends because a window closed or a laptop slept. Tabs are dragged
// to reorder them, and the order is the registry's, so every window agrees on it. A tab also says what its
// session is doing without being opened: a light travels round it while the agent works, and it holds lit
// until visited when an agent finished something nobody was there to see - which the page title and the
// favicon repeat, for when the whole window is behind something else. The terminal renders the
// attached session's live TUI and forwards raw keystrokes and resizes. The composer handles typing, image
// paste/drop/upload, and dictation, and what is in it belongs to the attached session: switching tabs swaps
// the draft, and ending a session throws its draft away. Pasted images are uploaded and their container
// paths are inserted inline, so what you see in the box is what is sent; on Send the whole composer text
// goes as one {t:"paste"} frame the server wraps as a bracketed paste.
//
// Everything here rides on the key this window was handed in its URL: the socket, the uploads and the
// status probe all carry it, and without a valid one the page is never served in the first place.
//
// The page is plain ES modules with no build step, one per subject:
//
//   state.js        what the server last told this window, and the URL's key
//   dom.js          the elements index.html ships with
//   theme.js        the palette, this workspace's colour, and the session colours
//   note.js         the status pill over the terminal
//   terminal.js     the terminal, its size, and the keystrokes that go straight to the PTY
//   tabs.js         the session bar, its two animations, renaming, and reordering
//   new-session.js  the panel behind the chevron: which agent, and which directory
//   alerts.js       the browser tab (title and drawn favicon), and the chime
//   cards.js        the overlay cards
//   connection.js   the socket, the reconnect loop, and the curtain
//   frames.js       what to do with each frame the server sends
//   composer.js     the box, its images, and Send
//   drafts.js       per-session unsent messages, and what was already sent
//   clipboard.js    copy and paste, OSC 52, and the replay gate
//   dictation.js    the microphone button
//
// One rule holds them together: a module defines things and hooks up its own listeners when it is loaded, and
// never calls into another module while the page is still loading. The graph has cycles on purpose - the frame
// router talks to every feature and every feature answers back - so a module that ran another module's code at
// load time would be reaching into something half-built. Everything with an order to it happens here.
//
// Reading at load time follows from the same thing: a module may read from one that imports nothing itself
// (dom.js, state.js, theme.js), since a leaf is always finished by the time anything else runs, and never from
// one inside the cycle, whose values may not exist yet.
//
// Every module is imported here, including the ones this file has nothing to call. Several exist for what they
// do when they load - the microphone button, the chevron panel's Escape key, the workspace colour, the draft
// that is saved when the page goes away - and reaching them only through whoever happens to import a function
// from them would let an unrelated edit take a feature off the page with no test to notice. A test walks the
// imports from this file and fails if a module is not reachable.

import { refreshBrowserTab } from "./alerts.js";
import { installClipboard } from "./clipboard.js";
import { refreshComposer } from "./composer.js";
import { connect } from "./connection.js";
import "./cards.js";
import "./dictation.js";
import "./dom.js";
import "./drafts.js";
import "./frames.js";
import "./new-session.js";
import "./note.js";
import "./state.js";
import "./theme.js";
import { renderBar } from "./tabs.js";
import { mountTerminal, term } from "./terminal.js";

// --- Go ----------------------------------------------------------------------------------------------------------------------------------

mountTerminal();
installClipboard();
refreshComposer();
renderBar();
// Before the first frame arrives, so the icon carries this workspace's frame from the moment the page loads.
refreshBrowserTab();
connect();
term.focus();
