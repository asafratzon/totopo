# webterm

A browser front-end for the interactive AI agents (`claude`, `opencode`, `codex`) running inside a totopo container.

It relays the real agent TUI over a PTY (not the Agent SDK, not headless mode), so it uses your subscription through the container's config dir (e.g. `~/.claude`) - no API key - and stays inside the totopo sandbox.
On top of the terminal it adds a rich composer so you can paste images, drop or upload attachments, and dictate - things the container terminal alone cannot do.

## How it works

- `server.js` serves the page, exposes `POST /upload`, and runs a WebSocket relay at `/ws`.
- `sessions.js` is the session registry: what a session is, who drives it, and what ends it. The PTY is injected, so the rules are unit-tested without `node-pty`.
- A session is one `node-pty` process running the agent in `/workspace`. Sessions belong to the container, not to the browser.
- The page (`public/`) lists every live session as a tab, renders the attached one's TUI with xterm.js, and forwards keystrokes.
- The composer sends its message (text plus any image paths) as one bracketed paste, so a multi-line message is submitted once.
- Tab order is registry state (`reorder`), so a drag is a frame and the new bar comes back as an ordinary broadcast - a locally sorted bar would be undone by the next one. The bar holds still while a drag is in flight, because rebuilding it would replace the element being dragged and cancel the drag.
- Composer drafts are the client's, kept per session id in `sessionStorage` and swapped on every attach. The text, the `[Image #N]` tokens and the counter behind them move together: a token only means something next to the map that expands it, so one shared map would let `[Image #1]` in one session resolve to another session's file.
- Pasted/dropped/uploaded images are POSTed to the server, saved under `/tmp/uploads/`, and their in-container paths are injected into the message. The agent reads the images from those paths.
- When the relayed agent is `claude`, a short note (`context/claude.md`) is appended to its system prompt via `--append-system-prompt-file`, so it knows it is reached through the browser rather than a terminal. Only claude has this per-launch hook; the shared managed `CLAUDE.md` (which the terminal reads too) is untouched. `WEBTERM_CONTEXT_FILE` overrides the file.
- The page owns the clipboard, because a TUI can own the mouse. claude turns on mouse tracking, so xterm hands drags to the agent and has no selection of its own; the agent then pushes the selected text out with **OSC 52**, which the page decodes (base64 to UTF-8, not bare `atob`) and writes to the clipboard. A clipboard *read* request (`OSC 52` with `?`) is never answered, so nothing in the container can pull the host clipboard out through the relay. Where the terminal does own the selection, `Cmd+C` / `Ctrl+Shift+C` and the terminal's right-click menu copy it; `Ctrl+C` is always an interrupt.
- There is one clipboard - the machine's - and only a copy made in the window in front may write it. A replayed screen is the session's own past output, so it still contains the OSC 52 of any copy made in that session earlier: replays go through `writeReplay`, which makes the OSC 52 handler ignore them. Without that, every attach (a session switch, a reload, a reconnect after sleep) put that session's stale text back on the clipboard, so each session tab looked like it carried a clipboard of its own. An unfocused window does not write either - its text waits for the copy shortcut rather than replacing what was copied in another app.
- Clicking in the session bar blurs the terminal (a tab is a plain div; `+ New session` is a button), and a blurred terminal receives neither keystrokes nor `Cmd+V`, so a tab click and every attach hand focus back to it. The composer, a rename editor and an open card keep focus.

## Sessions

The page is mission control for the container: the tab bar at the top is every agent session running in it, however long ago you started it.

- **Nothing is ended for you.** A closed browser, dropped wifi and a slept laptop are indistinguishable from the server, so none of them ends a session. Close the lid on an unanswered question, open it a day later, and the question is still there. A session ends only when you close it, when the agent exits on its own, or when the container stops.
- **A session is picked up, not recreated.** Reconnecting replays the session's screen and carries on. Open the same URL in another browser and every session is listed there too.
- **Closing the session you are in lands you on its neighbour** - the tab to its right, else the one to its left - rather than on a dead screen. Closing a session you were not in leaves you where you are. When every session that is left is open in another window, nothing is taken from it: this window says so instead of leaving the closed session's screen up looking live.
- **Rename a tab** by double-clicking its name, so a long-lived conversation reads by what it is about instead of `Agent 3`. The name shows in every window and clearing it brings the default number back. Names last as long as the session; nothing is saved to disk.
- **Drag a tab to reorder the bar.** The order is the registry's, not the window's, so it moves in every window at once, and the number in `Agent 3` stays with the session rather than with the position. Mouse and trackpad only - this is the browser's own drag and drop, which touch does not fire.
- **The composer belongs to the session you are in.** A half-written message stays with its conversation: switch tabs and the box holds the next session's draft, switch back and yours is as you left it, image attachments included. Ending a session throws its draft away with it. Drafts are per browser window - they survive a switch, a reload and a sleep, but they do not follow a session into another window, and nothing is saved to disk.
- **One window drives a session at a time**, because a PTY has one size and two drivers would fight over it. Opening a session another window is watching offers to switch it to this one; the window that loses it can take it back.
- **Opening the URL always lands you somewhere:** the session you were last looking at, or - when nothing is running - one freshly started session, which is what resumes the most recent conversation.
- **Up to 8 sessions** (`WEBTERM_MAX_SESSIONS`). The limit is memory: each one is a full agent process.

## What the tabs are telling you

Whether an agent is working is read off the rhythm of its output - a sustained stretch means working, going quiet means it stopped - so it is the same for every agent and does not depend on reading anyone's TUI.

- **A light travels round a tab** while that session's agent is working.
- **A tab flashes and then stays lit** when its agent finishes something you were not there to see. Visiting the tab is what spends it.
- **The browser tab speaks too**, because that is all a window behind something else can do. The title counts the sessions waiting for you, and the favicon carries one mark: a blue bar down its right edge while an agent is working, and a green dot in its corner - pulsing until you go and look - when one is waiting. Two shapes in two places rather than two colours in one, because at 16px a hue is the first thing to go.

"Not there to see it" means the window is not in front of you: behind another browser tab, or behind another app.
A session you are looking at never lights up, since that would only tell you what you can already see.

`GET /status` reports the relayed agent, how many sessions are alive, and how many of them a browser is watching: `{"agent":"claude","sessions":2,"attached":1}`.
totopo asks it when the last terminal session closes, so `exit` in the terminal warns before it stops a container with live browser sessions in it.

## Run

webterm is baked into the totopo image with its dependencies preinstalled, and is off by default.

1. On the host, enable it: `npx totopo` > Settings > Web interface.
   Every workspace gets its own sticky host port from the configured range (default `3900-3999`), stored host-side and never in `totopo.yaml`.
   A port that cannot be used moves the workspace to the next free one in the range, and it stays there.
2. Open a session. The greeting shows either the live URL (when auto-start is on) or a hint to run `webterm <agent>`.
3. In the container, run `webterm <agent>` (`claude`, `opencode`, or `codex`) to start the server and print the URL, e.g. `http://localhost:3900`.
   The agent is always explicit; `webterm` on its own prints usage and the URL, and never picks an agent for you.
   The server starts in the background: you get the prompt back, and it keeps running after that shell closes.

When the auto-start setting is on and the web interface is enabled, totopo starts the server automatically on every container start, fronting the chosen agent.
The first session after a container start resumes the most recent conversation; later sessions start fresh.

One server relays **one agent**. Running `webterm <other-agent>` while it is up reports the agent that is live and prints the command that switches - switching stops the server, which ends every session open in the browser.

## Security

- The server binds container port **3899**; totopo publishes it loopback-only (`127.0.0.1:<port>:3899`), so nothing on the LAN can reach it.
  That container port is reserved: a `totopo.yaml` entry publishing it is rejected, so nothing else can front the web URL.
- Inside the container it listens on all interfaces - required for a published port to reach it. So any process on the host, and any container on the same Docker network, can open the port.
- The WebSocket handshake rejects any non-loopback `Origin`. That stops a remote page from scripting the relay, but it is a browser-behavior gate: a non-browser client sets any Origin it likes. There is no token yet (see the repo BACKLOG), so the relay trusts whatever can reach the port.
- Uploads are images only, size-capped, and written only under `/tmp/uploads/`.
- Runs as the non-root `devuser`; the agent inherits the same sandbox and auth it has in the terminal.

## Cleanup

`/tmp/uploads/` is swept on startup and once a week: files older than 7 days are deleted, and only files strictly inside `/tmp/uploads/` are ever touched.

## Config

`config.js` holds the knobs (port, upload dir, size cap, sweep age/interval, paste framing, resume marker, state file, session limit, keepalive interval, claude context file).
Env overrides: `WEBTERM_PORT`, `WEBTERM_CWD`, `WEBTERM_AGENT`, `WEBTERM_AGENT_ARGS`, `WEBTERM_RESUME_MARKER`, `WEBTERM_STATE_FILE`, `WEBTERM_MAX_SESSIONS`, `WEBTERM_PING_INTERVAL_MS`, `WEBTERM_WORKSPACE`, `WEBTERM_CONTEXT_FILE`.
The `webterm` launcher on PATH sets these from the container's totopo-injected environment.
