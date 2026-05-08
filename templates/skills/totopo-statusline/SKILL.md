---
name: totopo-statusline
description: View, customize, or revert the Claude status line in a totopo container. Use when the user mentions the status line, asks what their token count or model display means, wants to change colors or thresholds, or wants to restore the totopo default.
---

# totopo-statusline: Manage the Claude status line

This skill helps the user inspect, customize, or revert the Claude Code status line shipped with totopo.

**Important constants:**
- The totopo default script is baked into the image at `{{statusline_path}}` (read-only, root-owned).
- Claude reads its config from `~/.claude/settings.json` (`statusLine.command`).
- After any change, the user must **restart Claude** for the new status line to take effect.

## Step 1 - Inspect current state

Read `~/.claude/settings.json` (treat a missing file or unparseable JSON as `{}`). Look at `.statusLine.command` and classify:

- **default-by-omit** - `statusLine` field is absent. totopo will inject the default on the next session start, but it is not active in the running session yet.
- **totopo-default** - `statusLine.command` equals `{{statusline_path}}`.
- **custom** - `statusLine.command` is any other value.

Tell the user which state they are in, and the exact command path if custom.

## Step 2 - Explain the totopo default render pattern

Four segments, left to right, separated by a mid-dot:

```
174k / 1M (17%) · Opus 4.7 high · Claude Code v2.1.132 · ▓░░░░░░░░░ (12% used, resets in 3 hr 35 min)
```

1. **Tokens** - current context-window usage (count / window size / percentage).
2. **Model** - name and reasoning effort.
3. **Claude Code** - installed CLI version, with a freshness hint shown only once the install starts to age.
4. **Rate-limit gauge** - share of the 5-hour window used and time until it resets. Hidden on free accounts and before the first API response.

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
5. Tell the user to restart Claude.

### Write from scratch

If the user wants something completely different:

1. Confirm the spec with them - what segments, what colors, what data sources from the input JSON Claude pipes to the script.
2. Write a new script to `~/.claude/statusline-<descriptive-name>.sh`, `chmod +x` it.
3. Update `~/.claude/settings.json` to point at it.
4. Tell the user to restart Claude.

## Notes

- Always preserve other fields in `settings.json` when editing. The file may contain unrelated user settings.
- If `settings.json` does not exist or is unparseable, create it fresh as `{ "statusLine": { ... } }`.
- The format Claude Code passes via stdin includes `workspace.current_dir`, `model.display_name`, `context_window.used_percentage`, and `context_window.current_usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. Use these as the data sources for any custom script.
