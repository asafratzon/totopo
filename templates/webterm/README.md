# webterm

A browser front-end for the interactive AI agents (`claude`, `opencode`, `codex`) running inside a totopo container.

It relays the real agent TUI over a PTY (not the Agent SDK, not headless mode), so it uses your subscription through the container's config dir (e.g. `~/.claude`) - no API key - and stays inside the totopo sandbox.
On top of the terminal it adds a rich composer so you can paste images, drop or upload attachments, and dictate - things the container terminal alone cannot do.

## How it works

- `server.js` serves the page, exposes `POST /upload`, and runs a WebSocket relay at `/ws`.
- The URL carries a key (`/?k=<key>`) and every route that carries the relay demands it. The server mints a new one at each start, so the key lives exactly as long as the process that issued it.
- `sessions.js` is the session registry: what a session is, who drives it, and what ends it. The PTY is injected, so the rules are unit-tested without `node-pty`.
- A session is one `node-pty` process running the agent in a directory inside `/workspace`. Sessions belong to the container, not to the browser.
- The page (`public/`) lists every live session as a tab, renders the attached one's TUI with xterm.js, and forwards keystrokes.
- The composer sends its message (text plus any image paths) as one bracketed paste, so a multi-line message is submitted once.
- Tab order is registry state (`reorder`), so a drag is a frame and the new bar comes back as an ordinary broadcast - a locally sorted bar would be undone by the next one. The bar holds still while a drag is in flight, because rebuilding it would replace the element being dragged and cancel the drag.
- Composer drafts are the client's, kept per session id in `sessionStorage` and swapped on every attach. The text, the `[Image #N]` tokens and the counter behind them move together: a token only means something next to the map that expands it, so one shared map would let `[Image #1]` in one session resolve to another session's file.
- Pasted/dropped/uploaded images are POSTed to the server, saved under `/tmp/uploads/`, and their in-container paths are injected into the message. The agent reads the images from those paths.
- When the relayed agent is `claude`, a short note (`context/claude.md`) is appended to its system prompt via `--append-system-prompt-file`, so it knows it is reached through the browser rather than a terminal. Only claude has this per-launch hook; the shared managed `CLAUDE.md` (which the terminal reads too) is untouched. `WEBTERM_CONTEXT_FILE` overrides the file.
- The page owns the clipboard, because a TUI can own the mouse. claude turns on mouse tracking, so xterm hands drags to the agent and has no selection of its own; the agent then pushes the selected text out with **OSC 52**, which the page decodes (base64 to UTF-8, not bare `atob`) and writes to the clipboard. A clipboard *read* request (`OSC 52` with `?`) is never answered, so nothing in the container can pull the host clipboard out through the relay. Where the terminal does own the selection, `Cmd+C` / `Ctrl+Shift+C` and the terminal's right-click menu copy it; `Ctrl+C` is always an interrupt.
- There is one clipboard - the machine's - and only a copy made in the window in front may write it. A replayed screen is the session's own past output, so it still contains the OSC 52 of any copy made in that session earlier: replays go through `writeReplay`, which makes the OSC 52 handler ignore them. Without that, every attach (a session switch, a reload, a reconnect after sleep) put that session's stale text back on the clipboard, so each session tab looked like it carried a clipboard of its own. An unfocused window does not write either - its text waits for the copy shortcut rather than replacing what was copied in another app.
- When this window cannot do anything at all, one curtain covers the whole page and says why - the container is gone, this URL's key is spent, or the container is being stopped. Stopping is the one that is a wait rather than a report, so it shows as one (dots, and no advice about a container that has not gone yet) and the closing socket turns it into "the container is stopped" - nothing else takes the relay down at that moment, and a wait left up for good is indistinguishable from a page that hung. It replaces disabling each control on its own, which is what used to leave a dead page looking alive: tabs that still hovered, and an X that opened an end-session prompt nothing would answer. A dropped socket makes the page inert at once but waits 3s before drawing the curtain, so a sleeping laptop or a wifi blip heals without one appearing.
- Clicking in the session bar blurs the terminal (a tab is a plain div; `+ New session` is a button), and a blurred terminal receives neither keystrokes nor `Cmd+V`, so a tab click and every attach hand focus back to it. The composer, a rename editor and an open card keep focus.

## Sessions

The page is mission control for the container: the tab bar at the top is every agent session running in it, however long ago you started it.

- **Nothing is ended for you.** A closed browser, dropped wifi and a slept laptop are indistinguishable from the server, so none of them ends a session. Close the lid on an unanswered question, open it a day later, and the question is still there. A session ends only when you close it, when the agent exits on its own, or when the container stops.
- **A session is picked up, not recreated.** Reconnecting replays the session's screen and carries on. Open the same URL in another browser and every session is listed there too.
- **Closing the session you are in lands you on its neighbour** - the tab to its right, else the one to its left - rather than on a dead screen. Closing a session you were not in leaves you where you are. When every session that is left is open in another window, nothing is taken from it: this window says so instead of leaving the closed session's screen up looking live.
- **Rename a tab** by double-clicking its name, so a long-lived conversation reads by what it is about instead of `Agent 3`. The name shows in every window and clearing it brings the default number back. Names last as long as the session; nothing is saved to disk.
- **Drag a tab to reorder the bar.** The order is the registry's, not the window's, so it moves in every window at once, and the number in `Agent 3` stays with the session rather than with the position. Mouse and trackpad only - this is the browser's own drag and drop, which touch does not fire.
- **The composer belongs to the session you are in.** A half-written message stays with its conversation: switch tabs and the box holds the next session's draft, switch back and yours is as you left it, image attachments included. Ending a session throws its draft away with it. Drafts are per browser window - they survive a switch, a reload and a sleep, but they do not follow a session into another window, and nothing is saved to disk.
- **Shift+Enter is a newline in both boxes.** It always was in the composer; in the terminal above it, Shift+Enter now sends the same ESC-then-Return that Alt+Enter does, which is what the agents read as "a newline, not send". A terminal has no Shift+Enter of its own - Enter is a carriage return whatever else is held - so this is a second key onto a sequence the agent already understands. Alt+Enter still works.
- **Up recalls what you already sent.** From an empty composer, Up brings back the last message sent to that session and keeps stepping back; Down comes forward, and past the newest is the empty box you started from. Once a message is showing the arrows only step on from its first and last line, so they still move the caret around a long one, and typing anything ends the walk. What is stored is what the agent actually received, image tokens already expanded, so sending a recalled message again means the same thing. History is per session and per browser window, it holds what went through the composer rather than what was typed straight into the terminal, and it goes when the session does.
- **One window drives a session at a time**, because a PTY has one size and two drivers would fight over it. Opening a session another window is watching offers to switch it to this one; the window that loses it can take it back.
- **Opening the URL always lands you somewhere:** the session you were last looking at, or - when nothing is running - one freshly started session, which is what resumes the most recent conversation.
  Reconnecting is not the same as opening, and starts nothing: a wifi blip or a slept laptop puts you back on exactly what you left, an empty bar included.
- **A session starts where you did, and stays there.** `+ New session` opens the agent in the directory `npx totopo` ran in, the same directory a terminal session lands in - so `npx totopo` inside `apps/api` gets you an agent working on `apps/api`.
  The folder button beside it starts one somewhere else: type a directory relative to the workspace root or pick it from the list, and the tab says where that session is running.
  The directory belongs to the session for its whole life, so several sessions can work in different parts of the workspace at once.
  A path has to name a directory that exists inside the workspace, or nothing is started - the container is the sandbox boundary either way, this is what keeps the picker honest.
- **Up to 8 sessions** (`WEBTERM_MAX_SESSIONS`). The limit is memory: each one is a full agent process.
- **Call it a day with the power button** at the right of the bar: it stops the container, and with it every session in it - browser and terminal alike. It always asks first, naming what ends. The container stops itself by signalling PID 1, which only works because totopo gives the keep-alive a TERM trap; a container created before that says so instead of hanging, and points at the host.

## What the tabs are telling you

Whether an agent is working is read off the rhythm of its output - a sustained stretch means working, going quiet means it stopped - so it is the same for every agent and does not depend on reading anyone's TUI.
Going quiet is not the end of a turn on its own, though: an agent pauses mid-turn (a slow first token, a tool that prints nothing while it runs) and carries straight on.
So the light goes out with the output, but the stop has to hold for a few seconds before anything says the agent finished - and work that resumes is never reported as finished at all.
That is why a session showing as working never also shows as waiting for you.

- **A light travels round a tab** while that session's agent is working.
- **A tab flashes and then stays lit** when its agent finishes something you were not there to see. Visiting the tab is what spends it.
- **The browser tab speaks too**, because that is all a window behind something else can do. The title counts the sessions waiting for you, and the favicon carries one mark: a blue bar down its right edge while an agent is working, and a green dot in its corner - pulsing until you go and look - when one is waiting. Two shapes in two places rather than two colours in one, because at 16px a hue is the first thing to go.
- **And twenty seconds later it says so out loud** - one soft chime, once, for an alert still standing and still unseen. That hold is on top of the settle above, because a light that is briefly wrong costs nothing and a sound that is wrong costs your attention: coming back, or the agent carrying on, means it is never heard at all. The only alert it stays quiet for is the session already on screen in front of you - another tab of this bar finishing still chimes, window focused or not, since its light is off to the side of whatever you are reading. Several sessions finishing together are one chime, and so are two windows open on the same container. The bell beside the power button mutes it, and remembers.

"Not there to see it" means the window is not in front of you: behind another browser tab, or behind another app.
A session you are looking at never lights up, since that would only tell you what you can already see.

`GET /dirs?k=<key>` answers with the default directory and the ones the picker suggests: `{"default":"apps/api","dirs":["apps","apps/api",...],"truncated":false}`.
The walk is bounded (3 levels deep, 400 entries, no dot directories and no `node_modules`), and says when the list is partial - anything deeper can still be typed in.

`POST /cwd?k=<key>` with `{"cwd":"/workspace/apps/api"}` moves where new sessions start.
totopo calls it at every session start that finds the interface already running: the launcher only passes the directory once per container start, so without this the browser would keep opening sessions in the directory of whichever session first started the container.
Existing sessions are untouched - a session's directory never changes under it.

`GET /status?k=<key>` reports the relayed agent, how many sessions are alive, and how many of them a browser is watching: `{"agent":"claude","sessions":2,"attached":1}`.
totopo asks it when the last terminal session closes, so `exit` in the terminal warns before it stops a container with live browser sessions in it.
A window whose socket dropped asks it too: an answer means the relay is fine, a `403` means this window's key is spent, and no answer at all means the container is gone - three different things to say, and this is what tells them apart.

## Run

webterm is baked into the totopo image with its dependencies preinstalled, and is off by default.

1. On the host, enable it: `npx totopo` > Settings > Web interface.
   Every workspace gets its own sticky host port from the configured range (default `3900-3999`), stored host-side and never in `totopo.yaml`.
   A port that cannot be used moves the workspace to the next free one in the range, and it stays there.
2. Open a session. The greeting shows either the live URL (when auto-start is on) or a hint to run `webterm <agent>`.
3. In the container, run `webterm <agent>` (`claude`, `opencode`, or `codex`) to start the server and print the URL, e.g. `http://localhost:3900/?k=9f2c41ae8b...`.
   The agent is always explicit; `webterm` on its own prints usage and the URL, and never picks an agent for you.
   The server starts in the background: you get the prompt back, and it keeps running after that shell closes.
   Open that URL as printed - the key on the end is what the relay checks, and it changes every time the server starts.

When the auto-start setting is on and the web interface is enabled, totopo starts the server automatically on every container start, fronting the chosen agent.
The first session after a container start resumes the most recent conversation; later sessions start fresh.

One server relays **one agent**. Running `webterm <other-agent>` while it is up reports the agent that is live and prints the command that switches - switching stops the server, which ends every session open in the browser.

## Security

- The server binds container port **3899**; totopo publishes it loopback-only (`127.0.0.1:<port>:3899`), so nothing on the LAN can reach it.
  That container port is reserved: a `totopo.yaml` entry publishing it is rejected, so nothing else can front the web URL.
- Inside the container it listens on all interfaces - required for a published port to reach it. So any process on the host, and any container on the same Docker network, can open the port. Reaching the port is not the same as getting in: the key is.
- **The URL carries a key, and the relay refuses anything without it.** A new one (16 random bytes, hex) is minted at every server start and published to `/tmp/webterm.key` the moment the port is bound; the launcher and the container greeting read it back, which is how the printed URL is always the live one. Gated: the page itself, `POST /upload`, `GET /status`, and the WebSocket handshake. Not gated: `app.js`, the stylesheet, the icon and the xterm files under `/vendor` - they hold nothing secret and drive nothing, and a window that never got the page opens no socket.
- The key stays in the URL rather than in a cookie on purpose. Cookies on `localhost` are shared across ports, so a page served by any other local port could ride this workspace's; a key in the URL is scoped to the window that was handed it.
- Comparison is constant time, so a caller cannot learn the key one character at a time from how long a refusal takes.
- The WebSocket handshake also rejects any non-loopback `Origin`, checked alongside the key. On its own that is a browser-behavior gate - a non-browser client sets any Origin it likes - so it is the second lock, not the first.
- A key dies with the server that issued it. Restarting the interface (or the container) invalidates every open window, which is why a spent URL gets a page that says where the current one is rather than a silent refusal.
- Uploads are images only, size-capped, and written only under `/tmp/uploads/`.
- Runs as the non-root `devuser`; the agent inherits the same sandbox and auth it has in the terminal.

## Cleanup

`/tmp/uploads/` is swept on startup and once a week: files older than 7 days are deleted, and only files strictly inside `/tmp/uploads/` are ever touched.

## Config

`config.js` holds the knobs (port, key and key file, upload dir, size cap, sweep age/interval, paste framing, resume marker, state file, session limit, keepalive interval, stop timings, claude context file, workspace root and directory-scan limits).
Env overrides: `WEBTERM_PORT`, `WEBTERM_CWD`, `WEBTERM_AGENT`, `WEBTERM_AGENT_ARGS`, `WEBTERM_KEY`, `WEBTERM_KEY_FILE`, `WEBTERM_RESUME_MARKER`, `WEBTERM_STATE_FILE`, `WEBTERM_MAX_SESSIONS`, `WEBTERM_PING_INTERVAL_MS`, `WEBTERM_WORKSPACE`, `WEBTERM_CONTEXT_FILE`.
`WEBTERM_KEY` pins the key instead of minting one, which is for tests and hand-run debugging - there is no way to turn the gate off.
`WEBTERM_CWD` is where new sessions start, not where they must stay: the browser can name another directory per session, and `POST /cwd` moves the default.
The `webterm` launcher on PATH sets these from the container's totopo-injected environment, and falls back to its own `$PWD` for the session directory - so a hand-run `webterm claude` starts sessions where that shell is.
