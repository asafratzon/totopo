---
name: totopo-statusline
description: View, customize, or revert the Claude status line in a totopo container. Use when the user mentions the status line or the web interface's status strip, asks what their token count or model display means, wants to change colors or thresholds, or wants to restore the totopo default.
---

# totopo-statusline: Manage the Claude status line

This skill helps the user inspect, customize, or revert the Claude Code status line shipped with totopo.

**Important constants:**
- The totopo default script is baked into the image at `{{statusline_path}}` (read-only, root-owned).
- Claude reads its config from `~/.claude/settings.json` (`statusLine.command`).
- After any change, the user must **restart Claude** for the new status line to take effect.

## Step 0 - Check whether this session even shows a status line

Run `printenv TOTOPO_WEB_SESSION`. If it prints `1`, this session is reached through the totopo web interface, and it does **not** render a status line: the same four segments are drawn as a strip above the composer instead, from the snapshot the script writes on every prompt render.

Say so before anything else, because a change made here would be invisible to the user in this session:

> This session is in the web interface, so the numbers you see above the composer come from a strip the page draws, not from the status line. The status line script still runs (it writes the snapshot the strip reads), but it stops before rendering. Customizing it changes what a terminal session shows - `npx totopo` with the interface off, or `docker exec` into the container. The strip itself is part of the interface and is not customizable through this skill; it also leaves out the "open a new totopo session to update" hint, so the terminal line is where an ageing install shows up.

Then carry on with the steps below if they still want to change the terminal status line. Everything else in this skill applies unchanged - the script, the settings file, and where the default lives are the same either way.

**If the user says they can see a status line in the terminal above the composer, believe them and go straight to Step 1.** A web session that renders one is running a script without the `TOTOPO_WEB_SESSION` check - almost always a custom copy made before that check existed. Step 1 is where that is confirmed and fixed.

## Step 1 - Inspect current state

Read `~/.claude/settings.json` (treat a missing file or unparseable JSON as `{}`). Look at `.statusLine.command` and classify:

- **default-by-omit** - `statusLine` field is absent. totopo will inject the default on the next session start, but it is not active in the running session yet.
- **totopo-default** - `statusLine.command` equals `{{statusline_path}}`.
- **custom** - `statusLine.command` is any other value.

Tell the user which state they are in, and the exact command path if custom.

**If custom, check whether the fork has fallen behind before anything else.** totopo never overwrites a `statusLine` the user set, so a copy made before an upgrade keeps running for good - and the symptom is "the status line feature is broken", not "my copy is old". Compare the two:

```bash
diff "$(python3 -c 'import json,pathlib;print(json.load(open(pathlib.Path.home()/".claude/settings.json"))["statusLine"]["command"])')" {{statusline_path}}
```

No output means the fork is a byte-for-byte copy of the current default and can be replaced by it outright. Otherwise read the diff and say which side is missing what. Two differences matter more than cosmetics, because they are behaviour the default gained and a fork cannot have if it predates them:

- **No `TOTOPO_WEB_SESSION` check** - the fork renders the line in the web interface too, so a browser session shows the strip *and* a status line, saying everything twice. A user in a web session who can see a status line at all has a stale fork; that is the fastest way to spot one.
- **No `context_window_size` or `version` in the snapshot** - the strip drops the window size and the version, because it leaves out any field it has no value for.

Then offer to refresh it (see "Revert from custom to totopo default" in Step 4). Do not silently repoint at the default: the fork may hold changes the user wants.

## Step 2 - Explain the totopo default render pattern

Four segments, left to right, separated by a mid-dot. This is what a terminal session prints; the web interface's strip carries the same four numbers, but not the install-age hint in the fourth.

```
🤖 Opus 4.8 high · 🧠 174k / 1M (17%) · ⚡ ▓▓▓▓▓▓▓▓░░ 83% (🔌 2h 15m) · Claude Code v2.1.132
```

1. **Model** - display name as provided by Claude Code after the robot icon, with any trailing parenthetical (such as "(1M context)") trimmed, followed by reasoning effort in purple.
2. **Tokens** - current context-window usage after the brain icon: used tokens, then the window size and percentage in grey (e.g. "174k / 1M (17%)"). The size half is dropped if Claude Code does not report the window size.
3. **Rate-limit gauge** - an energy meter of the 5-hour window: bar and percentage show the share REMAINING, not used.
   Full and green when fresh; turns yellow at 50% left and red at 20% left as it drains.
   The countdown after the plug icon is the time until the window recharges.
   Hidden on free accounts and before the first API response.
4. **Claude Code** - installed CLI version, with a freshness hint shown only once the install starts to age.

Most of the line stays calm; individual segments turn **yellow** or **red** when something deserves attention - typically a nudge to *clear or compact the context*, *update the harness by opening a new totopo session*, or *watch the rate-limit window*.

## Step 3 - Ask the user what they want

Based on the current state:

**If default-by-omit:**
"Your status line will be the totopo default once the session restarts. Want to install it explicitly now, or customize before next session?"

**If totopo-default:**
"You are using the totopo default. Want to (1) keep it, (2) fork-and-edit a copy to tweak something, or (3) write a new one from scratch?"

**If custom:**
"You have a custom status line at `<command>`. Want to (1) keep it, (2) revert to the totopo default, or (3) modify further?"

## Step 4 - Apply the chosen action

### Permissions: you perform the edits

Every action in this step involves editing `~/.claude/settings.json` and/or writing scripts under `~/.claude/`. **You** make those edits directly with the `Edit` and `Write` tools - do not tell the user to run the change themselves.

If write access to those paths is not pre-approved, Claude Code will surface its standard permission prompt to the user. **That prompt is the expected approval flow, not a refusal signal** - go ahead and call the tool, and the user will grant permission when they see it.

Do not apologise for "lacking permission" and do not redirect the work back to the user. The only correct response to a custom-status-line revert request (or any other action below) is to attempt the edit yourself.

### Install the default explicitly

Edit `~/.claude/settings.json` so it contains:

```json
{
  "statusLine": {
    "type": "command",
    "command": "{{statusline_path}}"
  }
}
```

Preserve any other top-level fields the file already has. Tell the user to restart Claude.

### Revert from custom to totopo default

Same as install: set `statusLine.command` to `{{statusline_path}}`. Do not delete the user's custom script (it may be at a path like `~/.claude/statusline.sh`); just stop pointing at it. Mention to the user that the old script file is still on disk if they want to keep it for later.

This is also how a fork that has fallen behind is refreshed, when the diff in Step 1 showed nothing in it worth keeping. When there is something worth keeping, copy the current default to a fresh path and re-apply their changes onto it - that direction, not porting the default's changes into the old fork, where missing one is invisible until something does not work.

### Fork and edit (customize from the totopo default)

Never edit `{{statusline_path}}` directly - it is root-owned and read-only inside the container.

1. Copy the script to a writable location:
   ```bash
   cp {{statusline_path}} ~/.claude/statusline.sh
   chmod +x ~/.claude/statusline.sh
   ```
2. Ask the user what they want to change (colors, thresholds, segment order, what to show, what to hide).
3. Edit `~/.claude/statusline.sh` per their request.
4. Update `~/.claude/settings.json` so `statusLine.command` points to `~/.claude/statusline.sh`.
5. Tell the user to restart Claude, and say once that the copy is now theirs: totopo will not overwrite it, so it keeps running as-is when a later totopo version changes the default. Ask this skill again after an upgrade and Step 1 will say whether it has fallen behind.

### Write from scratch

If the user wants something completely different:

1. Confirm the spec with them - what segments, what colors, what data sources from the input JSON Claude pipes to the script.
2. Write a new script to `~/.claude/statusline-<descriptive-name>.sh`, `chmod +x` it.
3. Update `~/.claude/settings.json` to point at it.
4. Tell the user to restart Claude.

## Notes

- Always preserve other fields in `settings.json` when editing. The file may contain unrelated user settings.
- If `settings.json` does not exist or is unparseable, create it fresh as `{ "statusLine": { ... } }`.
- Any statusline changes must use only the fields documented in the official Claude Code statusline reference: https://code.claude.com/docs/en/statusline#available-data -- consult that page for the full list of available JSON fields, their types, nullability, and conditional presence.
